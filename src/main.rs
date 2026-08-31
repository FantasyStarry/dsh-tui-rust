//! dsh-tui-rust — Phase 0 spike
//!
//! Minimal ACP (Agent Client Protocol v1) client that spawns `dsh --profile acp`
//! as a child process and drives one session end to end over newline-delimited
//! JSON-RPC stdio:
//!
//!   initialize -> session/new -> session/prompt -> (stream session/update)
//!   -> stopReason -> session/close -> stdin EOF shutdown
//!
//! The Node.js DeepSeek Harness core is never modified; this binary is a pure
//! protocol client. Run: `cargo run -- "your task"` (optional; default task).

use std::collections::HashMap;
use std::io::Write as _;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex, oneshot};

// ---------------------------------------------------------------------------
// JSON-RPC connection: one writer task + one reader task + pending-response map
// ---------------------------------------------------------------------------

struct Conn {
    tx: mpsc::UnboundedSender<Value>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    next_id: u64,
}

impl Conn {
    async fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        let (rtx, rrx) = oneshot::channel();
        self.pending.lock().await.insert(id, rtx);

        self.tx
            .send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .context("writer task is gone (dsh died?)")?;

        let resp = match tokio::time::timeout(timeout, rrx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => bail!("{method}: response channel dropped"),
            Err(_) => bail!("{method}: timed out after {timeout:?}"),
        };
        if let Some(err) = resp.get("error") {
            bail!("{method} failed: {err}");
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn respond(&self, id: Value, result: Value) {
        let _ = self.tx.send(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    async fn respond_error(&self, id: Value, code: i64, message: &str) {
        let _ = self.tx.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": code, "message": message}
        }));
    }
}

// ---------------------------------------------------------------------------
// Output helpers (plain text, no ANSI — safe on every Windows console)
// ---------------------------------------------------------------------------

fn print_flush(s: &str) {
    let mut out = std::io::stdout();
    let _ = out.write_all(s.as_bytes());
    let _ = out.flush();
}

/// Extract concatenated text from an ACP content block or block array.
fn content_text(c: Option<&Value>) -> String {
    match c {
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        Some(block) => block
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        None => String::new(),
    }
}

fn print_update(update: &Value) {
    let kind = update
        .get("sessionUpdate")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    match kind {
        "agent_message_chunk" | "agent_message" => {
            let t = content_text(update.get("content"));
            if !t.is_empty() {
                print_flush(&t);
            }
        }
        "agent_thought_chunk" => {
            let t = content_text(update.get("content"));
            if !t.is_empty() {
                print_flush(&format!("[thought] {t}"));
            }
        }
        "tool_call" => {
            let title = update.get("title").and_then(|v| v.as_str()).unwrap_or("?");
            let kind = update.get("kind").and_then(|v| v.as_str()).unwrap_or("?");
            println!("\r\n[tool {kind}] {title}");
        }
        "tool_call_update" => {
            let title = update.get("title").and_then(|v| v.as_str()).unwrap_or("?");
            let status = update.get("status").and_then(|v| v.as_str()).unwrap_or("?");
            println!("\r\n[tool {status}] {title}");
        }
        other => {
            let compact = update.to_string();
            let shown = if compact.len() > 160 {
                format!("{}…", &compact[..160])
            } else {
                compact
            };
            println!("\r\n[update:{other}] {shown}");
        }
    }
}

// ---------------------------------------------------------------------------
// Agent-initiated requests: auto-answer permission prompts, reject the rest
// ---------------------------------------------------------------------------

async fn handle_server_request(conn: &Conn, id: Value, method: &str, params: &Value) {
    match method {
        "session/request_permission" => {
            let tool = params
                .pointer("/toolCall/title")
                .and_then(|v| v.as_str())
                .unwrap_or("unnamed tool call");
            let options = params
                .get("options")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let chosen = options
                .iter()
                .find(|o| o.get("kind").and_then(|k| k.as_str()) == Some("allow_once"))
                .or_else(|| options.first());
            match chosen.and_then(|o| o.get("optionId").cloned()) {
                Some(option_id) => {
                    println!("\r\n[permission] auto-allowed: {tool}");
                    conn.respond(id, json!({"outcome": {"outcome": "selected", "optionId": option_id}}))
                        .await;
                }
                None => {
                    println!("\r\n[permission] no options offered, rejecting: {tool}");
                    conn.respond(id, json!({"outcome": {"outcome": "cancelled"}}))
                        .await;
                }
            }
        }
        other => {
            // The dsh acp surface declares no other client-side methods.
            conn.respond_error(id, -32601, &format!("method not supported by spike: {other}"))
                .await;
        }
    }
}

// ---------------------------------------------------------------------------
// Child process
// ---------------------------------------------------------------------------

fn spawn_dsh() -> Result<Child> {
    let mut cmd = dsh_command();
    cmd.args(["--profile", "acp"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd.spawn()
        .context("failed to spawn the dsh acp profile (is dsh on PATH?)")
}

/// Resolve the dsh launcher. `DSH_BIN` overrides; on Windows the npm `dsh`
/// shim is a .cmd file that CreateProcess cannot exec directly, so we route
/// through `cmd /C`. Stdio pipes pass through cmd.exe unchanged.
fn dsh_command() -> Command {
    if let Ok(bin) = std::env::var("DSH_BIN") {
        return Command::new(bin);
    }
    #[cfg(target_os = "windows")]
    {
        let mut c = Command::new("cmd");
        c.args(["/C", "dsh"]);
        c
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("dsh")
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> Result<()> {
    let task = std::env::args().nth(1).unwrap_or_else(|| {
        "Reply with exactly one short sentence confirming you received this message. \
         Do not use any tools."
            .to_string()
    });

    println!("dsh-tui spike: spawning `dsh --profile acp` …");
    let mut child = spawn_dsh()?;

    let stdin = child.stdin.take().context("no stdin")?;
    let stdout = child.stdout.take().context("no stdout")?;
    let stderr = child.stderr.take().context("no stderr")?;

    // Writer task: every outgoing frame goes through this channel.
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(v) = rx.recv().await {
            let mut line = v.to_string();
            line.push('\n');
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = stdin.flush().await;
        }
        // tx dropped -> channel closed -> stdin dropped -> dsh sees EOF and
        // performs its bounded successful shutdown.
    });

    // Stderr is dsh's log channel; stdout is protocol-only.
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            eprintln!("[dsh:stderr] {l}");
        }
    });

    // Reader task: dispatch responses, agent requests, and notifications.
    let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    {
        let pending = pending.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let v: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => {
                        eprintln!("[dsh:non-json] {line}");
                        continue;
                    }
                };
                if let Some(id) = v.get("id") {
                    let has_method = v.get("method").is_some();
                    if !has_method {
                        // Response to one of our requests.
                        if let Some(n) = id.as_u64() {
                            if let Some(rtx) = pending.lock().await.remove(&n) {
                                let _ = rtx.send(v);
                            }
                        }
                        continue;
                    }
                    // Request originating from the agent.
                    let method = v
                        .get("method")
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let params = v.get("params").cloned().unwrap_or(Value::Null);
                    let conn = Conn {
                        tx: tx.clone(),
                        pending: pending.clone(),
                        next_id: 0,
                    };
                    handle_server_request(&conn, id.clone(), &method, &params).await;
                    continue;
                }
                // Notification.
                let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
                if method == "session/update" {
                    if let Some(update) = v.pointer("/params/update") {
                        print_update(update);
                    }
                } else if !method.is_empty() {
                    println!("\r\n[notify] {method}");
                }
            }
        });
    }

    let mut conn = Conn {
        tx,
        pending,
        next_id: 0,
    };

    // 1. initialize
    let init = conn
        .request(
            "initialize",
            json!({"protocolVersion": 1, "clientCapabilities": {}}),
            Duration::from_secs(60),
        )
        .await?;
    println!(
        "initialize ok: protocolVersion={:?} authMethods={}",
        init.get("protocolVersion"),
        init.get("authMethods").map(|v| v.to_string()).unwrap_or_default()
    );

    // 2. session/new
    let cwd = std::env::current_dir().context("current_dir")?;
    let new = conn
        .request(
            "session/new",
            json!({"cwd": cwd, "mcpServers": []}),
            Duration::from_secs(120),
        )
        .await?;
    let sid = new
        .get("sessionId")
        .and_then(|v| v.as_str())
        .context("session/new returned no sessionId")?
        .to_string();
    println!("session created: {sid}");
    if let Some(opts) = new.get("configOptions") {
        println!("configOptions: {opts}");
    }

    // 3. prompt + stream
    println!("--- prompt: {task}");
    let prompt = conn
        .request(
            "session/prompt",
            json!({"sessionId": sid, "prompt": [{"type": "text", "text": task}]}),
            Duration::from_secs(600),
        )
        .await?;
    println!(
        "\r\n--- settled: stopReason={:?}",
        prompt.get("stopReason").and_then(|v| v.as_str()).unwrap_or("?")
    );

    // 4. close the session, then let stdin EOF shut the server down.
    let _ = conn
        .request("session/close", json!({"sessionId": sid}), Duration::from_secs(30))
        .await;
    drop(conn); // closes tx -> writer drains -> stdin EOF
    let _ = tokio::time::timeout(Duration::from_secs(20), child.wait()).await;
    println!("done.");
    Ok(())
}
