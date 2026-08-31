//! dsh-tui — a terminal UI for DeepSeek Harness, speaking ACP v1 over stdio.
//!
//! Modes:
//! - `dsh-tui`            interactive TUI (requires a real terminal TTY)
//! - `dsh-tui --probe`    non-interactive self-check: initialize, session/new,
//!   session/list, session/resume — no TTY needed

mod acp;
mod app;
mod theme;
mod ui;

use anyhow::Result;
use crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use crossterm::ExecutableCommand;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--probe") {
        return probe().await;
    }

    let terminal = ratatui::init();
    let mouse_ok = std::io::stdout().execute(EnableMouseCapture).is_ok();
    let result = app::run(terminal).await;
    ratatui::restore();
    if mouse_ok {
        let _ = std::io::stdout().execute(DisableMouseCapture);
    }

    match result? {
        None => Ok(()),
        Some(reason) => {
            eprintln!("dsh-tui: 与内核的连接已断开：{reason}");
            eprintln!("会话已持久化，重启后 Ctrl+L 可恢复。");
            std::process::exit(1);
        }
    }
}

async fn probe() -> Result<()> {
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
    if let Some(model) = config.iter().find(|c| c.id == "model") {
        println!("model options: {} 个，当前 {}", model.options.len(), model.current);
        // Validate the set_config_option call shape with a no-op set to the
        // current value (the wire contract is dsh-specific).
        let cfg = client.set_config_option(&sid, "model", &model.current).await?;
        println!("set_config_option(no-op): ok, {} 个配置项", cfg.len());
    }

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
            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        }
    }

    println!("probe 通过 ✔");
    Ok(())
}
