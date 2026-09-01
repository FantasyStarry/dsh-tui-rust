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
    let (client, mut rx) = acp::AcpClient::spawn().await?;

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

    // Close this run's own session: the probe never talks to it, so it is
    // pure residue (an empty header-only log). Left open it would pile up in
    // the shared registry — the exact blanks that used to hijack the web's
    // new-session blank pool and hide the mode picker.
    let _ = client.close_session(&sid).await;
    println!("session/close: {}（probe 自身会话已回收）", acp::short_id(&sid));

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

    // Release the protocol client: dropping the last AcpClient releases
    // Inner, which closes the outbound channel → stdin EOF → dsh's bounded
    // graceful shutdown. Wait (bounded) for the kernel to actually exit so
    // every spawned task ends and the runtime can shut down cleanly.
    drop(client);
    {
        use std::time::Duration;
        let deadline = tokio::time::sleep(Duration::from_secs(15));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                ev = rx.recv() => match ev {
                    Some(acp::AcpEvent::ServerGone(_)) => break,
                    _ => {}
                },
                _ = &mut deadline => break,
            }
        }
    }
    Ok(())
}

/// Non-interactive rendering benchmark: drives the real render path against a
/// `TestBackend` (no TTY) to verify the streaming frame budget and the
/// incremental display cache. Run with `dsh-tui --render-bench`.
pub fn render_bench() -> anyhow::Result<()> {
    use std::time::Instant;
    use ratatui::backend::TestBackend;

    println!("render-bench: TestBackend 120x40，模拟长转写 + 流式增量渲染");
    let mut terminal = ratatui::Terminal::new(TestBackend::new(120, 40))?;
    let mut app = app::App::new();
    app.state = app::RunState::Idle;
    app.busy_since = None;

    // Build a realistic long transcript (mixed entry kinds, CJK + markdown).
    for i in 0..400 {
        app.push_entry(app::EntryKind::User, &format!("第 {i} 轮：请分析这个项目并给出改进建议"));
        app.push_entry(app::EntryKind::Tool, &format!("read 项目文件 {}", i));
        app.push_entry(
            app::EntryKind::Agent,
            &format!(
                "第 {i} 轮回复：包含 **markdown**、`inline code`、```rust\nlet x = {i};\n```、\
                列表项、以及一段用于 CJK 换行测试的中文文本内容，字数尽量多一点以模拟真实回复的长度。"
            ),
        );
    }
    println!("转写条目: {}（模拟 400 轮对话）", app.entries.len());

    // 1) Streaming simulation: append a chunk + full draw each frame.
    const FRAMES: usize = 300;
    let t0 = Instant::now();
    for f in 0..FRAMES {
        app.append_chunk(app::EntryKind::Agent, &format!(" 流式增量片段{f}"));
        ui::draw(&mut terminal, &mut app)?;
    }
    let stream = t0.elapsed();
    println!(
        "流式渲染 {FRAMES} 帧: {:?} → {:.0} fps（{:.2} ms/帧）",
        stream,
        FRAMES as f64 / stream.as_secs_f64(),
        stream.as_secs_f64() * 1000.0 / FRAMES as f64
    );

    // 2) Incremental ensure_display cost (tail re-wrap only).
    let t1 = Instant::now();
    for _ in 0..500 {
        app.append_chunk(app::EntryKind::Agent, "x");
        app.ensure_display(118);
    }
    let inc = t1.elapsed() / 500;
    println!("增量 ensure_display（尾条目）: {inc:?}/帧");

    // 3) Full re-wrap cost (width flip forces everything to rebuild).
    let t2 = Instant::now();
    for i in 0..20 {
        let w = if i % 2 == 0 { 118 } else { 88 };
        app.ensure_display(w);
    }
    let full = t2.elapsed() / 20;
    println!("全量 ensure_display（~{} 条目重排）: {full:?}/帧", app.entries.len());

    // 4) Full-frame draw on the final long transcript (worst case).
    let t3 = Instant::now();
    for _ in 0..50 {
        app.dirty = true;
        ui::draw(&mut terminal, &mut app)?;
    }
    let frame = t3.elapsed() / 50;
    println!(
        "长转写全帧绘制: {frame:?}/帧（{:.2} ms；30fps 预算 = 33.3 ms）",
        frame.as_secs_f64() * 1000.0
    );

    let ok = stream.as_secs_f64() / FRAMES as f64 <= 0.033 && frame.as_secs_f64() <= 0.033;
    println!(
        "结论: {}（预算内 = 单帧 ≤ 33.3ms）",
        if ok { "✔ 流式帧率达标" } else { "✘ 超过 30fps 预算，需要优化" }
    );
    Ok(())
}
