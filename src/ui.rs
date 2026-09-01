//! ratatui rendering. Visual language follows the generated mockups:
//! gradient whale top bar, blue `❯` user prompts, dim italic thinking,
//! tool lines with colored status dots, hairline turn separators,
//! rounded violet input box, violet selection bars in dialogs.

use ratatui::backend::Backend;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, BorderType, Clear, Paragraph};
use ratatui::Frame;
use std::time::Instant;

use crate::acp::short_id;
use crate::app::rel_time;
use crate::app::{App, Dialog, RunState};
use crate::theme::{self, *};

/// Draw one frame. Call from the event loop — but only when the frame would
/// actually change something (see `app::should_draw`), otherwise the cell
/// diff and escape output are wasted.
///
/// Generic over the backend so tests and the `--render-bench` benchmark can
/// drive the exact same render path against a `TestBackend` with no TTY.
pub fn draw<B: Backend>(
    terminal: &mut ratatui::Terminal<B>,
    app: &mut App,
) -> std::io::Result<()> {
    // CSI 2026 synchronized output: bracket the frame so terminals that
    // support it (Windows Terminal, kitty, WezTerm, …) apply the whole frame
    // atomically instead of painting it progressively — the classic fix for
    // streaming flicker. Unsupported terminals ignore the unknown CSI. Opt
    // out with DSH_TUI_NO_SYNC_OUTPUT=1 if a terminal misbehaves. Only emit
    // when stdout is actually a terminal (skip under --render-bench/redir).
    use std::io::IsTerminal;
    let sync = std::env::var("DSH_TUI_NO_SYNC_OUTPUT").is_err() && std::io::stdout().is_terminal();
    if sync {
        use std::io::Write;
        let mut out = std::io::stdout();
        let _ = out.write_all(b"\x1b[?2026h");
        let _ = out.flush();
    }
    let r = terminal.draw(|f| render(f, app));
    if sync {
        use std::io::Write;
        let mut out = std::io::stdout();
        let _ = out.write_all(b"\x1b[?2026l");
        let _ = out.flush();
    }
    r.map(|_| ())
}

pub(crate) fn render(f: &mut Frame, app: &mut App) {
    // The input box grows with the number of lines (Shift+Enter editing).
    let input_h = input_height(&app.input).min(8);
    let chunks = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(input_h),
    ])
    .split(f.area());

    draw_top_bar(f, app, chunks[0]);
    if app.state == RunState::Booting {
        draw_splash(f, app, chunks[1]);
    } else {
        draw_transcript(f, app, chunks[1]);
    }
    draw_status(f, app, chunks[2]);
    draw_input(f, app, chunks[3]);
    draw_cmd_menu(f, app, chunks[3]);

    match &app.dialog {
        Dialog::Permission { .. } => draw_permission(f, app),
        Dialog::Sessions { .. } => draw_sessions(f, app),
        Dialog::Config { .. } => draw_config(f, app),
        Dialog::Info { .. } => draw_info(f, app),
        Dialog::None => {}
    }
}

// ---------------------------------------------------------------------------
// Top bar: whale + gradient wordmark | model pill + context bar
// ---------------------------------------------------------------------------

fn draw_top_bar(f: &mut Frame, app: &App, area: Rect) {
    use unicode_width::UnicodeWidthStr;

    let width = area.width as usize;
    let mut left: Vec<Span> = vec![Span::raw(" ")];
    left.push(Span::styled("🐋", Style::new()));
    left.push(Span::raw(" "));
    left.extend(theme::gradient_word("DSH·TUI", app.theme.accent, app.theme.violet));
    left.push(Span::styled(format!("  v{}", env!("CARGO_PKG_VERSION")), plain(app.theme.dim)));

    let mut right: Vec<Span> = Vec::new();
    if let Some(url) = &app.web_url {
        let port = url.rsplit(':').next().unwrap_or("");
        right.push(theme::pill(&format!("🌐 :{port}"), app.theme.ok, &app.theme));
        right.push(Span::raw(" "));
    }
    if let Some(m) = app.model_label() {
        right.push(theme::pill(&m, app.theme.violet, &app.theme));
        right.push(Span::raw(" "));
    }
    if let Some(opt) = app.config.iter().find(|c| c.id == "reasoning_effort") {
        if !opt.current.is_empty() {
            right.push(theme::pill(&format!("⚡{}", opt.current), app.theme.warn, &app.theme));
            right.push(Span::raw(" "));
        }
    }
    if let Some((used, size)) = app.usage {
        right.push(Span::styled("ctx", plain(app.theme.muted)));
        right.extend(theme::ctx_bar(used, size, 10, &app.theme));
        right.push(Span::raw(" "));
    }

    let right_w: usize = right.iter().map(|s| UnicodeWidthStr::width(s.content.as_ref())).sum();
    let left_w: usize = left.iter().map(|s| UnicodeWidthStr::width(s.content.as_ref())).sum();

    let mut spans = left;
    if right_w + left_w + 1 < width {
        spans.push(Span::raw(" ".repeat(width - left_w - right_w - 1)));
        spans.extend(right);
    }
    f.render_widget(Paragraph::new(Text::from(Line::from(spans))), area);
}

// ---------------------------------------------------------------------------
// Splash (while booting)
// ---------------------------------------------------------------------------

fn draw_splash(f: &mut Frame, app: &App, area: Rect) {
    let elapsed = app
        .busy_since
        .map(|t: Instant| t.elapsed().as_secs_f32())
        .unwrap_or(0.0);
    let spinner = SPINNER[((elapsed * 8.0) as usize) % SPINNER.len()];

    let cx = area.x + area.width / 2;
    let cy = area.y + area.height / 2;
    let put = |f: &mut Frame, dy: i32, line: Line, centered: bool| {
        let y = (cy as i32 + dy) as u16;
        if y >= area.y + area.height {
            return;
        }
        let w = line.width() as u16;
        let x = if centered { cx.saturating_sub(w / 2) } else { area.x + 2 };
        let r = Rect { x, y, width: area.width.saturating_sub(2), height: 1 };
        f.render_widget(Paragraph::new(Text::from(line)), r);
    };

    put(f, -3, Line::from(""), true);
    put(f, -2, Line::from(gradient_word("D S H · T U I", app.theme.accent, app.theme.violet)), true);
    put(f, -1, Line::from(Span::styled("～ deep agents in your terminal ～", plain(app.theme.dim))), true);
    put(f, 1, Line::from(vec![
        Span::styled(format!("{spinner} "), plain(app.theme.violet)),
        Span::styled("正在连接 dsh 内核（--profile acp）…", plain(app.theme.muted)),
    ]), true);
    put(f, 2, Line::from(Span::styled("输入消息后回车发送 · /list 会话 · /new 新会话 · Ctrl+C 退出", plain(app.theme.dim))), true);
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

fn draw_transcript(f: &mut Frame, app: &mut App, area: Rect) {
    let inner = Rect {
        x: area.x + 1,
        y: area.y,
        width: area.width.saturating_sub(2),
        height: area.height,
    };
    app.ensure_display(inner.width);
    let total = app.display.len();
    let view = inner.height as usize;
    let start = if app.scroll_from_bottom == 0 {
        total.saturating_sub(view)
    } else {
        total.saturating_sub(view + app.scroll_from_bottom as usize)
    };
    let end = (start + view).min(total);

    let lines: Vec<Line> = app.display[start..end]
        .iter()
        .map(|spans| Line::from(spans.clone()))
        .collect();
    f.render_widget(Paragraph::new(Text::from(lines)), inner);
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

fn draw_status(f: &mut Frame, app: &App, area: Rect) {
    use unicode_width::UnicodeWidthStr;

    let width = area.width as usize;
    let mut left: Vec<Span> = vec![Span::raw(" ")];
    let revealing = app.reveal_active();
    let (dot, label) = match app.state {
        RunState::Booting => (app.theme.dim, "启动中"),
        RunState::Idle if revealing => (app.theme.warn, "输出中"),
        RunState::Idle => (app.theme.ok, "就绪"),
        RunState::Busy => (app.theme.warn, "运行中"),
    };
    let animating = app.state == RunState::Busy || app.state == RunState::Booting || revealing;
    left.push(Span::styled("● ", plain(dot)));
    if animating {
        let elapsed = app.busy_since.map(|t| t.elapsed().as_secs_f32()).unwrap_or(0.0);
        let spinner = SPINNER[((elapsed * 8.0) as usize) % SPINNER.len()];
        left.push(Span::styled(format!("{spinner} "), plain(app.theme.violet)));
        if app.state == RunState::Busy {
            left.push(Span::styled(format!("{label} {:.0}s", elapsed), bold(app.theme.warn)));
            left.push(Span::styled(" · Esc 取消", plain(app.theme.muted)));
        } else {
            left.push(Span::styled(label.to_string(), bold(dot)));
        }
    } else {
        left.push(Span::styled(label, plain(app.theme.fg)));
    }
    if app.scroll_from_bottom > 0 {
        left.push(Span::styled(format!(" · ↑{} 行", app.scroll_from_bottom), plain(app.theme.warn)));
    }
    if app.queue_len() > 0 {
        left.push(Span::styled(format!(" · 队列 {}", app.queue_len()), plain(app.theme.warn)));
    }
    if let Some(sid) = &app.session_id {
        left.push(Span::styled(format!(" · {}", short_id(sid)), plain(app.theme.dim)));
    }

    let mut right: Vec<Span> = if app.state == RunState::Busy {
        theme::keycap("Esc", "取消", &app.theme)
            .into_iter()
            .chain(theme::keycap("Ctrl+C", "退出", &app.theme))
            .collect()
    } else {
        theme::keycap("PgUp", "历史", &app.theme)
            .into_iter()
            .chain(theme::keycap("Ctrl+L", "会话", &app.theme))
            .chain(theme::keycap("Ctrl+N", "新建", &app.theme))
            .chain(theme::keycap("Ctrl+C", "退出", &app.theme))
            .collect()
    };

    let left_w: usize = left.iter().map(|s| UnicodeWidthStr::width(s.content.as_ref())).sum();
    let right_w: usize = right.iter().map(|s| UnicodeWidthStr::width(s.content.as_ref())).sum();

    let mut spans = left;
    if left_w + right_w + 1 < width {
        spans.push(Span::raw(" ".repeat(width - left_w - right_w - 1)));
        spans.append(&mut right);
    }
    f.render_widget(Paragraph::new(Text::from(Line::from(spans))), area);
}

// ---------------------------------------------------------------------------
// Input box (rounded, violet; grows with Shift+Enter lines)
// ---------------------------------------------------------------------------

/// Input box height: 2 border rows + visible text lines, 3..=8 rows.
fn input_height(input: &str) -> u16 {
    let lines = input.lines().count().max(1);
    (2 + lines.min(6)).clamp(3, 8) as u16
}

fn draw_input(f: &mut Frame, app: &mut App, area: Rect) {
    use unicode_width::UnicodeWidthStr;

    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(plain(if app.state == RunState::Busy { app.theme.warn } else { app.theme.violet }));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let all_lines: Vec<&str> = app.input.split('\n').collect();
    let visible = (inner.height as usize).max(1);
    let start = all_lines.len().saturating_sub(visible);
    let avail = inner.width.saturating_sub(3) as usize;

    let mut lines: Vec<Line> = Vec::new();
    let mut cursor_col = inner.x + 2;
    for (i, raw) in all_lines.iter().enumerate().skip(start) {
        // Staged clipboard images show as a count chip on the first line.
        let marker = if i == 0 && !app.pending_images.is_empty() {
            format!("[图×{}] ", app.pending_images.len())
        } else {
            String::new()
        };
        let marker_w = UnicodeWidthStr::width(marker.as_str());
        let disp = tail_by_width(raw, avail.saturating_sub(marker_w));
        let mut spans: Vec<Span> = if i == 0 {
            vec![Span::raw(" "), Span::styled("❯ ", bold(app.theme.accent))]
        } else {
            vec![Span::styled("   ", plain(app.theme.fg))]
        };
        if !marker.is_empty() {
            spans.push(Span::styled(marker.clone(), plain(app.theme.warn)));
        }
        if i == 0 && app.input.is_empty() {
            let hint = if app.image_capable {
                "输入消息…（/ 命令 · !cmd 执行 shell · Shift+Enter 换行 · Ctrl+V 粘贴图片）"
            } else {
                "输入消息…（/ 命令 · !cmd 执行 shell · Shift+Enter 换行）"
            };
            spans.push(Span::styled(hint, plain(app.theme.dim)));
        } else if disp.is_empty() && i != 0 {
            spans.push(Span::styled(" ", plain(app.theme.fg)));
        } else {
            spans.push(Span::styled(disp.clone(), plain(app.theme.fg)));
        }
        if i == all_lines.len() - 1 {
            cursor_col = inner.x
                + 3
                + ((marker_w as u16) + (UnicodeWidthStr::width(disp.as_str()) as u16))
                    .min(inner.width.saturating_sub(4));
        }
        lines.push(Line::from(spans));
    }
    f.render_widget(Paragraph::new(Text::from(lines)), inner);

    if matches!(app.dialog, Dialog::None) {
        let cy = inner.y + (all_lines.len().saturating_sub(start)).saturating_sub(1) as u16;
        f.set_cursor_position((cursor_col, cy));
    }
}

fn tail_by_width(s: &str, max: usize) -> String {
    use unicode_width::UnicodeWidthChar;
    let mut w = 0usize;
    let mut start = s.len();
    for (i, ch) in s.char_indices().rev() {
        let cw = ch.width().unwrap_or(0);
        if w + cw > max {
            break;
        }
        w += cw;
        start = i;
    }
    s[start..].to_string()
}

// ---------------------------------------------------------------------------
// Permission dialog (violet, selection bar style from the mockup)
// ---------------------------------------------------------------------------

fn kind_label(kind: &str) -> &str {
    match kind {
        "allow_once" => "允许一次",
        "allow_always" => "总是允许",
        "reject_once" => "拒绝一次",
        "reject_always" => "总是拒绝",
        other => other,
    }
}

fn draw_permission(f: &mut Frame, app: &App) {
    let Dialog::Permission { tool_title, options, selected, .. } = &app.dialog else {
        return;
    };

    let screen = f.area();
    let height = (options.len() as u16 + 8).clamp(8, screen.height.saturating_sub(2));
    let width = (screen.width * 58 / 100).clamp(44, screen.width.saturating_sub(2));
    let area = centered(screen, width, height);

    f.render_widget(Clear, area);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(plain(app.theme.violet))
        .title(Line::from(vec![
            Span::styled(" ⬡ ", bold(app.theme.violet)),
            Span::styled("权限请求 ", bold(app.theme.violet)),
        ]));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let w = inner.width as usize;
    let mut lines: Vec<Line> = vec![
        Line::from(Span::styled(tool_title.clone(), plain(app.theme.fg).add_modifier(Modifier::BOLD))),
        Line::from(Span::styled("─".repeat(w.saturating_sub(1)), plain(app.theme.hairline))),
        Line::from(""),
    ];
    if options.is_empty() {
        lines.push(Line::from(Span::styled("（无选项 — Esc 拒绝）", plain(app.theme.dim))));
    }
    for (i, o) in options.iter().enumerate() {
        if i == *selected {
            // Full-width violet selection bar.
            let text = format!(" ❯ {} ({}) ", o.name, kind_label(&o.kind));
            let bar = pad_to_width(&text, w.saturating_sub(1));
            lines.push(Line::from(Span::styled(
                bar,
                Style::new().bg(app.theme.violet).fg(app.theme.bar_bg).add_modifier(Modifier::BOLD),
            )));
        } else {
            lines.push(Line::from(Span::styled(
                format!("   {} ({})", o.name, kind_label(&o.kind)),
                plain(app.theme.muted),
            )));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled("─".repeat(w.saturating_sub(1)), plain(app.theme.hairline))));
    lines.push(Line::from(vec![
        Span::styled(" ↑↓ 选择", plain(app.theme.muted)),
        Span::styled(" · ", plain(app.theme.hairline)),
        Span::styled("Enter 确认", plain(app.theme.muted)),
        Span::styled(" · ", plain(app.theme.hairline)),
        Span::styled("Esc 拒绝", plain(app.theme.muted)),
    ]));
    f.render_widget(Paragraph::new(Text::from(lines)), inner);
}

// ---------------------------------------------------------------------------
// Session list overlay
// ---------------------------------------------------------------------------

fn draw_sessions(f: &mut Frame, app: &App) {
    let Dialog::Sessions { items, selected } = &app.dialog else {
        return;
    };

    let screen = f.area();
    let height = (items.len() as u16 + 5).clamp(6, screen.height.saturating_sub(2));
    let width = (screen.width * 66 / 100).clamp(52, screen.width.saturating_sub(2));
    let area = centered(screen, width, height);

    f.render_widget(Clear, area);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(plain(app.theme.accent))
        .title(Line::from(vec![
            Span::styled(" ⬥ ", bold(app.theme.accent)),
            Span::styled(format!("会话列表（{}） ", items.len()), bold(app.theme.accent)),
        ]));
    let inner = block.inner(area);
    f.render_widget(block, area);

    // Scroll window for long session lists.
    let total = items.len();
    let overflow = total + 3 > inner.height as usize;
    let footer = if overflow { 3 } else { 2 };
    let visible = (inner.height as usize).saturating_sub(footer).max(1);
    let top = if *selected < visible { 0 } else { *selected - visible + 1 };
    let end = (top + visible).min(total);

    let mut lines: Vec<Line> = Vec::new();
    if items.is_empty() {
        lines.push(Line::from(Span::styled("（还没有持久化会话）", plain(app.theme.dim))));
    }
    for i in top..end {
        let it = &items[i];
        let is_current = app.session_id.as_deref() == Some(it.session_id.as_str());
        // Prefer the TUI's own title (first prompt), then dsh's deterministic
        // fallback title, then the cwd as a last resort.
        let desc = app
            .local_title(&it.session_id)
            .or_else(|| it.title.clone())
            .unwrap_or_else(|| if it.cwd.is_empty() { "-".into() } else { it.cwd.clone() });
        let desc = crate::acp::clip(&desc, inner.width.saturating_sub(30) as usize);
        let time = it
            .updated_at
            .as_deref()
            .map(rel_time)
            .map(|s| format!("  ·  {s}"))
            .unwrap_or_default();
        let mark = if is_current { "● " } else { "" };
        let base = format!("{mark}{}  {desc}{time}", short_id(&it.session_id));
        if i == *selected {
            let bar = pad_to_width(&format!(" ❯ {base} "), inner.width.saturating_sub(1) as usize);
            lines.push(Line::from(Span::styled(
                bar,
                Style::new().bg(app.theme.violet).fg(app.theme.bar_bg).add_modifier(Modifier::BOLD),
            )));
        } else {
            lines.push(Line::from(Span::styled(format!("   {base}"), plain(app.theme.muted))));
        }
    }
    if total > visible {
        let pct = ((*selected + 1) * 100) / total;
        lines.push(Line::from(Span::styled(
            format!("   · 第 {}/{} 项（{pct}%） ↑↓ 滚动", *selected + 1, total),
            plain(app.theme.hairline),
        )));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::styled(" ↑↓ 选择", plain(app.theme.muted)),
        Span::styled(" · ", plain(app.theme.hairline)),
        Span::styled("Enter 恢复", plain(app.theme.muted)),
        Span::styled(" · ", plain(app.theme.hairline)),
        Span::styled("Esc 关闭", plain(app.theme.muted)),
    ]));
    f.render_widget(Paragraph::new(Text::from(lines)), inner);
}

// ---------------------------------------------------------------------------
// Slash command menu (floating above the input box)
// ---------------------------------------------------------------------------

fn draw_cmd_menu(f: &mut Frame, app: &App, input_area: Rect) {
    use unicode_width::UnicodeWidthStr;

    let items = app.cmd_matches();
    if items.is_empty() || !matches!(app.dialog, Dialog::None) {
        return;
    }
    let rows = crate::app::grouped_menu(&items);
    if rows.is_empty() {
        return;
    }
    let sel = {
        let s = app.cmd_selected.min(rows.len() - 1);
        if matches!(rows[s], crate::app::MenuRow::Cmd(_)) {
            s
        } else {
            rows.iter()
                .position(|r| matches!(r, crate::app::MenuRow::Cmd(_)))
                .unwrap_or(0)
        }
    };

    let screen = f.area();
    let max_w = rows
        .iter()
        .map(|r| match r {
            crate::app::MenuRow::Header(h) => UnicodeWidthStr::width(*h) + 4,
            crate::app::MenuRow::Cmd(c) => {
                c.name.len() + UnicodeWidthStr::width(c.desc) + 6
            }
        })
        .max()
        .unwrap_or(30);
    let w = (max_w as u16).clamp(28, 60).min(screen.width.saturating_sub(2));
    let h = (rows.len() as u16 + 2).min(11);
    let x = (input_area.x + 1).min(screen.width.saturating_sub(w));
    let y = input_area.y.saturating_sub(h);
    if y < screen.y || h < 3 {
        return;
    }
    let area = Rect { x, y, width: w, height: h };

    f.render_widget(Clear, area);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(plain(app.theme.accent))
        .title(Span::styled(" 命令 ", bold(app.theme.accent)));
    let inner = block.inner(area);
    f.render_widget(block, area);

    // Scroll window so the selection stays visible in a tall menu.
    let total = rows.len();
    let visible = (inner.height as usize).saturating_sub(2).max(1);
    let top = if sel < visible { 0 } else { sel - visible + 1 };
    let end = (top + visible).min(total);

    let mut lines: Vec<Line> = Vec::new();
    for (i, row) in rows.iter().enumerate().skip(top).take(end - top) {
        match row {
            crate::app::MenuRow::Header(h) => {
                lines.push(Line::from(Span::styled(
                    format!("  {} ", h),
                    plain(app.theme.hairline).add_modifier(Modifier::BOLD),
                )));
            }
            crate::app::MenuRow::Cmd(c) => {
                let busy_mark =
                    if c.idle_only && app.state == RunState::Busy { " [忙时禁用]" } else { "" };
                if i == sel {
                    let bar = pad_to_width(
                        &format!(" ❯ {:<8} {}{} ", c.name, c.desc, busy_mark),
                        inner.width.saturating_sub(1) as usize,
                    );
                    lines.push(Line::from(Span::styled(
                        bar,
                        Style::new().bg(app.theme.violet).fg(app.theme.bar_bg).add_modifier(Modifier::BOLD),
                    )));
                } else {
                    lines.push(Line::from(vec![
                        Span::styled(format!("   {}", c.name), plain(app.theme.fg)),
                        Span::styled(
                            format!("  {}{}", c.desc, busy_mark),
                            plain(if c.idle_only && app.state == RunState::Busy { app.theme.dim } else { app.theme.muted }),
                        ),
                    ]));
                }
            }
        }
    }
    f.render_widget(Paragraph::new(Text::from(lines)), inner);
}

// ---------------------------------------------------------------------------
// Config dialog (model / reasoning effort picker)
// ---------------------------------------------------------------------------

fn draw_config(f: &mut Frame, app: &App) {
    let Dialog::Config { title, current, choices, selected, .. } = &app.dialog else {
        return;
    };

    let screen = f.area();
    let height = (choices.len() as u16 + 5).clamp(8, screen.height.saturating_sub(2));
    let width = (screen.width * 56 / 100).clamp(46, screen.width.saturating_sub(2));
    let area = centered(screen, width, height);

    f.render_widget(Clear, area);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(plain(app.theme.violet))
        .title(Line::from(vec![
            Span::styled(" ⬡ ", bold(app.theme.violet)),
            Span::styled(format!("{title}（{}） ", choices.len()), bold(app.theme.violet)),
        ]));
    let inner = block.inner(area);
    f.render_widget(block, area);

    // Scroll window: keep the selection visible when the catalog overflows
    // the dialog (the synced model list now spans every provider).
    let total = choices.len();
    let overflow = total + 3 > inner.height as usize;
    let footer = if overflow { 3 } else { 2 };
    let visible = (inner.height as usize).saturating_sub(footer).max(1);
    let top = if *selected < visible { 0 } else { *selected - visible + 1 };
    let end = (top + visible).min(total);

    let mut lines: Vec<Line> = Vec::new();
    for i in top..end {
        let c = &choices[i];
        let is_current = c.value == *current;
        let desc = c
            .description
            .as_deref()
            .map(|d| format!("  —  {}", crate::acp::clip(d, 60)))
            .unwrap_or_default();
        if i == *selected {
            let name = if is_current { format!("{}（当前）", c.name) } else { c.name.clone() };
            let bar = pad_to_width(
                &format!(" ❯ {name}{desc} "),
                inner.width.saturating_sub(1) as usize,
            );
            lines.push(Line::from(Span::styled(
                bar,
                Style::new().bg(app.theme.violet).fg(app.theme.bar_bg).add_modifier(Modifier::BOLD),
            )));
        } else {
            let name = if is_current { format!("{}（当前）", c.name) } else { c.name.clone() };
            lines.push(Line::from(Span::styled(
                format!("   {name}{desc}"),
                plain(app.theme.muted),
            )));
        }
    }
    if total > visible {
        let pct = ((*selected + 1) * 100) / total;
        lines.push(Line::from(Span::styled(
            format!("   · 第 {}/{} 项（{pct}%） ↑↓ 滚动", *selected + 1, total),
            plain(app.theme.hairline),
        )));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::styled(" ↑↓ 选择", plain(app.theme.muted)),
        Span::styled(" · ", plain(app.theme.hairline)),
        Span::styled("Enter 应用", plain(app.theme.muted)),
        Span::styled(" · ", plain(app.theme.hairline)),
        Span::styled("Esc 取消", plain(app.theme.muted)),
    ]));
    f.render_widget(Paragraph::new(Text::from(lines)), inner);
}

// ---------------------------------------------------------------------------
// Info panel (/help /status /cost) — scrollable text
// ---------------------------------------------------------------------------

fn draw_info(f: &mut Frame, app: &App) {
    let Dialog::Info { title, lines, selected } = &app.dialog else {
        return;
    };

    let screen = f.area();
    let height = (lines.len() as u16 + 5).clamp(10, screen.height.saturating_sub(2));
    let width = (screen.width * 74 / 100).clamp(52, screen.width.saturating_sub(2));
    let area = centered(screen, width, height);

    f.render_widget(Clear, area);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(plain(app.theme.accent))
        .title(Line::from(vec![
            Span::styled(" ⬥ ", bold(app.theme.accent)),
            Span::styled(format!("{title} "), bold(app.theme.accent)),
        ]));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let total = lines.len();
    let overflow = total + 3 > inner.height as usize;
    let footer = if overflow { 3 } else { 2 };
    let visible = (inner.height as usize).saturating_sub(footer).max(1);
    let top = if *selected < visible { 0 } else { *selected - visible + 1 };
    let end = (top + visible).min(total);

    let mut text_lines: Vec<Line> = Vec::new();
    for i in top..end {
        let line = &lines[i];
        let styled: Line = if line.starts_with("  ") {
            Line::from(Span::styled(line.clone(), plain(app.theme.muted)))
        } else {
            Line::from(Span::styled(line.clone(), plain(app.theme.fg)))
        };
        text_lines.push(styled);
    }
    if total > visible {
        let pct = ((*selected + 1) * 100) / total;
        text_lines.push(Line::from(Span::styled(
            format!("   · 第 {}/{} 行（{pct}%）", *selected + 1, total),
            plain(app.theme.hairline),
        )));
    }
    text_lines.push(Line::from(""));
    text_lines.push(Line::from(vec![
        Span::styled(" ↑↓ 滚动", plain(app.theme.muted)),
        Span::styled(" · ", plain(app.theme.hairline)),
        Span::styled("PgUp/PgDn 翻页", plain(app.theme.muted)),
        Span::styled(" · ", plain(app.theme.hairline)),
        Span::styled("Esc 关闭", plain(app.theme.muted)),
    ]));
    f.render_widget(Paragraph::new(Text::from(text_lines)), inner);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn pad_to_width(text: &str, width: usize) -> String {
    use unicode_width::UnicodeWidthStr;
    let tw = UnicodeWidthStr::width(text);
    if tw >= width {
        text.to_string()
    } else {
        format!("{text}{}", " ".repeat(width - tw))
    }
}

fn centered(screen: Rect, width: u16, height: u16) -> Rect {
    let w = width.min(screen.width);
    let h = height.min(screen.height);
    Rect {
        x: screen.x + (screen.width.saturating_sub(w)) / 2,
        y: screen.y + (screen.height.saturating_sub(h)) / 2,
        width: w,
        height: h,
    }
}
