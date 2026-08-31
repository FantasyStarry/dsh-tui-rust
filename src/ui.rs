//! ratatui rendering. Visual language follows the generated mockups:
//! gradient whale top bar, blue `❯` user prompts, dim italic thinking,
//! tool lines with colored status dots, hairline turn separators,
//! rounded violet input box, violet selection bars in dialogs.

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, BorderType, Clear, Paragraph};
use ratatui::Frame;
use std::time::Instant;

use crate::acp::short_id;
use crate::app::{App, Dialog, RunState};
use crate::theme::{self, *};

/// Draw one frame. Call from the event loop after each batch of events.
pub fn draw(terminal: &mut ratatui::DefaultTerminal, app: &mut App) -> std::io::Result<()> {
    terminal.draw(|f| render(f, app)).map(|_| ())
}

fn render(f: &mut Frame, app: &mut App) {
    let chunks = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(3),
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
    left.extend(theme::gradient_word("DSH·TUI"));
    left.push(Span::styled("  v0.1", plain(DIM)));

    let mut right: Vec<Span> = Vec::new();
    if let Some(m) = app.model_label() {
        right.push(theme::pill(&m, VIOLET));
        right.push(Span::raw(" "));
    }
    if let Some((used, size)) = app.usage {
        right.push(Span::styled("ctx", plain(MUTED)));
        right.extend(theme::ctx_bar(used, size, 10));
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
    put(f, -2, Line::from(gradient_word("D S H · T U I")), true);
    put(f, -1, Line::from(Span::styled("～ deep agents in your terminal ～", plain(DIM))), true);
    put(f, 1, Line::from(vec![
        Span::styled(format!("{spinner} "), plain(VIOLET)),
        Span::styled("正在连接 dsh 内核（--profile acp）…", plain(MUTED)),
    ]), true);
    put(f, 2, Line::from(Span::styled("输入消息后回车发送 · /list 会话 · /new 新会话 · Ctrl+C 退出", plain(DIM))), true);
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
    let (dot, label) = match app.state {
        RunState::Booting => (DIM, "启动中"),
        RunState::Idle => (OK, "就绪"),
        RunState::Busy => (WARN, "运行中"),
    };
    left.push(Span::styled("● ", plain(dot)));
    if app.state == RunState::Busy {
        let elapsed = app.busy_since.map(|t| t.elapsed().as_secs_f32()).unwrap_or(0.0);
        let spinner = SPINNER[((elapsed * 8.0) as usize) % SPINNER.len()];
        left.push(Span::styled(format!("{spinner} "), plain(VIOLET)));
        left.push(Span::styled(format!("{label} {:.0}s", elapsed), bold(WARN)));
        left.push(Span::styled(" · Esc 取消", plain(MUTED)));
    } else {
        left.push(Span::styled(label, plain(FG)));
    }
    if app.scroll_from_bottom > 0 {
        left.push(Span::styled(format!(" · ↑{} 行", app.scroll_from_bottom), plain(WARN)));
    }
    if app.queue_len() > 0 {
        left.push(Span::styled(format!(" · 队列 {}", app.queue_len()), plain(WARN)));
    }
    if let Some(sid) = &app.session_id {
        left.push(Span::styled(format!(" · {}", short_id(sid)), plain(DIM)));
    }

    let mut right: Vec<Span> = if app.state == RunState::Busy {
        theme::keycap("Esc", "取消")
            .into_iter()
            .chain(theme::keycap("Ctrl+C", "退出"))
            .collect()
    } else {
        theme::keycap("PgUp", "历史")
            .into_iter()
            .chain(theme::keycap("Ctrl+L", "会话"))
            .chain(theme::keycap("Ctrl+N", "新建"))
            .chain(theme::keycap("Ctrl+C", "退出"))
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
// Input box (rounded, violet; placeholder when empty)
// ---------------------------------------------------------------------------

fn draw_input(f: &mut Frame, app: &mut App, area: Rect) {
    use unicode_width::UnicodeWidthStr;

    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(plain(if app.state == RunState::Busy { WARN } else { VIOLET }));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let avail = inner.width.saturating_sub(3) as usize;
    let disp = tail_by_width(&app.input, avail);

    let mut spans: Vec<Span> = vec![Span::raw(" "), Span::styled("❯ ", bold(ACCENT))];
    if app.input.is_empty() {
        spans.push(Span::styled(
            "输入消息…（/list 会话 · /new 新建 · Esc 清空）",
            plain(DIM),
        ));
    } else {
        spans.push(Span::styled(disp.clone(), plain(FG)));
    }
    f.render_widget(Paragraph::new(Text::from(Line::from(spans))), inner);

    if matches!(app.dialog, Dialog::None) {
        let text_w: usize = UnicodeWidthStr::width(disp.as_str());
        let cx = inner.x + 3 + (text_w as u16).min(inner.width.saturating_sub(4));
        f.set_cursor_position((cx, inner.y));
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
        .border_style(plain(VIOLET))
        .title(Line::from(vec![
            Span::styled(" ⬡ ", bold(VIOLET)),
            Span::styled("权限请求 ", bold(VIOLET)),
        ]));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let w = inner.width as usize;
    let mut lines: Vec<Line> = vec![
        Line::from(Span::styled(tool_title.clone(), plain(FG).add_modifier(Modifier::BOLD))),
        Line::from(Span::styled("─".repeat(w.saturating_sub(1)), plain(HAIRLINE))),
        Line::from(""),
    ];
    if options.is_empty() {
        lines.push(Line::from(Span::styled("（无选项 — Esc 拒绝）", plain(DIM))));
    }
    for (i, o) in options.iter().enumerate() {
        if i == *selected {
            // Full-width violet selection bar.
            let text = format!(" ❯ {} ({}) ", o.name, kind_label(&o.kind));
            let bar = pad_to_width(&text, w.saturating_sub(1));
            lines.push(Line::from(Span::styled(
                bar,
                Style::new().bg(VIOLET).fg(BAR_BG).add_modifier(Modifier::BOLD),
            )));
        } else {
            lines.push(Line::from(Span::styled(
                format!("   {} ({})", o.name, kind_label(&o.kind)),
                plain(MUTED),
            )));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled("─".repeat(w.saturating_sub(1)), plain(HAIRLINE))));
    lines.push(Line::from(vec![
        Span::styled(" ↑↓ 选择", plain(MUTED)),
        Span::styled(" · ", plain(HAIRLINE)),
        Span::styled("Enter 确认", plain(MUTED)),
        Span::styled(" · ", plain(HAIRLINE)),
        Span::styled("Esc 拒绝", plain(MUTED)),
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
        .border_style(plain(ACCENT))
        .title(Line::from(vec![
            Span::styled(" ⬥ ", bold(ACCENT)),
            Span::styled(format!("会话列表（{}） ", items.len()), bold(ACCENT)),
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
        lines.push(Line::from(Span::styled("（还没有持久化会话）", plain(DIM))));
    }
    for i in top..end {
        let it = &items[i];
        let desc = it
            .title
            .clone()
            .unwrap_or_else(|| if it.cwd.is_empty() { "-".into() } else { it.cwd.clone() });
        let time = it
            .updated_at
            .as_deref()
            .map(|s| format!("  ·  {s}"))
            .unwrap_or_default();
        let base = format!("{}  {desc}{time}", short_id(&it.session_id));
        if i == *selected {
            let bar = pad_to_width(&format!(" ❯ {base} "), inner.width.saturating_sub(1) as usize);
            lines.push(Line::from(Span::styled(
                bar,
                Style::new().bg(VIOLET).fg(BAR_BG).add_modifier(Modifier::BOLD),
            )));
        } else {
            lines.push(Line::from(Span::styled(format!("   {base}"), plain(MUTED))));
        }
    }
    if total > visible {
        let pct = ((*selected + 1) * 100) / total;
        lines.push(Line::from(Span::styled(
            format!("   · 第 {}/{} 项（{pct}%） ↑↓ 滚动", *selected + 1, total),
            plain(HAIRLINE),
        )));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::styled(" ↑↓ 选择", plain(MUTED)),
        Span::styled(" · ", plain(HAIRLINE)),
        Span::styled("Enter 恢复", plain(MUTED)),
        Span::styled(" · ", plain(HAIRLINE)),
        Span::styled("Esc 关闭", plain(MUTED)),
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
    let sel = app.cmd_selected.min(items.len() - 1);

    let screen = f.area();
    let w = (items
        .iter()
        .map(|c| c.name.len() + UnicodeWidthStr::width(c.desc) + 6)
        .max()
        .unwrap_or(30) as u16)
        .clamp(24, 60)
        .min(screen.width.saturating_sub(2));
    let h = (items.len() as u16 + 2).min(9);
    let x = (input_area.x + 1).min(screen.width.saturating_sub(w));
    let y = input_area.y.saturating_sub(h);
    if y < screen.y || h < 3 {
        return;
    }
    let area = Rect { x, y, width: w, height: h };

    f.render_widget(Clear, area);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(plain(ACCENT))
        .title(Span::styled(" 命令 ", bold(ACCENT)));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let mut lines: Vec<Line> = Vec::new();
    for (i, c) in items.iter().enumerate() {
        if i == sel {
            let bar = pad_to_width(
                &format!(" ❯ {:<8} {} ", c.name, c.desc),
                inner.width.saturating_sub(1) as usize,
            );
            lines.push(Line::from(Span::styled(
                bar,
                Style::new().bg(VIOLET).fg(BAR_BG).add_modifier(Modifier::BOLD),
            )));
        } else {
            lines.push(Line::from(vec![
                Span::styled(format!("   {}", c.name), plain(FG)),
                Span::styled(format!("  {}", c.desc), plain(DIM)),
            ]));
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
        .border_style(plain(VIOLET))
        .title(Line::from(vec![
            Span::styled(" ⬡ ", bold(VIOLET)),
            Span::styled(format!("{title}（{}） ", choices.len()), bold(VIOLET)),
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
                Style::new().bg(VIOLET).fg(BAR_BG).add_modifier(Modifier::BOLD),
            )));
        } else {
            let name = if is_current { format!("{}（当前）", c.name) } else { c.name.clone() };
            lines.push(Line::from(Span::styled(
                format!("   {name}{desc}"),
                plain(MUTED),
            )));
        }
    }
    if total > visible {
        let pct = ((*selected + 1) * 100) / total;
        lines.push(Line::from(Span::styled(
            format!("   · 第 {}/{} 项（{pct}%） ↑↓ 滚动", *selected + 1, total),
            plain(HAIRLINE),
        )));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::styled(" ↑↓ 选择", plain(MUTED)),
        Span::styled(" · ", plain(HAIRLINE)),
        Span::styled("Enter 应用", plain(MUTED)),
        Span::styled(" · ", plain(HAIRLINE)),
        Span::styled("Esc 取消", plain(MUTED)),
    ]));
    f.render_widget(Paragraph::new(Text::from(lines)), inner);
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
