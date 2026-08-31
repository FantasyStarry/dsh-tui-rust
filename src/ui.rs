//! ratatui rendering: transcript, status line, input box, and overlays.

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Clear, Paragraph};
use ratatui::Frame;

use crate::acp::short_id;
use crate::app::{App, Dialog, EntryKind, RunState};

/// Draw one frame. Call from the event loop after each batch of events.
pub fn draw(
    terminal: &mut ratatui::DefaultTerminal,
    app: &mut App,
) -> std::io::Result<()> {
    terminal.draw(|f| render(f, app)).map(|_| ())
}

fn render(f: &mut Frame, app: &mut App) {
    let chunks = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(3),
    ])
    .split(f.area());

    draw_transcript(f, app, chunks[0]);
    draw_status(f, app, chunks[1]);
    draw_input(f, app, chunks[2]);

    match &app.dialog {
        Dialog::Permission { .. } => draw_permission(f, app),
        Dialog::Sessions { .. } => draw_sessions(f, app),
        Dialog::None => {}
    }
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

fn style_for(kind: EntryKind) -> Style {
    match kind {
        EntryKind::User => Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
        EntryKind::Agent => Style::default(),
        EntryKind::Thought => Style::default().fg(Color::DarkGray),
        EntryKind::Tool => Style::default().fg(Color::Cyan),
        EntryKind::System => Style::default().fg(Color::DarkGray),
    }
}

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
        .map(|(kind, s)| Line::from(Span::styled(s.clone(), style_for(*kind))))
        .collect();
    f.render_widget(Paragraph::new(Text::from(lines)), inner);
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

fn draw_status(f: &mut Frame, app: &App, area: Rect) {
    use unicode_width::UnicodeWidthStr;

    let (state_text, state_color) = match app.state {
        RunState::Booting => ("◌ 启动中", Color::DarkGray),
        RunState::Idle => ("● 就绪", Color::Green),
        RunState::Busy => ("● 运行中 (Esc 取消)", Color::Yellow),
    };

    let mut mid = String::new();
    if let Some(m) = &app.model {
        mid.push_str(&format!(" · {m}"));
    }
    if let Some((used, size)) = app.usage {
        let pct = if size > 0 { used as f64 / size as f64 * 100.0 } else { 0.0 };
        mid.push_str(&format!(" · 上下文 {pct:.0}%"));
    }
    if let Some(sid) = &app.session_id {
        mid.push_str(&format!(" · {}", short_id(sid)));
    }

    let right = "PgUp/PgDn 滚动 · Ctrl+L 会话 · Ctrl+N 新建 · Ctrl+C 退出";
    let used_w = UnicodeWidthStr::width(state_text)
        + UnicodeWidthStr::width(mid.as_str())
        + UnicodeWidthStr::width(right);
    let pad = if used_w + 2 < area.width as usize {
        " ".repeat(area.width as usize - used_w - 1)
    } else {
        String::new()
    };

    let line = Line::from(vec![
        Span::styled(state_text, Style::default().fg(state_color)),
        Span::raw(mid),
        Span::raw(pad),
        Span::styled(right, Style::default().fg(Color::DarkGray)),
    ]);
    f.render_widget(Paragraph::new(Text::from(line)), area);
}

// ---------------------------------------------------------------------------
// Input box
// ---------------------------------------------------------------------------

fn draw_input(f: &mut Frame, app: &mut App, area: Rect) {
    use unicode_width::UnicodeWidthChar;

    let block = Block::bordered().title(Span::styled(
        " 输入 ",
        Style::default().fg(Color::Blue),
    ));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let avail = inner.width.saturating_sub(2) as usize;
    let disp = tail_by_width(&app.input, avail);
    f.render_widget(Paragraph::new(format!("> {disp}")), inner);

    if matches!(app.dialog, Dialog::None) {
        let text_w: usize = disp.chars().map(|c| c.width().unwrap_or(0)).sum();
        let cx = inner.x + 2 + (text_w as u16).min(inner.width.saturating_sub(3));
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
// Permission dialog
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
    let height = (options.len() as u16 + 7).clamp(6, screen.height.saturating_sub(2));
    let width = (screen.width * 62 / 100).max(40).min(screen.width.saturating_sub(2));
    let area = centered(screen, width, height);

    f.render_widget(Clear, area);
    let block = Block::bordered().title(Span::styled(
        " 权限请求 ",
        Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
    ));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let mut lines = vec![
        Line::from(Span::styled(
            tool_title.clone(),
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
    ];
    if options.is_empty() {
        lines.push(Line::from("（无选项 — Esc 拒绝）"));
    } else {
        for (i, o) in options.iter().enumerate() {
            let marker = if i == *selected { "▶ " } else { "  " };
            let style = if i == *selected {
                Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            lines.push(Line::from(Span::styled(
                format!("{marker}{} ({})", o.name, kind_label(&o.kind)),
                style,
            )));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "↑↓ 选择 · Enter 确认 · Esc 拒绝",
        Style::default().fg(Color::DarkGray),
    )));
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
    let height = (items.len() as u16 + 4).clamp(5, screen.height.saturating_sub(2));
    let width = (screen.width * 70 / 100).max(50).min(screen.width.saturating_sub(2));
    let area = centered(screen, width, height);

    f.render_widget(Clear, area);
    let block = Block::bordered().title(Span::styled(
        format!(" 会话列表（{}） ", items.len()),
        Style::default().fg(Color::Blue).add_modifier(Modifier::BOLD),
    ));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let mut lines = Vec::new();
    if items.is_empty() {
        lines.push(Line::from("（还没有持久化会话）"));
    }
    for (i, it) in items.iter().enumerate() {
        let marker = if i == *selected { "▶ " } else { "  " };
        let style = if i == *selected {
            Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        let desc = it
            .title
            .clone()
            .unwrap_or_else(|| if it.cwd.is_empty() { "-".into() } else { it.cwd.clone() });
        let extra = it
            .updated_at
            .as_deref()
            .map(|s| format!("  {s}"))
            .unwrap_or_default();
        lines.push(Line::from(Span::styled(
            format!("{marker}{}  {}{extra}", short_id(&it.session_id), desc),
            style,
        )));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "↑↓ 选择 · Enter 恢复 · Esc 关闭",
        Style::default().fg(Color::DarkGray),
    )));
    f.render_widget(Paragraph::new(Text::from(lines)), inner);
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
