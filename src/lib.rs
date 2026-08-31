//! dsh-tui — a terminal UI for DeepSeek Harness, speaking ACP v1 over stdio.
//!
//! The crate is split into a library (this file) and two thin binaries:
//! - `dsh-tui` — the canonical command
//! - `dtr`    — short alias, identical behavior
//!
//! Modes:
//! - `dsh-tui` / `dtr`          interactive TUI (requires a real terminal TTY)
//! - `--probe`                  non-interactive self-check: initialize,
//!   session/new, session/list, session/resume, model-catalog sync — no TTY
//! - `--dwell <ms>`             keep the process alive after the probe so
//!   delayed host-side work (companion reconcile timers) can run

pub mod acp;
pub mod app;
pub mod theme;
pub mod ui;

use anyhow::Result;
use crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use crossterm::ExecutableCommand;

/// Run the interactive ratatui TUI. Returns `None` on clean quit, or the
/// disconnection reason (the caller then exits non-zero).
pub async fn run_tui() -> Result<Option<String>> {
    let terminal = ratatui::init();
    let mouse_ok = std::io::stdout().execute(EnableMouseCapture).is_ok();
    let result = app::run(terminal).await;
    ratatui::restore();
    if mouse_ok {
        let _ = std::io::stdout().execute(DisableMouseCapture);
    }
    result
}

/// Non-interactive self-check. Also verifies the model-catalog sync: after
/// `session/new` the settings-backed providers may not have registered yet,
/// so the probe waits and re-pulls the config until more than one provider
/// group is advertised (or a bounded timeout), proving the TUI will show the
/// same model list as the web GUI.
pub async fn probe() -> Result<()> {
    use std::time::Duration;

    println!("probe: 启动 `dsh --profile acp` …");
    let (client, _rx) = acp::AcpClient::spawn().await?;

    let init = client.initialize().await?;
    println!(
        "initialize: protocolVersion={}",
        init.get("protocolVersion").map(|v| v.to_string()).unwrap_or_default()
    );

    let cwd = std::env::current_dir()?;
    let (sid, config) = client.new_session(&cwd).await?;
    println!("session/new: {sid}");
    let distinct_groups = |m: &acp::ConfigOptionState| -> usize {
        let mut seen = std::collections::HashSet::new();
        for ch in &m.options {
            if let Some(g) = &ch.group {
                seen.insert(g.clone());
            }
        }
        seen.len()
    };
    let snapshot_groups = config
        .iter()
        .find(|c| c.id == "model")
        .map(distinct_groups)
        .unwrap_or(0);
    println!("session/new 快照: {} 个提供商分组", snapshot_groups);

    // Model-catalog sync check: wait for the settings-backed pi-ai adapters
    // (they register ~1.5–2s after boot) and re-pull via a no-op set.
    let mut current = config
        .iter()
        .find(|c| c.id == "model")
        .map(|c| c.current.clone())
        .unwrap_or_default();
    let mut groups = snapshot_groups;
    for attempt in 0..6u32 {
        if groups > 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
        if let Ok(fresh) = client.refresh_config(&sid, &current).await {
            if let Some(m) = fresh.iter().find(|c| c.id == "model") {
                groups = distinct_groups(m);
                current = m.current.clone();
                if !fresh.is_empty() {
                    println!(
                        "config 刷新(尝试 {}): {} 个提供商分组, {} 个模型",
                        attempt + 1,
                        groups,
                        fresh.iter().find(|c| c.id == "model").map(|m| m.options.len()).unwrap_or(0)
                    );
                }
            }
        }
    }
    if groups > 1 {
        println!("模型目录已与 web 端同步（{} 个提供商）✔", groups);
    } else {
        println!("警告: 模型目录仍只有 1 个提供商分组（settings 未加载？）");
    }
    println!("model options: {} 个，当前 {}", config.len(), current);

    let sessions = client.list_sessions().await?;
    println!("session/list: {} 个持久化会话", sessions.len());
    for s in sessions.iter().take(5) {
        let title = s.title.clone().unwrap_or_else(|| s.cwd.clone());
        println!("  · {} {}", acp::short_id(&s.session_id), title);
    }

    if let Some(first) = sessions.first() {
        let cwd = if first.cwd.is_empty() {
            cwd.to_string_lossy().to_string()
        } else {
            first.cwd.clone()
        };
        let resumed = client.resume_session(&first.session_id, &cwd).await?;
        println!("session/resume: {} → ok", acp::short_id(&resumed));
    }

    // Optional dwell: keep the process alive so delayed host-side work
    // (e.g. the companion plugin's reconcile timers) can run before exit.
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|a| a == "--dwell") {
        let ms: u64 = args.get(pos + 1).and_then(|v| v.parse().ok()).unwrap_or(0);
        if ms > 0 {
            println!("dwell {ms}ms …");
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
    }

    println!("probe 通过 ✔");

    // Release the protocol client: closing the outbound channel EOFs dsh's
    // stdin, dsh shuts down, and the watcher task completes — otherwise the
    // lingering child keeps the runtime (and this process) alive forever.
    drop(client);
    tokio::time::sleep(Duration::from_millis(400)).await;
    Ok(())
}
