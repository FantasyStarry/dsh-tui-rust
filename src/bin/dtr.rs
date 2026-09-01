//! `dtr` binary entry point — short alias for `dsh-tui` (identical behavior).

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
            eprintln!("dtr: 与内核的连接已断开：{reason}");
            eprintln!("会话已持久化，重启后 Ctrl+L 可恢复。");
            std::process::exit(1);
        }
    }
}
