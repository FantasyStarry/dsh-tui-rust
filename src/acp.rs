//! ACP (Agent Client Protocol v1) client for the dsh `acp` profile.
//!
//! Spawns `dsh --profile acp` as a child process and speaks newline-delimited
//! JSON-RPC over stdio. Outgoing frames go through one writer task; incoming
//! frames are dispatched by one reader task into:
//!
//! - responses  → the pending-response map (awaited by [`AcpClient::request`])
//! - agent requests (permission prompts) → [`AcpEvent::PermissionRequest`]
//! - notifications → typed [`AcpEvent`]s consumed by the UI event loop
//!
//! The Node.js harness core is never modified — this is a pure protocol client.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex, oneshot};

const INIT_TIMEOUT: Duration = Duration::from_secs(60);
const SESSION_TIMEOUT: Duration = Duration::from_secs(120);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(30);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(3600);

// ---------------------------------------------------------------------------
// Public events consumed by the UI
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct PermOption {
    pub option_id: Value,
    pub name: String,
    pub kind: String,
}

#[derive(Debug)]
pub enum AcpEvent {
    SessionCreated { session_id: String },
    MessageChunk(String),
    ThoughtChunk(String),
    ToolCall {
        tool_call_id: String,
        title: String,
        kind: String,
        status: String,
        raw: Option<String>,
    },
    ToolCallUpdate { tool_call_id: String, title: Option<String>, status: Option<String> },
    Usage { used: u64, size: u64 },
    ConfigUpdated(Vec<ConfigOptionState>),
    PermissionRequest { request_id: Value, tool_title: String, options: Vec<PermOption> },
    PromptSettled { stop_reason: String, error: Option<String> },
    /// A locally executed `!` / `!!` shell command finished (output captured).
    /// `send` = the output should also be submitted to the session as context.
    ShellDone {
        cmd: String,
        output: String,
        truncated: bool,
        exit_code: Option<i32>,
        send: bool,
    },
    /// The `dsh web` probe result (up = port is listening).
    WebStatus { up: bool, url: String },
    ServerGone(String),
    Notice(String),
}

#[derive(Clone, Debug)]
pub struct ListedSession {
    pub session_id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}

/// One advertised configuration selector (`model`, `reasoning_effort`, …).
#[derive(Clone, Debug)]
pub struct ConfigOptionState {
    pub id: String,
    pub current: String,
    pub options: Vec<ConfigChoice>,
}

#[derive(Clone, Debug)]
pub struct ConfigChoice {
    pub name: String,
    pub value: String,
    pub description: Option<String>,
    /// Provider group this choice belongs to (model picker only; set when
    /// the payload nests choices inside provider groups).
    pub group: Option<String>,
}

/// Parse the `configOptions` payload defensively (session/new result,
/// `config_option_update` notifications, `set_config_option` responses).
/// The model selector nests its choices inside group nodes — flatten them,
/// carrying the group name down so the UI can disambiguate same-named models
/// across providers.
pub fn parse_config(v: Option<&Value>) -> Vec<ConfigOptionState> {
    let Some(arr) = v.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|o| {
            let mut options = Vec::new();
            if let Some(raw) = o.get("options").and_then(|x| x.as_array()) {
                flatten_choices(raw, None, &mut options);
            }
            Some(ConfigOptionState {
                id: str_field(o, &["id"])?,
                current: o
                    .get("currentValue")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                options,
            })
        })
        .collect()
}

fn flatten_choices(arr: &[Value], group: Option<&str>, out: &mut Vec<ConfigChoice>) {
    for c in arr {
        if let Some(inner) = c.get("options").and_then(|x| x.as_array()) {
            // Group node: descend with its group name (innermost wins).
            let inner_group = str_field(c, &["group", "name"]);
            let inner_group_ref = inner_group.as_deref().or(group);
            flatten_choices(inner, inner_group_ref, out);
        } else if let Some(name) = str_field(c, &["name"]) {
            let value = match c.get("value") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
                None => continue,
            };
            out.push(ConfigChoice {
                name,
                value,
                description: str_field(c, &["description"]),
                group: str_field(c, &["group"]).or_else(|| group.map(String::from)),
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

struct Inner {
    out: mpsc::UnboundedSender<Value>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    events: mpsc::UnboundedSender<AcpEvent>,
}

impl Inner {
    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (rtx, rrx) = oneshot::channel();
        self.pending.lock().await.insert(id, rtx);

        self.out
            .send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .map_err(|_| anyhow::anyhow!("连接已关闭"))?;

        let resp = match tokio::time::timeout(timeout, rrx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => bail!("{method}: 响应通道断开"),
            Err(_) => bail!("{method}: 超时（{timeout:?}）"),
        };
        if let Some(err) = resp.get("error") {
            bail!("{method} 失败: {err}");
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }
}

#[derive(Clone)]
pub struct AcpClient {
    inner: Arc<Inner>,
}

impl AcpClient {
    /// Spawn `dsh --profile acp` and wire up the protocol tasks.
    pub async fn spawn() -> Result<(Self, mpsc::UnboundedReceiver<AcpEvent>)> {
        let mut cmd = dsh_command();
        cmd.args(["--profile", "acp"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .context("无法启动 dsh（需要 dsh 在 PATH 上，或用 DSH_BIN 指向可执行文件）")?;

        #[cfg(target_os = "windows")]
        attach_job_object(&child);

        let stdin = child.stdin.take().context("子进程缺少 stdin")?;
        let stdout = child.stdout.take().context("子进程缺少 stdout")?;
        let stderr = child.stderr.take().context("子进程缺少 stderr")?;

        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
        let (ev_tx, ev_rx) = mpsc::unbounded_channel::<AcpEvent>();
        // Set once the outbound channel has closed (stdin EOF sent to dsh);
        // the watcher uses it to bound dsh's graceful shutdown window.
        let shutdown = Arc::new(AtomicBool::new(false));

        // Writer: every outgoing frame funnels through here; dropping the
        // client closes the channel → stdin EOF → dsh performs its bounded
        // successful shutdown.
        {
            let shutdown = shutdown.clone();
            tokio::spawn(async move {
                let mut stdin = stdin;
                while let Some(v) = out_rx.recv().await {
                    let mut line = v.to_string();
                    line.push('\n');
                    if stdin.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = stdin.flush().await;
                }
                shutdown.store(true, Ordering::Relaxed);
            });
        }

        // dsh logs go to stderr; stdout is protocol-only.
        {
            let ev = ev_tx.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    let _ = ev.send(AcpEvent::Notice(format!("[dsh] {l}")));
                }
            });
        }

        let inner = Arc::new(Inner {
            out: out_tx,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            events: ev_tx.clone(),
        });

        // Reader: dispatch responses / agent requests / notifications.
        //
        // Holds only a *weak* reference to Inner: the writer task ends when
        // the outbound sender drops, and the sender lives inside Inner — so
        // the reader must not pin Inner or dropping the last client would
        // never EOF dsh's stdin (the child would linger forever). With Weak,
        // the last client drop releases Inner → writer ends → stdin EOF →
        // dsh performs its bounded graceful shutdown → stdout closes → this
        // task ends on its own.
        {
            let inner = Arc::downgrade(&inner);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let Some(inner) = inner.upgrade() else { break };
                    let v: Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => {
                            let _ = inner.events.send(AcpEvent::Notice(format!("[non-json] {line}")));
                            continue;
                        }
                    };
                    dispatch(&inner, v).await;
                }
                if let Some(inner) = inner.upgrade() {
                    let _ = inner.events.send(AcpEvent::ServerGone("stdout 已关闭".into()));
                }
            });
        }

        // Process watcher: reports exit; and if stdin EOF (graceful-shutdown
        // request) does not produce a timely exit — some out-of-tree plugins
        // keep dsh alive — force-kill the whole process tree so the runtime
        // (and this process) can wind down instead of hanging.
        {
            use std::time::Instant;
            let ev = ev_tx.clone();
            let shutdown = shutdown.clone();
            tokio::spawn(async move {
                let mut child = child;
                let mut grace_started: Option<Instant> = None;
                loop {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            let _ = ev.send(AcpEvent::ServerGone(format!("dsh 进程退出: {status:?}")));
                            return;
                        }
                        Ok(None) => {}
                        Err(e) => {
                            let _ = ev.send(AcpEvent::ServerGone(format!("dsh wait 失败: {e}")));
                            return;
                        }
                    }
                    if let Some(start) = grace_started {
                        if start.elapsed() >= Duration::from_secs(3) {
                            if let Some(pid) = child.id() {
                                kill_process_tree(pid).await;
                            }
                            let status = child.wait().await;
                            let _ = ev.send(AcpEvent::ServerGone(format!("dsh 强制退出: {status:?}")));
                            return;
                        }
                    } else if shutdown.load(Ordering::Relaxed) {
                        grace_started = Some(Instant::now());
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            });
        }

        Ok((Self { inner }, ev_rx))
    }

    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        self.inner.request(method, params, timeout).await
    }

    pub fn emit(&self, ev: AcpEvent) {
        let _ = self.inner.events.send(ev);
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.inner
            .out
            .send(json!({"jsonrpc": "2.0", "method": method, "params": params}))
            .context("连接已关闭")?;
        Ok(())
    }

    // -- lifecycle -----------------------------------------------------------

    pub async fn initialize(&self) -> Result<Value> {
        self.request(
            "initialize",
            json!({"protocolVersion": 1, "clientCapabilities": {}}),
            INIT_TIMEOUT,
        )
        .await
    }

    pub async fn new_session(&self, cwd: &Path) -> Result<(String, Vec<ConfigOptionState>)> {
        let r = self
            .request("session/new", json!({"cwd": cwd, "mcpServers": []}), SESSION_TIMEOUT)
            .await?;
        let cfg = parse_config(r.get("configOptions"));
        if !cfg.is_empty() {
            let _ = self.inner.events.send(AcpEvent::ConfigUpdated(cfg.clone()));
        }
        let sid = session_id_of(&r).context("session/new 未返回 sessionId")?;
        Ok((sid, cfg))
    }

    /// Switch an advertised selector (`model`, `reasoning_effort`). dsh allows
    /// this while a prompt is in flight — the change applies to the next turn.
    pub async fn set_config_option(
        &self,
        session_id: &str,
        id: &str,
        value: &str,
    ) -> Result<Vec<ConfigOptionState>> {
        let r = self
            .request(
                "session/set_config_option",
                json!({"sessionId": session_id, "configId": id, "value": value}),
                SESSION_TIMEOUT,
            )
            .await?;
        Ok(parse_config(r.get("configOptions")))
    }

    /// Re-fetch the complete config state (model + reasoning options).
    ///
    /// The `session/new` response computes its `configOptions` at request
    /// admission time, before the settings-backed pi-ai provider adapters
    /// have registered — so early calls advertise only the built-in
    /// DeepSeek route. A no-op `set_config_option` to the current model is
    /// the standard ACP way to pull the *current* full state: the server
    /// validates the value (it is already selected, so always valid) and
    /// answers with the freshly enumerated catalog. Callers retry until the
    /// catalog covers every provider.
    pub async fn refresh_config(&self, session_id: &str, current_model: &str) -> Result<Vec<ConfigOptionState>> {
        if current_model.is_empty() {
            return Ok(Vec::new());
        }
        self.set_config_option(session_id, "model", current_model).await
    }

    pub async fn list_sessions(&self) -> Result<Vec<ListedSession>> {
        let r = self.request("session/list", json!({}), SESSION_TIMEOUT).await?;
        Ok(parse_sessions(&r))
    }

    /// dsh extends the standard resume call with a required `cwd` — it
    /// verifies the session's canonical workspace before composing.
    pub async fn resume_session(&self, id: &str, cwd: &str) -> Result<String> {
        let r = self
            .request(
                "session/resume",
                json!({"sessionId": id, "cwd": cwd}),
                SESSION_TIMEOUT,
            )
            .await?;
        Ok(session_id_of(&r).unwrap_or_else(|| id.to_string()))
    }

    pub async fn close_session(&self, id: &str) -> Result<()> {
        let _ = self
            .request("session/close", json!({"sessionId": id}), CLOSE_TIMEOUT)
            .await;
        Ok(())
    }

    // -- in-flight work ------------------------------------------------------

    /// Send one prompt in a background task; the result arrives as
    /// [`AcpEvent::PromptSettled`] so the UI keeps rendering while it runs.
    pub fn prompt(&self, session_id: String, text: String) {
        let inner = self.inner.clone();
        tokio::spawn(async move {
            let params = json!({
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": text}]
            });
            match inner.request("session/prompt", params, PROMPT_TIMEOUT).await {
                Ok(r) => {
                    let stop = r
                        .get("stopReason")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let _ = inner.events.send(AcpEvent::PromptSettled { stop_reason: stop, error: None });
                }
                Err(e) => {
                    let _ = inner.events.send(AcpEvent::PromptSettled {
                        stop_reason: "error".into(),
                        error: Some(format!("{e:#}")),
                    });
                }
            }
        });
    }

    pub fn cancel(&self, session_id: &str) {
        let _ = self.notify("session/cancel", json!({"sessionId": session_id}));
    }

    /// Answer a `session/request_permission` initiated by the agent.
    /// `None` means "cancelled / rejected".
    pub fn respond_permission(&self, request_id: Value, option_id: Option<Value>) {
        let outcome = match option_id {
            Some(oid) => json!({"outcome": "selected", "optionId": oid}),
            None => json!({"outcome": "cancelled"}),
        };
        let _ = self
            .inner
            .out
            .send(json!({"jsonrpc": "2.0", "id": request_id, "result": {"outcome": outcome}}));
    }
}

// ---------------------------------------------------------------------------
// Frame dispatch
// ---------------------------------------------------------------------------

async fn dispatch(inner: &Arc<Inner>, v: Value) {
    if let Some(id) = v.get("id").cloned() {
        if v.get("method").is_none() {
            // Response to one of our requests.
            if let Some(n) = id.as_u64() {
                if let Some(rtx) = inner.pending.lock().await.remove(&n) {
                    let _ = rtx.send(v);
                }
            }
            return;
        }
        // Request originating from the agent.
        let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("unknown").to_string();
        let params = v.get("params").cloned().unwrap_or(Value::Null);
        match method.as_str() {
            "session/request_permission" => {
                let (tool_title, options) = parse_permission(&params);
                let _ = inner.events.send(AcpEvent::PermissionRequest {
                    request_id: id,
                    tool_title,
                    options,
                });
            }
            other => {
                let _ = inner.out.send(json!({
                    "jsonrpc": "2.0", "id": id,
                    "error": {"code": -32601, "message": format!("method not supported: {other}")}
                }));
            }
        }
        return;
    }

    // Notification.
    let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
    if method != "session/update" {
        let _ = inner.events.send(AcpEvent::Notice(format!("[notify] {method}")));
        return;
    }
    let Some(update) = v.pointer("/params/update") else {
        return;
    };
    let kind = update.get("sessionUpdate").and_then(|k| k.as_str()).unwrap_or("");
    match kind {
        "agent_message_chunk" | "agent_message" => {
            let t = content_text(update.get("content"));
            if !t.is_empty() {
                let _ = inner.events.send(AcpEvent::MessageChunk(t));
            }
        }
        "agent_thought_chunk" => {
            let t = content_text(update.get("content"));
            if !t.is_empty() {
                let _ = inner.events.send(AcpEvent::ThoughtChunk(t));
            }
        }
        "tool_call" => {
            let raw = update
                .get("rawInput")
                .or_else(|| update.get("raw_input"))
                .map(|v| clip(&v.to_string(), 160));
            let _ = inner.events.send(AcpEvent::ToolCall {
                tool_call_id: str_field(update, &["toolCallId", "tool_call_id"]).unwrap_or_default(),
                title: str_field(update, &["title"]).unwrap_or_else(|| "工具调用".into()),
                kind: str_field(update, &["kind"]).unwrap_or_default(),
                status: str_field(update, &["status"]).unwrap_or_else(|| "pending".into()),
                raw,
            });
        }
        "tool_call_update" => {
            let _ = inner.events.send(AcpEvent::ToolCallUpdate {
                tool_call_id: str_field(update, &["toolCallId", "tool_call_id"]).unwrap_or_default(),
                title: str_field(update, &["title"]),
                status: str_field(update, &["status"]),
            });
        }
        "usage_update" => {
            let _ = inner.events.send(AcpEvent::Usage {
                used: update.get("used").and_then(|v| v.as_u64()).unwrap_or(0),
                size: update.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
            });
        }
        "config_option_update" => {
            let cfg = parse_config(update.get("configOptions"));
            let _ = inner.events.send(AcpEvent::ConfigUpdated(cfg));
        }
        other => {
            let _ = inner.events.send(AcpEvent::Notice(format!(
                "[update:{other}] {}",
                clip(&update.to_string(), 160)
            )));
        }
    }
}

// ---------------------------------------------------------------------------
// Parsing helpers (defensive: unknown shapes degrade to labels, not panics)
// ---------------------------------------------------------------------------

/// Extract concatenated text from an ACP content block or block array.
fn content_text(c: Option<&Value>) -> String {
    match c {
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        Some(block) => block.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string(),
        None => String::new(),
    }
}

fn str_field(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| v.get(k).and_then(|x| x.as_str()).map(|s| s.to_string()))
}

fn session_id_of(r: &Value) -> Option<String> {
    str_field(r, &["sessionId"]).or_else(|| {
        r.get("session")
            .and_then(|s| str_field(s, &["sessionId"]))
    })
}

fn parse_permission(params: &Value) -> (String, Vec<PermOption>) {
    let tool_title = params
        .pointer("/toolCall/title")
        .and_then(|v| v.as_str())
        .or_else(|| params.pointer("/toolCall/kind").and_then(|v| v.as_str()))
        .unwrap_or("工具调用")
        .to_string();
    let options = params
        .get("options")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|o| {
                    Some(PermOption {
                        option_id: o.get("optionId").cloned()?,
                        name: str_field(o, &["name"]).unwrap_or_default(),
                        kind: str_field(o, &["kind"]).unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    (tool_title, options)
}

fn parse_sessions(r: &Value) -> Vec<ListedSession> {
    let arr = r
        .get("sessions")
        .and_then(|v| v.as_array())
        .or_else(|| r.as_array())
        .cloned()
        .unwrap_or_default();
    arr.iter()
        .filter_map(|s| {
            Some(ListedSession {
                session_id: str_field(s, &["sessionId", "session_id", "id"])?,
                cwd: str_field(s, &["cwd", "workspace", "workspaceDir"]).unwrap_or_default(),
                title: str_field(s, &["title", "name", "summary"]),
                updated_at: str_field(s, &["updatedAt", "updated_at", "lastActivityAt", "mtime"]),
            })
        })
        .collect()
}

/// Truncate by chars (never splits a UTF-8 code point).
pub fn clip(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max_chars).collect();
        out.push('…');
        out
    }
}

pub fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
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

/// Assign the dsh process tree to a kill-on-close Job Object (Windows).
///
/// The graceful path (stdin EOF → grace → tree-kill) covers normal exits,
/// but a hard kill of the TUI — window ✕, task manager, crash — skips all of
/// it and would orphan the kernel. With the child inside a job owned by this
/// process, the OS closes the job handle when the TUI dies *however* it dies
/// and reaps the whole tree. The handle is intentionally never closed.
#[cfg(target_os = "windows")]
fn attach_job_object(child: &tokio::process::Child) {
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            return;
        }
        if let Some(h) = child.raw_handle() {
            AssignProcessToJobObject(job, h);
        }
        // `job` is deliberately leaked: the last handle closes when this
        // process exits, which kills every process in the job.
    }
}

/// Force-kill the dsh process tree. On Windows the launcher is/// `cmd /C dsh`, so the real node process is a *grandchild* — killing the
/// cmd wrapper alone would orphan it, and its open stdio handles would keep
/// the protocol tasks (and this process) alive forever. Two passes:
///
/// 1. `taskkill /T /F` on the wrapper pid while it is still alive (walks the
///    whole live tree);
/// 2. when the wrapper already exited on stdin EOF, node is orphaned but its
///    `ParentProcessId` still points at the dead wrapper — enumerate direct
///    children and kill each so the protocol pipes close.
///
/// On Unix dsh is spawned directly, so a plain kill suffices (dsh-owned
/// stdio children exit on their own stdin EOF).
async fn kill_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let kill = |p: u32| async move {
            let _ = tokio::process::Command::new("taskkill")
                .args(["/PID", &p.to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        };
        kill(pid).await;
        // Pass 2: orphaned direct children (ParentProcessId == pid).
        let query = format!(
            "Get-CimInstance Win32_Process -Filter 'ParentProcessId = {pid}' | ForEach-Object {{ Write-Output $_.ProcessId }}"
        );
        if let Ok(out) = tokio::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &query])
            .stdin(Stdio::null())
            .output()
            .await
        {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if let Ok(cpid) = line.trim().parse::<u32>() {
                    if cpid != pid {
                        kill(cpid).await;
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = tokio::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
}
