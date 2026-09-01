//! `dsh-tui` binary entry point — a thin wrapper over the shared library.
//!
//! Modes:
//! - `dsh-tui`            interactive TUI (requires a real terminal TTY)
//! - `dsh-tui --probe`    non-interactive self-check (see `dsh_tui::probe`)
//! - `dsh-tui --render-bench`  non-TTY rendering benchmark (TestBackend)

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--probe") {
        return dsh_tui::probe().await;
    }
    if args.iter().any(|a| a == "--render-bench") {
        return dsh_tui::render_bench();
    }

    match dsh_tui::run_tui().await? {
        None => Ok(()),
        Some(reason) => {
            eprintln!("dsh-tui: 与内核的连接已断开：{reason}");
            eprintln!("会话已持久化，重启后 Ctrl+L 可恢复。");
            std::process::exit(1);
        }
    }
}
