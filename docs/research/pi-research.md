# dsh-tui-rust 调研报告：earendil-works/pi 的 TUI / UX 设计（供 ratatui 客户端借鉴）

> 全部材料来自公开网页/源码浏览（未 clone 仓库）。仓库地址：https://github.com/earendil-works/pi （默认分支 main，v0.84.4 时代）。包目录：`packages/tui`（pi-tui）、`packages/agent`（pi-agent-core）、`packages/ai`（pi-ai）、`packages/coding-agent`（pi-coding-agent）。

---

## 0. 仓库概览

顶层 [README](https://github.com/earendil-works/pi/blob/main/README.md) 将项目定位为 "Pi Agent Harness"：

- **pi-ai**：统一多提供商 LLM API（OpenAI/Anthropic/Google/DeepSeek 等 30+ 提供商），自带模型目录、认证解析（env/凭据/OAuth）、token 与成本统计、跨提供商上下文交接。见 [packages/ai/README.md](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)。
- **pi-agent-core**：带工具调用与状态管理的 Agent 运行时。
- **pi-coding-agent**：交互式编码 Agent CLI（即 `pi` 命令）。
- **pi-tui**：带差分渲染的终端 UI 库。

关键设计哲学（来自 [coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) 的 Philosophy 一节）：**不做**内置 MCP、子代理、权限弹窗、计划模式、todo、后台 bash——这些全部留给扩展/包/外部工具（tmux、容器），核心保持最小、可通过 TypeScript 扩展（extensions）深度定制 UI。

---

## 1. pi-tui 包

### 1.1 定位与依赖

[pi-tui README](https://github.com/earendil-works/pi/blob/main/packages/tui/README.md) 自述为 "Minimal terminal UI framework with differential rendering and synchronized output for flicker-free interactive CLI applications"。依赖极少（[package.json](https://github.com/earendil-works/pi/blob/main/packages/tui/package.json)）：`marked` 18.x（Markdown 解析）+ `get-east-asian-width`（宽度计算）。语法高亮不在库内，通过 `highlightCode` 回调注入（coding-agent 侧用 `highlight.js` 10.7.3，见其 [package.json](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json)）。另有 `native/` 目录（Windows/macOS 原生小模块，用于剪贴板/原生修饰键等）。

### 1.2 差分渲染方法（这是核心）

- **组件接口极简**：`Component { render(width): string[]; handleInput?(data); invalidate?() }`。`render(width)` 返回"每行一个字符串"的数组，**每行不得超过 width**（否则报错），用 `truncateToWidth()`/`wrapTextWithAnsi()` 保证。TUI 在每行末尾追加完整 SGR reset + OSC 8 reset，样式不跨行。
- **主屏渲染器 `TuiMainScreen`（regular 模式）三种策略**：
  1. 首次渲染：全部输出、不清滚动缓冲；
  2. 宽度变化或"变更点在上方视口之外"：清屏整帧重绘；
  3. 常规更新：把光标移到第一处变更行 → 清到行尾 → 只重绘变更行（"move the cursor to the first changed line, clear to the end, and render changed lines"）。
- **备用屏渲染器 `TuiAltScreen`（fullscreen 模式）**：固定高度视口，按"变更的行/视口行"就地更新（in-place row updates）；跟随流式输出（停在底部时），手动滚动时保持位置；支持 `VStack/HStack/ScrollView` 布局根（`basis/grow/shrink/minSize`），ScrollView 拥有应用侧滚动；支持鼠标滚轮、OSC 133 prompt marker 跳转、`Ctrl+Shift+F` 搜索、OSC 8 超链接点击、OSC 52 选择复制。
- **同步输出（防闪烁）**：两次更新都包在 `\x1b[?2026h` … `\x1b[?2026l`（CSI 2026 synchronized output）里做原子屏幕更新。
- **组件级缓存**：组件自己缓存 `render(width)` 结果（按 width 为 key），状态变化时调 `invalidate()` 清缓存，再 `tui.requestRender()` 请求重绘。主题切换时 TUI 会对所有组件调 `invalidate()`（所以"预先烘焙主题颜色"的组件必须在 invalidate 里重建内容，[tui.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md) 有专门章节讲这个坑）。
- 调试：`PI_TUI_WRITE_LOG=/path` 可把写出的原始 ANSI 流落盘。
- 另支持 bracketed paste（>10 行粘贴折叠成 `[paste #1 +50 lines]` 标记）、Kitty/iTerm2 内联图片、Focusable/IME（用零宽 `CURSOR_MARKER` 定位硬件光标，`PI_HARDWARE_CURSOR=1`）。

**与 ratatui 的对应**：pi 是"自绘 ANSI 字符串 + 差分刷新"，ratatui 是"buffer-cell 差分 + `Frame` 重绘"——两者理念一致（只刷变更区域），ratatui 的 `ratatui::backend` 天然做 cell 差分。可直接借鉴的是**策略 3**（光标定位到首个变更行、只重绘变更行）与 **CSI 2026**（ratatui 0.26+ 的 `Backend` 尚无内建，但可自行在 paint 前后输出同步序列）。

### 1.3 内置组件（[src/components](https://github.com/earendil-works/pi/tree/main/packages/tui/src/components)）

`Text`（多行自动换行+padding）、`TruncatedText`（单行截断，适合状态栏）、`Input`（单行，横向滚动）、`Editor`（多行编辑器：自动换行、斜杠命令补全、Tab 路径补全、粘贴折叠、**伪光标**（隐藏真实光标）、历史浏览、kill-ring/undo）、`Markdown`（见 1.4）、`Loader`/`CancellableLoader`（spinner + Escape 取消 + AbortSignal）、`SelectList`（可搜索选择列表，`{value,label,description}`）、`SettingsList`（设置项循环/子菜单）、`Spacer`、`Image`（Kitty/iTerm2 内联图）、`Box`/`Container`/`VStack`/`HStack`/`ScrollView`。另有 `autocomplete.ts`（`CombinedAutocompleteProvider`：`/` 斜杠命令 + `Tab` 路径 + `@` 文件引用）、`fuzzy.ts`、`undo-stack.ts`、`kill-ring.ts`、`keys.ts`（Kitty 键盘协议解析 + `matchesKey`）、`terminal-image.ts`、`tui-alt-screen.ts`（含搜索）等。

### 1.4 Markdown 渲染与语法高亮

`Markdown` 组件：`marked` 解析 → 按 `MarkdownTheme`（heading/link/code/codeBlock/quote/hr/listBullet/bold/italic/strikethrough/underline + 可选 `highlightCode`）着色；HTML 标签按纯文本渲染；带 padding 与渲染缓存。**语法高亮是外部注入的**：coding-agent 通过 `highlightCode` 回调实现，并额外做了 mermaid 图渲染（`grok-mermaid` 依赖 + `markdown.mermaid` 设置：`off|final|streaming`，流式渲染 mermaid）。

### 1.5 coding-agent 如何使用 pi-tui

见 [coding-agent docs/tui.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md)（TUI 组件文档，面向扩展作者）：

- 消息区 = 一列组件：`UserMessage`、`AssistantMessage`（Markdown）、`ToolExecutionComponent`（工具调用框）、`BashExecutionComponent`、`CompactionSummaryMessage`、`BranchSummaryMessage`、`CustomMessage` 等，全部是 pi-tui `Component`（源码在 [src/modes/interactive/components/](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/modes/interactive/components)）。
- 扩展可：`ctx.ui.custom()` 打开自定义 UI（全屏或 `{overlay:true}` 覆盖层，支持锚点/百分比定位/响应式可见性）、`setWidget()` 在编辑器上下加常驻行、`setStatus()` 往页脚塞状态、`setFooter()` 整体替换页脚、`setEditorComponent()` 替换输入编辑器（官方例子是 vim 模式编辑器）、`setWorkingIndicator()` 自定义流式中的工作指示动画（默认是一个 spinner 帧序列）。
- 标准件：`DynamicBorder`（动态边框）、`BorderedLoader`、`getMarkdownTheme()`、`getSettingsListTheme()`，来自 `@earendil-works/pi-coding-agent` 的导出。

---

## 2. pi-coding-agent 交互 UX

### 2.1 界面布局（[README 交互模式一节](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) 与 [usage.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md)）

自上而下四块：**启动头**（快捷键提示、加载的 AGENTS.md/prompts/skills/extensions，`quietStartup` 可关）→ **消息区**（用户消息、assistant 回复、工具调用与结果、通知、错误、扩展 UI）→ **编辑器**（边框颜色=当前思考档位）→ **页脚**（工作目录、会话名、token/缓存用量、成本、上下文占用、当前模型）。

### 2.2 编辑器

`@` 模糊搜索项目文件、Tab 路径补全、Shift+Enter 多行、Ctrl+G 外部编辑器、Ctrl+V 粘贴图片、**`!command` 跑命令并把输出发给模型 / `!!command` 只跑不发**。标准编辑键（删词、undo、kill-ring）。命令补全：输入 `/` 弹出。

### 2.3 斜杠命令（[README 命令表](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)）

`/login /logout`、`/llama`、`/model`（Ctrl+S 存为启动默认）、`/thinking`、`/scoped-models`、`/settings`、`/resume`、`/new`、`/name <n>`、`/session`（显示会话文件/ID/消息数/token/成本）、`/tree`、`/trust`、`/fork`、`/clone`、`/compact [prompt]`、`/copy`、`/export [file]`（HTML/JSONL）、`/import <file>`、`/share`、`/reload`、`/hotkeys`、`/changelog`、`/quit`。注意 **没有 `/cost`、`/clear`、`/exit`**：成本常驻页脚、`/session` 可查；"clear" 由 Ctrl+C（清编辑器/再按退出）承担；退出是 `/quit` 或 Ctrl+D。扩展可注册自定义命令，技能为 `/skill:name`，prompt 模板为 `/template`。

### 2.4 shell `!` 命令

见 [README Editor 表](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)：`!command` 运行并把输出作为上下文发给模型（会话里落成 `BashExecutionMessage`，含 `command/output/exitCode/cancelled/truncated/fullOutputPath`，`truncated` 表示大输出被截断、`fullOutputPath` 指向完整输出文件）；`!!command` 只执行不上送（`excludeFromContext: true`）。编辑器进入 bash 模式时边框用主题的 `bashMode` 颜色。

### 2.5 权限 / 确认 UX

**明确无内置权限弹窗**（README Philosophy："No permission popups. Run in a container, or build your own confirmation flow with extensions"；顶层 README 的 Permissions 一节：默认以启动它的用户权限运行，要边界就容器化，见 [containerization.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md) 的 Gondolin 扩展 / Docker / OpenShell 三种模式）。唯一的"信任"型确认是**项目信任流**：启动时若项目含 `.pi/settings.json`、`.pi` 资源或 `.agents/skills` 且无已存决定，则询问是否信任（写入 `~/.pi/agent/trust.json`；`defaultProjectTrust` = `ask|always|never`；CLI `--approve/-a`、`--no-approve/-na`；`/trust` 保存决定）。非交互模式不弹提示。这给了 dsh-tui-rust 一个启示：**DSH kernel 的 ACP 权限请求（tool use 确认）可以做成 pi 风格的"覆盖层模态 + 记忆化决定"而不是每次都打断**。

### 2.6 会话存储与恢复

- **存储**：自动存为 JSONL，路径 `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`（`<path>` 为 cwd，`/` 替换为 `-`），按工作目录分目录。`--no-session` 临时模式、`--session-dir` 自定义目录、设置 `sessionDir`。
- **格式**（[session-format.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)）：首行 `SessionHeader`（version/cwd/uuid/parentSession），后续每行一个 entry，全部带 `id` + `parentId`，构成**树**（同一文件内分支，无需新文件）。entry 类型：`message`（user/assistant/toolResult 及扩展角色）、`bash_execution`、`model_change`、`thinking_level_change`、`compaction`、`branch_summary`、`custom`（扩展状态，不进 LLM 上下文）、`custom_message`、`label`（书签）、`session_info`（显示名）。自动迁移 v1(线性)→v2(树)→v3(角色改名)。AssistantMessage 记录 `api/provider/model/usage/stopReason`；`Usage` = `{input, output, cacheRead, cacheWrite, totalTokens, cost{input,output,cacheRead,cacheWrite,total}}`。
- **恢复/管理**：`pi -c`（继续最近）、`pi -r`（浏览选择）、`--session <path|id>`、`--fork <path|id>`。交互内 `/resume` 打开**会话选择器**：可打字搜索、Ctrl+P 切换路径显示、Ctrl+S 排序、Ctrl+N 只看命名会话、Ctrl+R 重命名、Ctrl+D 删除（有 trash CLI 时走 trash）。
- **分支**：`/tree` 在文件内跳转/分支（树形 UI，可折叠、按 filter 模式：default/no-tools/user-only/labeled-only/all，Shift+L 打标签，Ctrl+X 复制消息）；`/fork` 从历史 user 消息开新会话文件；`/clone` 复制当前分支为新文件。`/tree` 离开分支时可选择"生成分支摘要"（branch summary）保留上下文。

### 2.7 配置（注意：不是 pi.json）

项目配置目录是 `.pi/`（package.json 里 `piConfig.configDir: ".pi"`）。设置文件：`~/.pi/agent/settings.json`（全局）+ `.pi/settings.json`（项目覆盖，嵌套对象深合并）。要点（[settings.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md)）：

- 模型/思考：`defaultProvider/defaultModel/defaultThinkingLevel`（`off|minimal|low|medium|high|xhigh|max`）、`modelThinkingLevels`、`thinkingBudgets`。
- UI：`theme`、`externalEditor`、`quietStartup`、`tuiMode`（`regular|fullscreen`）、`treeFilterMode`、`outputPad`、`autocompleteMaxVisible`、`showHardwareCursor`。
- 压缩：`compaction.{enabled,reserveTokens=16384,keepRecentTokens=20000}`；重试 `retry.{enabled,maxRetries=3,baseDelayMs=2000,...}`。
- 消息投递：`steeringMode/followUpMode`（`one-at-a-time|all`）、`transport`（`sse|websocket|websocket-cached|auto`）。
- 终端/图片：`terminal.showImages/imageWidthCells/trueColor/hyperlinks`、`images.autoResize/blockImages`。
- Shell：`shellPath`、`shellCommandPrefix`；会话：`sessionDir`；模型轮换：`enabledModels`（Ctrl+P 循环的 glob 列表）；Markdown：`markdown.codeBlockIndent`、`markdown.mermaid`；资源：`packages/extensions/skills/prompts/themes`（支持 glob/排除）。
- 另有 `~/.pi/agent/keybindings.json`（按键）、`~/.pi/agent/themes/*.json`（主题）、`~/.pi/agent/models.json`（自定义提供商/模型）、`~/.pi/agent/trust.json`。环境变量 `PI_CODING_AGENT_DIR` 可改配置目录。

### 2.8 模型切换

`/model`（或 Ctrl+L）打开**模型选择器**（[model-selector.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/components/model-selector.ts)）：按提供商分组、可搜索；**Ctrl+S 把高亮模型存为启动默认**。`Ctrl+P` / `Shift+Ctrl+P` 在 `enabledModels` 范围内前后循环。`/scoped-models` 管理循环范围。`/thinking` + `Shift+Tab` 切思考档位（编辑器边框颜色随之变化）。提供商目录自动刷新（`pi update --models` 强制）。CLI：`--model provider/id[:thinking]`、`--list-models [search]`、`--models "claude-*,gpt-4o"`。pi-ai 的模型对象自带 `contextWindow/input能力/reasoning/pricing` 等元数据，选择器/页脚可直接用。

### 2.9 上下文压缩（[compaction.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)）

- 触发：自动（`contextTokens > contextWindow - reserveTokens`(16384) 时在 agent run 内部压缩后继续；以及接近上限的预防性触发）+ 手动 `/compact [instructions]`。
- 算法：从最新消息往回走到 `keepRecentTokens`(20k) 边界 → 截出待压缩消息 → LLM 生成**结构化摘要**（`## Goal / ## Constraints & Preferences / ## Progress(Done/In Progress/Blocked) / ## Key Decisions / ## Next Steps / ## Critical Context` + `<read-files>`/`<modified-files>` 文件追踪，跨次压缩累积）→ 追加 `CompactionEntry`（`summary/firstKeptEntryId/tokensBefore/usage/retainedTail`）。单轮超预算的 "split turn" 会把轮前缀也摘要。
- 摘要前用 `serializeConversation()` 把消息文本化（`[User]:`/`[Assistant thinking]:`/`[Assistant tool calls]: read(path=...); edit(...)`/`[Tool result]:`，工具结果截断到 2000 字符）。
- 扩展可拦截：`session_before_compact`（可取消/自定义摘要/换模型）、`session_compact_failed`、`session_before_tree`。
- 全量历史永远留在 JSONL 里，`/tree` 可回看；压缩有损。TUI 里压缩摘要渲染成特殊消息块（`compaction-summary-message.ts`）。

### 2.10 成本 / 用量追踪

页脚实时显示：`↑` 输入 token、`↓` 输出 token、`R` 缓存读、`W` 缓存写、`CH` 最新缓存命中率、成本（$）、上下文占用、当前模型；总计含 assistant 回复 + 工具上报的 usage + 摘要生成的 usage。`/session` 可看会话明细；`/export` 出 HTML；`/share` 传 gist。设置 `showCacheMissNotices` 会在显著缓存 miss 时打通知（对 DeepSeek 这类缓存计费模型很有用）。

---

## 3. 流式渲染细节

### 3.1 assistant 流式文本

pi 把流式 delta 累积进一条 `AssistantMessage`，用 `Markdown` 组件渲染（marked 解析 + 主题着色 + 可选语法高亮），组件缓存按宽度失效，配合差分渲染与 CSI 2026 做到无闪烁增量输出。同时显示"工作指示器"（working indicator，可自定义帧序列/间隔/隐藏）。用户可随时 Enter 排队 steering 消息、Alt+Enter 排队 follow-up 消息（Alt+Up 取回，Escape 中止并还原）。

### 3.2 工具调用进度（[tool-execution.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/components/tool-execution.ts)）

`ToolExecutionComponent` 是一个带背景色的 `Box`（`theme.bg(...)`），**状态驱动背景色**：

- 进行中（参数还在流式到达 / 正在执行，`isPartial=true`）：`toolPendingBg`；
- 完成成功：`toolSuccessBg`；失败：`toolErrorBg`。
- 内容：`renderCall`（工具定义可自定义，fallback = 粗体工具名 + JSON 参数）+ `renderResult`（fallback = 输出文本，**默认只预览前 10 行**，剩余显示 `... (N more lines, Ctrl+O to expand)`；Ctrl+O = `app.tools.expand` 折叠/展开）。
- 工具结果里的图片：Kitty 协议内联渲染（非 PNG 用 wasm 转 PNG）；iTerm2 回退文本。
- 扩展可为每个工具注册 `renderCall/renderResult` 自定义渲染（比如 edit 工具的 diff 视图、自定义表格）。

### 3.3 diff 展示（[diff.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/components/diff.ts)）

`renderDiff()`：解析 `[+- ]行号 内容` 行；上下文行用 `toolDiffContext`（dim），删除行 `toolDiffRemoved`（红），新增行 `toolDiffAdded`（绿）；**当删/增各恰一行（单行修改）时做词级 diff（`diff` 包 `diffWords`）并对变更片段用反显（inverse）**，否则整行着色；tab 统一替换为 3 空格。主题 token：`toolDiffAdded/toolDiffRemoved/toolDiffContext`。

### 3.4 thinking 块

thinking 内容单独渲染成可折叠块：**Ctrl+T（`app.thinking.toggle`）折叠/展开**，设置 `hideThinkingBlock` 可隐藏；`thinkingText` 颜色 token。editor 边框颜色 = 当前思考档位（`thinkingOff..thinkingMax` 六档渐变，从 subtle 到醒目）。pi-ai 的流式事件里 thinking 是独立 delta 流（`thinking_start/delta/end`），跨提供商统一。

### 3.5 全屏模式（alt-screen）

`--tui-mode fullscreen` / 设置 `tuiMode`：transcript 在 alt-screen 视口内滚动，编辑器/状态/页脚固定底部；鼠标/触控板滚动、拖选复制（OSC 52）、`Ctrl+Shift+F` 搜索、OSC 133 prompt 跳转；退出时可选择打印最终 transcript（`fullscreenExitOutput`）。regular 模式则用主屏 + 终端自身滚动缓冲。**默认是 regular（主屏）**——这降低了实现难度，是 dsh-tui-rust 可借鉴的"先主屏后 fullscreen"路线。

---

## 4. 主题 / 颜色 / 状态栏 / 按键约定

### 4.1 主题系统（[themes.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/themes.md)）

JSON 主题文件（内置 `dark/light`，首次运行探测终端背景自动选；位置：`~/.pi/agent/themes/`、`.pi/themes/`、包内、`--theme`；**热重载**——编辑激活主题文件立即生效）。结构：`name` + 可选 `vars`（可复用色变量）+ `colors`（**51 个必需 token**）：

- 核心 UI：`accent/border/borderAccent/borderMuted/success/error/warning/muted/dim/text/thinkingText`
- 背景/内容：`selectedBg/userMessageBg/userMessageText/customMessageBg/customMessageText/customMessageLabel/toolPendingBg/toolSuccessBg/toolErrorBg/toolTitle/toolOutput`（+可选 `scrollbarThumb/searchMatchBg/searchMatchText`）
- Markdown：`mdHeading/mdLink/mdLinkUrl/mdCode/mdCodeBlock/mdCodeBlockBorder/mdQuote/mdQuoteBorder/mdHr/mdListBullet`
- 工具 diff：`toolDiffAdded/toolDiffRemoved/toolDiffContext`
- 语法高亮：`syntaxComment/syntaxKeyword/syntaxFunction/syntaxVariable/syntaxString/syntaxNumber/syntaxType/syntaxOperator/syntaxPunctuation`
- 思考档位边框：`thinkingOff/thinkingMinimal/thinkingLow/thinkingMedium/thinkingHigh/thinkingXhigh(+Max)`
- bash 模式：`bashMode`
- 颜色值格式：6 位 hex / 256 色索引 / vars 引用 / `""`（终端默认）；真彩色为主、256 色回退。

**状态/角色 → 颜色的映射即信息编码**：用户消息有背景块（`userMessageBg`），assistant 是普通文本，工具框三态背景，编辑器边框色=思考档位/bash 模式。这是 dsh-tui-rust 最值得抄的"语义 token"设计（对应 ratatui 的 `Style` 映射层）。

### 4.2 状态栏 / 页脚

默认页脚内容（[README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)）：工作目录、会话名、`↑in ↓out R R-cache-read W cache-write CH hit-rate`、成本、上下文占用、模型。扩展可 `ctx.ui.setStatus(key, styledText)` 追加状态段（如 `● active`）、`setFooter()` 整体替换（footerData 提供 `getGitBranch()` 等）、`setWidget()` 在编辑器上下加常驻行。见 [tui.md Pattern 4/5/6](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md)。

### 4.3 按键约定（[keybindings.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/keybindings.md)）

- 全量可配：`~/.pi/agent/keybindings.json`，键格式 `modifier+key`（`ctrl/shift/alt/super` 可组合；支持 Kitty 键盘协议的 super），action 用**带命名空间的 id**：`tui.editor.*`（光标/删除/跳转/undo/yank/kill-ring）、`tui.input.*`（`newLine=shift+enter`、`submit=enter`、`tab`）、`tui.select.*`（列表选择：↑↓/enter/escape）、`tui.altScreen.*`（全屏翻页/搜索）、`app.*`（`interrupt=escape`、`clear=ctrl+c` 两次退出、`exit=ctrl+d`、`editor.external=ctrl+g`、`session.*`、`model.select=ctrl+l`、`model.cycleForward=ctrl+p`、`thinking.cycle=shift+tab`、`thinking.toggle=ctrl+t`、`tools.expand=ctrl+o`、`message.copy=ctrl+x`、`message.followUp=alt+enter`、`message.dequeue=alt+up`、`tree.*`）。
- 惯例：Escape=取消/中止（双击 Escape 开 `/tree`）；Ctrl+C=清编辑器→再按退出；选择器 Enter 确认 / Escape 取消；`/hotkeys` 查看全部。官方提供 Emacs / Vim 两套示例配置。

---

## 5. 可落地建议（dsh-tui-rust，ratatui 客户端包 DSH Node kernel over ACP）

ACP 给 dsh-tui-rust 的天然映射：kernel 发来 `session/agent/notification` 事件流（text delta、tool call/result、usage、permission 请求等），TUI 只做展示与输入转发。以下是按"影响/努力"排序的建议（高→低）：

| # | 建议 | 影响 | 努力 | 依据 |
|---|------|------|------|------|
| 1 | **流式增量渲染 + 跟随**：ACP text delta 累积进消息，节流（~30–60ms）重绘 ratatui 段落；底部自动跟随、手动上滚时停跟；普通段落 + 简单增量 markdown 样式（标题/粗体/行内代码/代码块边框） | ★★★ | 低 | pi 的 Markdown 组件 + 差分渲染 + 伪光标 |
| 2 | **shell `!` 直通**：`!cmd` 本地执行、输出渲染成带边框的块、并作为上下文消息发给模型；`!!cmd` 静默执行；超长输出截断 + "N 行被截断"提示 | ★★★ | 低 | pi `!`/`!!` + `BashExecutionMessage.truncated` |
| 3 | **工具调用进度框**：tool_call 到达即渲染"待执行"框（spinner + 工具名 + 参数预览），tool_result 后按成败换色（绿/红背景）；Ctrl+O 折叠；默认预览前 10 行 + "…N more lines" | ★★★ | 低 | `ToolExecutionComponent` 三态背景 |
| 4 | **页脚状态栏**：模型名、会话名、`↑in/↓out/R/W/CH 命中率`、成本、上下文占用（%）、git 分支；ACP usage 事件驱动 | ★★★ | 中 | pi 页脚 + `Usage.cost` |
| 5 | **会话存储为 JSONL 树 + `/resume`/`/tree`**：镜像 pi 的 `id/parentId` 树格式与选择器（搜索/排序/重命名/删除）；`-c` 继续最近、`-r` 浏览 | ★★★ | 中 | session-format/sessions.md |
| 6 | **上下文压缩 UX**：`/compact` 手动 + 阈值自动（`reserveTokens`/`keepRecentTokens` 可配）；压缩摘要渲染为特殊消息块（pi 的 `## Goal/Progress/Next Steps` 结构）；ACP 上可实现为"把摘要作为新上下文起点" | ★★☆ | 中 | compaction.md |
| 7 | **diff 渲染**：统一 diff 解析 + 行级红/绿 + 单行修改做词级反显（`diffWords` 思路，Rust 可用 `similar`/`dissimilar` crate）；适用于 DSH 报告的文件编辑/补丁 | ★★☆ | 中 | `renderDiff()` |
| 8 | **模型/配置列表 UI + 斜杠命令补全**：SelectList 式选择器（搜索、分组、Enter/Escape）、Ctrl+L 打开、Ctrl+P 循环、默认模型持久化；输入 `/` 弹命令补全 | ★★☆ | 低–中 | model-selector.ts / autocomplete.ts |
| 9 | **语义主题 token 系统**：JSON 主题（51 token 那套子集：accent/border/success/error/toolPendingBg/toolDiffAdded…）→ ratatui `Style`；热重载；**编辑器边框颜色编码状态**（空闲/忙碌/思考档位） | ★★☆ | 低–中 | themes.md |
| 10 | **权限确认覆盖层 + 记忆化**：ACP permission 请求弹覆盖层模态（而非打断主布局），提供"本次允许/总是允许（写入 trust 文件）"；对齐 pi 的项目信任流（`trust.json`） | ★★☆ | 低–中 | 2.5 节 + tui.md overlay |

**实施顺序建议**：先 1+3（流式与工具框是 agent TUI 的体验底座）→ 2、4（成本/命令直通，低努力高感知）→ 9、10（主题与权限）→ 5、6（会话与压缩，依赖事件模型稳定）→ 7、8（diff、选择器精修）。

**几个可直接抄的关键细节**：

1. **CSI 2026 同步输出**：ratatui 里在每帧 paint 前后包 `\x1b[?2026h/l`，消除大输出时的撕裂闪烁。
2. **伪光标**：隐藏真实光标、在编辑器渲染处画反显块（pi 用 `\x1b[7m`），并用零宽 marker 定位硬件光标以支持 IME（中文输入对 dsh-tui-rust 是刚需，pi 专门写了 Focusable/IME 章节）。
3. **消息队列**：agent 忙碌时 Enter 排队 steering、Alt+Enter 排队 follow-up、Escape 取回——低成本高价值的"异步协作"体验。
4. **缓存命中率展示**（`CH` + `showCacheMissNotices`）：对 DeepSeek 这种 prompt-cache 计费模型，把 cacheRead/W 与命中率放页脚是成本感知的关键功能。
5. **预览截断 + 展开**（10 行预览、Ctrl+O 展开）与**大粘贴折叠**（`[paste #1 +50 lines]`），避免长输出刷屏。

**主要来源**：
- [pi 主 README](https://github.com/earendil-works/pi/blob/main/README.md)
- [pi-tui README](https://github.com/earendil-works/pi/blob/main/packages/tui/README.md) / [pi-tui package.json](https://github.com/earendil-works/pi/blob/main/packages/tui/package.json) / [pi-tui 组件目录](https://github.com/earendil-works/pi/tree/main/packages/tui/src/components)
- [coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) / [usage.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md) / [tui.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md) / [themes.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/themes.md) / [keybindings.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/keybindings.md) / [sessions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md) / [session-format.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md) / [compaction.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md) / [settings.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md)
- 源码：[tool-execution.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/components/tool-execution.ts)、[diff.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/components/diff.ts)、[交互组件目录](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/modes/interactive/components)
- [pi-ai README](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)（Usage 结构、流式事件、缓存/成本）；作者博客 [What if you don't need MCP / pi rationale](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)

> 注：若干文档中的源码链接指向 `earendil-works/pi-mono`（另一仓库），本文引用的均为 `earendil-works/pi@main` 的实际路径；pi 无 `pi.json` 概念，配置为 `.pi/settings.json`（项目）+ `~/.pi/agent/settings.json`（全局）。
