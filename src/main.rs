//! dsh-tui — a terminal UI for DeepSeek Harness, speaking ACP v1 over stdio.
//!
//! Modes:
//! - `dsh-tui`            interactive TUI (requires a real terminal TTY)
//! - `dsh-tui --probe`    non-interactive self-check: initialize, session/new,
//!   session/list, session/resume — no TTY needed

mod acp;
mod app;
mod ui;

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--probe") {
        return probe().await;
    }

    let terminal = ratatui::init();
    let result = app::run(terminal).await;
    ratatui::restore();

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
    let sid = client.new_session(&cwd).await?;
    println!("session/new: {sid}");

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

    println!("probe 通过 ✔");
    Ok(())
}
