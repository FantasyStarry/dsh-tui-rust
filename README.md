# dsh-tui-rust

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的终端客户端（类 Claude Code 形态）。

> 官方仓库默认分支是 **`master`**（本仓库持续跟踪；kimi-code / pi 为 `main`）。
> 参考资料与设计调研见 [`docs/research/`](docs/research/)（deepseek-harness /
> kimi-code / pi 三份研究报告）。

**核心原则：Rust 只做终端前端壳，Node 内核（dsh）通过协议复用，永不修改。**

## 架构

```
┌─────────────────────────┐    ACP v1 (JSON-RPC over stdio)    ┌─────────────────────────┐
│  dsh-tui / dtr (Rust)   │ ◄────────────────────────────────► │  dsh --profile acp       │
│                         │                                    │  (Node 子进程)           │
│  · ratatui 终端渲染      │   session/new · session/prompt     │                         │
│  · 键盘交互 / 权限弹窗    │   session/update (流式)            │  完整内核：全部工具、      │
│  · 会话列表 / resume     │   session/request_permission       │  沙箱、持久化、MCP、      │
│  · diff / markdown 渲染  │   session/close · resume           │  插件生态、模型路由       │
│  · /web 启动 web 界面    │   session/set_config_option        │                         │
└─────────────────────────┘                                    └─────────────────────────┘
```

唯一耦合面 = **ACP v1 标准协议**。内核的全部能力（30+ 工具包、沙箱、会话持久化、
压缩、subagent、skills、MCP client、插件系统）免费继承，随官方升级自动获得。

启动时 **dsh 由 TUI 自动以子进程拉起**（`dsh --profile acp`），无需先手动开任何服务；
TUI 退出不会影响内核，会话已持久化，重启后 `Ctrl+L` 可恢复。

## 为什么不 fork 官方仓库（内核隔离策略）

结论：**不 fork，用"npm 包引用 + 进程边界"的方式消费内核。**

| 隔离层 | 机制 |
|--------|------|
| 进程隔离 | dsh 以子进程运行（`dsh --profile acp`），TUI 崩溃不影响内核，内核崩溃可凭持久化会话 resume |
| 优雅退出 | 退出时先对 dsh stdin 发 EOF 请求优雅关机（持久化冲刷）；实测部分 out-of-tree 插件会阻止 dsh 退出，故 3 秒宽限后**整树强杀**（Windows：`taskkill /T` + 孤儿枚举，因 `cmd /C` 包装下 node 是孙进程；Unix：直接 kill）——保证 TUI 进程永不悬挂 |
| 作业对象 | dsh 进程树挂入 Windows **Job Object**（kill-on-close）：即使 TUI 被硬杀（窗口 ✕ / 任务管理器 / 崩溃），OS 也会自动收割内核，绝不孤儿 |
| 协议隔离 | 只依赖官方承诺的标准 ACP v1 surface（无私有方法、无 `_meta`），上游只要保持 ACP 兼容就不会破坏 TUI |
| 环境隔离 | dsh 自带 profile 机制：acp profile 的插件树、补丁、持久化都在 `$DSH_HOME/profiles/acp/` 独立目录，与 web profile 互不干扰 |
| 版本契约 | 要求 `dsh >= 0.1.2-alpha.2` 在 PATH 上（或用 `DSH_BIN` 环境变量指向可执行文件） |

fork 的问题：会把整个 Node monorepo（100+ 包）复制进来，从此背负上游同步负担，
而且"顺手改内核"的诱惑会导致永久分叉。fork 只有在需要修改内核本身时才合理——
而那是本架构明确禁止的事。未来若需要 TUI 专属的内核扩展，正确做法是 **out-of-tree
插件 bundle**（通过官方机制 `dsh plugin --profile acp add <包>` 安装），依然不是 fork。

## 安装与启动

前置条件：`dsh` 在 PATH 上（`npm i -g @deepseek-ai/dsh`），Rust 工具链。

### 开发模式（默认用法）

```sh
cargo run --release --bin dsh-tui   # 交互式 TUI（需要真实终端 TTY，如 Windows Terminal）
cargo run --bin dsh-tui -- --probe  # 非 TTY 自检：initialize / new / list / resume / 模型同步
cargo run --bin dsh-tui -- --render-bench  # 无 TTY 渲染基准
DSH_BIN=/path/to/dsh cargo run --bin dsh-tui  # 指定 dsh 路径
```

不需要先启动任何 dsh 服务——TUI 会自己拉起 `dsh --profile acp` 子进程。

### 全局安装（可选）

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1    # Windows
sh install.sh                                           # macOS / Linux
```

把 `dsh-tui.exe` / `dtr.exe`（另附 `dsh-tui-rust.exe` 别名）装到 `~/.dsh-tui/bin`
并加入用户 PATH。之后**在任何终端直接输入**：

```sh
dtr          # 或 dsh-tui / dsh-tui-rust，三者等价
```

**卸载**：`powershell -ExecutionPolicy Bypass -File uninstall.ps1`（或 `sh uninstall.sh`）——
删除可执行文件并清理 PATH，保留 `~/.dsh-tui` 用户数据。

### 在 TUI 内启动 web 界面

输入 `/web`（或命令菜单选择）：若 `http://127.0.0.1:3080` 已在运行则直接打印地址；
否则后台启动 `dsh web`（自动打开浏览器），就绪后打印 URL。端口可用环境变量
`DSH_TUI_WEB_PORT` 覆盖（默认 3080）。退出 TUI 不影响 web。

## Phase 1 界面与按键

| 按键 | 作用 |
|------|------|
| `Enter` | 发送输入框中的消息 |
| `Shift+Enter` | 多行输入换行（输入框随行数自动增高，最多 8 行） |
| `Ctrl+O` | 折叠 / 展开最近一次工具调用的参数预览（pi `tools.expand` 类比） |
| 输入 `/` | **弹出命令菜单**：继续输入过滤，`↑↓` 选择，`Tab` 补全，`Enter` 执行 |
| `Esc` | 任务运行中 → 取消（session/cancel）；输入非空 → 清空；有空闲队列 → 清空队列 |
| 忙时输入 | 自动**排队**（状态栏显示队列数），当前任务完成后逐条自动发送 |
| 权限弹窗 | `↑↓` 选择 · `Enter` 确认（紫色选中条）· `Esc` 拒绝 |
| `Ctrl+M` / `/model` | 模型切换（session/set_config_option，带当前标记；运行中也可切换，下一轮生效） |
| `Ctrl+E` / `/effort` | 推理档位切换（off/low/high/max） |
| `Ctrl+L` 或 `/list` | 持久化会话列表 → `Enter` 恢复（session/resume，需 cwd 校验） |
| `Ctrl+N` 或 `/new` | 新建会话（旧会话 close 后保留在持久化里） |
| `!cmd` / `!!cmd` | **shell 直通**（借鉴 pi）：本地执行命令并展示输出；`!` 额外把输出作为上下文发给模型，`!!` 只显示不上送 |
| `/cost` | 今日 token 用量与费用估算（读 `~/.dsh/storages/token-stats.json`，与 web 共用数据） |
| `/usage` | 当前会话的用量明细（请求数 / 输入 / 输出 / 缓存 / 推理 tokens） |
| `/status` | 当前会话 / 模型 / 上下文 / 队列信息面板 |
| `/doctor` | 环境自检：dsh 版本、`~/.dsh` 关键文件、acp patch 插件行、TUI 配置 |
| `/preset` | 列出 `~/.dsh/.agent-presets` 下的 agent presets（只读） |
| `/permission` | 本地权限规则（见下） |
| `/web` | 启动 / 打开 web 界面（见上） |

**命令别名**（kimi 风格，菜单过滤与逐字输入均生效）：`/sessions`→`/list`、`/s`→`/list`、
`/m`→`/model`、`/e`→`/effort`、`/c`→`/clear`、`/h` `/?`→`/help`、`/exit` `/q`→`/quit`。
菜单按 会话 / 模型 / 信息 / 系统 分组显示；忙时禁用的命令标注 `[忙时禁用]`（如
`/new` `/list`，Esc 取消任务后恢复）；未匹配的 `/xxx` 作为普通消息发给模型。
| `鼠标滚轮` / `PgUp` / `PgDn` | 滚动历史；状态栏显示滚动标尺；回到底部自动跟随 |
| `Home` / `End` | 跳到顶部 / 底部 |
| `↑` / `↓` | 输入历史（持久化到 `~/.dsh-tui/history.json`，跨会话保留，上限 200 条） |
| `Ctrl+C` | 退出（stdin EOF 触发 dsh 优雅关机） |

命令一览：`/help`（面板）`/new` `/list` `/model` `/effort` `/cost` `/usage` `/status`
`/doctor` `/permission` `/web` `/clear`（清屏，不影响会话）`/quit`。

### 本地权限规则（`~/.dsh-tui/permission.json`）

内核的 `session/request_permission` 弹窗可被**客户端规则**自动应答（借鉴 kimi
`permission.rules`，纯本地，内核无感知）。规则按工具标题做不区分大小写子串匹配：

```json
{
  "rules": [
    { "pattern": "read",  "decision": "allow" },
    { "pattern": "bash",  "decision": "deny" }
  ]
}
```

`allow` 自动选择允许选项、`deny` 直接取消，转写区记录 `[权限规则]` 日志；
未匹配的请求照常弹窗。`/permission` 查看已加载规则。

启动时后台检查 `dsh --version`（≥ 0.1.2-alpha.2 契约），过低或缺失会在状态区警告。

### 流式展示说明（重要）

**实测结论**（`scripts/acp-stream-probe.mjs`，对真实内核逐事件计时）：dsh 的 ACP
面是 automation-only 契约——assistant 消息与思考以**单个 committed 块**在回合
结束时一次性发出，**原始 provider delta 不上 wire**（官方 README 原话：
"raw provider deltas stay off the wire"；config catalog 亦无流式开关；
npm 最新 0.1.2-alpha.3 无支持流式的版本）。这是内核的刻意设计，不是 bug，
内核不可修改。

**TUI 的解法：本地逐字揭示（typewriter reveal）**——committed 块到达后按长度自适应
节奏逐字显示（~0.1s 基线 + 3ms/字符，钳制在 [0.1s, 1s]：短回复即现，长文本 ≤1s 刷完；
严格按 33ms 渲染节拍推进，键鼠/事件突发不会"快进"），恢复流式观感：

- 思考与回复分别排队揭示；工具卡片照常实时渲染
- 结算提示（"— 完成 —"）延迟到揭示完成后显示，避免"完成"悬在打字机上方的错位
- 揭示期间状态栏显示 `● 输出中` + 动画
- `Esc` 取消立即 flush 已收到内容；`DSH_TUI_NO_TYPEWRITER=1` 关闭揭示（直达）

### 主题系统（`~/.dsh-tui/theme.json`，pi themes 风格）

全部渲染从语义 token（accent/violet/ok/warn/err/fg/muted/dim/codeFg/hairline/pillBg/barBg）
取色，默认调色板即设计稿配色。可选用 `~/.dsh-tui/theme.json` 覆盖任意子集
（启动时读取一次，`#RRGGBB` 十六进制，非法键忽略）：

```json
{
  "accent": "#61afef",
  "violet": "#a78bfa",
  "ok": "#4ade80"
}
```

### 流式渲染与帧率（ratatui）

- **事件门控渲染**：只有 dirty 或忙碌（spinner 动画）才重绘；空闲零绘制。
  忙碌时 ~30fps（33ms 合并窗口把流式 chunk 突发合并成帧），空闲按键 ≤8ms 响应。
- **增量显示缓存**：每条消息的换行块按条目缓存（`disp_cache`），流式只重排
  被修改的尾部条目——O(尾) 而非 O(全文)。
- **CSI 2026 同步输出**：每帧包裹 `\x1b[?2026h/l`（Windows Terminal / kitty /
  WezTerm 原子刷帧，消除流式闪烁；不支持则忽略；`DSH_TUI_NO_SYNC_OUTPUT=1` 关闭）。
- **`--render-bench` 无 TTY 基准**：`dsh-tui --render-bench` 用 TestBackend 实测
  （1201 条长转写）：流式 508 fps（1.97ms/帧）、增量重排 287µs、全帧 2.23ms —
  30fps 预算 33ms 内富余 15 倍。

### 模型选择与 web 端的关系

**模型列表与 web GUI 同源同步**：TUI 会话的模型选项来自 acp profile 的
`llm-pi-ai` + `llm-deepseek` 提供商目录，与 web 读的是同一份
`~/.dsh/settings.yaml`。`session/new` 的 `configOptions` 在提供商适配器完成注册前
（启动后约 2 秒）只包含内置 DeepSeek 路由，所以 TUI 做了两层补偿：

- **自动同步**：会话创建后自动重拉配置（no-op `set_config_option`），等 pi-ai
  适配器注册完毕（多提供商分组出现）即发布完整目录，状态栏提示
  "模型列表已与 web 端同步"
- **按需刷新**：打开 `/model` 或 `/effort` 前先重拉一次，保证选择器始终显示完整
  目录；同名的模型按 `提供商 · 模型` 前缀区分，列表支持滚动

模型选择本身是**会话级状态**（ACP 标准语义），TUI 侧把选择持久化到
`~/.dsh-tui/prefs.json`，每个新会话在目录同步后自动应用上次的模型/档位。

视觉语言（基于 gpt-image-2 生成的设计稿，本地 `design/` 参考，不入库）：

- 顶栏：🐋 + 渐变字标 DSH·TUI，右侧模型药丸 + 推理档位药丸（⚡off/low/high/max）+
  web 指示器（🌐 :3080，`/web` 探测后点亮）+ 上下文进度条（>70% 变黄、>90% 变红）
- 转写区：蓝色 `❯` 用户前缀、暗色斜体思考行、**工具调用卡片**（状态色圆角边框：
  进行中黄 / 已完成绿 / 失败红，标题行内嵌中文状态标签，`⤷` 参数预览可用
  Ctrl+O 折叠）+ 工具实参预览（`⤷` 暗行，来自 rawInput）、回合间发丝分隔线
- 正文 markdown-lite：``` 代码块带语言标注边框、`行内代码`、**粗体**、标题、
  列表与引用（保守渲染，识别不了的原样显示，流式安全）
- 状态行：状态点 + braille spinner + 运行计时 + 滚动标尺，右侧 keycap 风格按键提示
- 输入框：圆角紫边 + 蓝色 `❯` + 占位符；运行时边框变黄
- 弹窗：圆角边框 + 全宽紫色选中条（权限/会话列表/模型选择共用），长列表可滚动

> 鼠标捕获开启后，Windows Terminal 中需 `Shift`+拖拽 才可选择终端文本（TUI 惯例）。

### 与 web 端共用 `~/.dsh`（配置/插件/工作区）

**天生共享**（home 级，所有 profile 通用）：`settings.yaml`、凭证、agent presets、
skills、会话存储、工作区注册表（`storages/workspace.json`）、附件。

**按 profile 隔离**（设计如此）：树外插件（各自 `node_modules`）、
`cordis.patch.yml` 补丁层、bundle 列表。同步方式（已在本机执行）：

```sh
dsh plugin --profile acp add "@tt-a1i/archify-dsh@^0.1.0"        # bundle 级插件
dsh plugin --profile acp add "link:C:/Users/Mayn/Desktop/dsh-token-stats"  # 本地源码 link
dsh plugin --profile acp add "link:C:/Users/Mayn/Desktop/dsh-tui-rust/companion/dsh-tui-companion"
```

acp profile 的 `cordis.patch.yml` 挂载了：

- `@deepseek-ai/dsh-workspace` — base 已带全部前置（storage/persistence），只缺这一行
- `dsh-tui-companion`（本仓库 `companion/`，见下）
- 从 web patch 镜像的 Exa MCP + token-stats（TUI 会话的工具调用同样计入用量统计）

### companion 插件（工作区自动归组）

web 端创建会话时由客户端显式携带 workspaceId；ACP 协议没有这个面，且 registry
只在首次初始化时归组历史——所以 TUI 会话天生落"未分组"。`companion/dsh-tui-companion`
（挂载在 acp profile）补上这块：

- **实时归组**：会话第一条事件（TUI 首次发言）到达即按 canonical cwd 归组
- **定时对账**：启动后 3s/10s/30s + 每 15s 扫描全部持久化会话，任何新会话几秒内归组
- **自动建组**：cwd 没有对应工作区时自动创建（`Workspace.create` 幂等），
  与 web registry 首次 bootstrap 的行为一致——TUI 在任意新目录启动的会话
  也会出现在 web 侧边栏对应项目分组下，不再落"未分组"
- 子代理会话跳过；home 目录不建组（避免把 `C:\Users\<你>` 变成工作区）
- **空会话隔离**：零事件的 ACP 会话（TUI/探针残留，header 无 `agentPreset`）
  **永不归组**，且每次启动归档一批已挂载的同类残留（`registry.archiveSession`，
  只清 header、零数据损失，且仅限创建超过 1 小时的）——否则 web 新会话界面会
  复用这种残留空白作为"暂存会话"，而它没有 `agentPreset` 投影，会让整个工作区
  的**模式选择器（标准/PTC/极简/创造）消失**。web 创建的会话（header 带
  `agentPreset`）不受影响，维持原语义

> 已实测：TUI 新会话几秒内进入 `dsh-tui-rust` 工作区；从未注册的目录创建的会话
> 会自动生成同名工作区并归入。

### shell 直通（`!cmd` / `!!cmd`）

借鉴 [pi](https://github.com/earendil-works/pi) 的 `!` 命令：在输入框以 `!` 开头
的命令**本地执行**（以当前工作目录为 cwd），输出渲染进转写区（超长自动截断）：

- `!git status` — 执行并把输出作为上下文发给模型（等价于 pi 的 BashExecutionMessage）
- `!!git status` — 只执行并显示，不上送模型

运行中 UI 不阻塞（后台任务 + `ShellDone` 事件）；模型忙时 `!` 的输出自动排队。

### `/cost` 用量与费用（读共享 `~/.dsh`）

`dsh-token-stats` 插件把每日用量写到 `$DSH_HOME/storages/token-stats.json`（web 与
TUI 共用同一份）。`/cost` 汇总**今日**各提供商/模型的请求数与各类 token
（输入/输出/缓存读/缓存写/推理），并按价目估算费用：

- 内置参考价表（DeepSeek / MiniMax / GLM / GPT-5.6 等，2026-09 参考价）
- 覆盖：`~/.dsh-tui/prices.json`，键为模型 id、**前缀匹配**（与
  `cordis.patch.yml` 里 token-stats 的价目写法一致）：

```json
{
  "deepseek-v4-flash": { "input": 0.14, "cacheRead": 0.028, "cacheWrite": 0.14, "output": 0.28 }
}
```

### 本地会话标题

dsh 的 acp profile 禁用了模型生成标题（ACP 面无标题 surface，只有确定性 fallback
标题）。TUI 在**会话首条消息**时本地生成短标题（前 24 字符），持久化到
`~/.dsh-tui/session-titles.json`；`/list` 里优先展示本地标题，其次 dsh fallback，
最后才是 cwd。

### 已知限制（Phase 1）

- 正文按纯文本渲染（markdown/高亮留给 Phase 2）；思考流为暗色文本
- ACP `session/resume` 不回放历史内容（内核上下文已恢复，但 TUI 不显示旧消息）
- 会话列表标题：TUI 本地生成（首条消息前 24 字符，`~/.dsh-tui/session-titles.json`），
  而非内核模型生成
- 模型目录同步依赖提供商注册时机，极端情况下（settings 加载失败）会保留
  内置 DeepSeek 列表并在打开 `/model` 时重试刷新

## Roadmap

- [x] **Phase 0** — ACP 管道验证：initialize → session/new → prompt → 流式
      session/update → stopReason → session/close（已实测通过，真实模型回复）
- [x] **Phase 1 MVP** — ratatui 聊天界面（流式正文/思考/工具卡）、权限弹窗 UI、
      `session/list` / `session/resume`（probe 自检通过；resume 需带 cwd 参数）
- [x] **可用化里程碑** — 模型/推理档位热切换（`set_config_option`，probe 验证
      configId 契约）、忙时消息队列、markdown-lite 正文渲染、工具 rawInput 预览、
      模型目录与 web 同步、`/web` 启动 web、`dtr` 直达命令
- [x] **客户端体验里程碑** — `!`/`!!` shell 直通（借鉴 pi）、`/cost` 用量费用、
      `/status` 信息面板、`/help` 面板化、本地会话标题（首条消息）、
      会话列表相对时间 + 当前会话标记、版本号统一（0.3.0）
- [x] **流畅渲染里程碑** — 事件门控渲染（忙 30fps / 闲按需）、增量显示缓存、
      CSI 2026 同步输出、`--render-bench` 基准（~500fps）、工具调用状态卡片、
      多行输入（Shift+Enter）、kimi 式命令体系（别名/分组/忙时门控）、
      `/doctor` `/preset` `/usage` `/permission`、主题系统（theme.json）
- [ ] **Phase 2** — diff 视图（受 ACP 限制：无工具结果流）、图片粘贴、语法高亮
- [ ] **Phase 3** — companion 插件 bundle（`tui` profile）+ npm 分发（平台预编译二进制）

## 协议速查（dsh acp surface 实测）

| 调用 | 说明 |
|------|------|
| `initialize` | 参数 `{protocolVersion: 1, clientCapabilities: {}}`，无需 authenticate |
| `session/new` | 参数 `{cwd: <绝对路径>, mcpServers: []}`，返回 `sessionId` + `configOptions`（**注意：快照可能早于提供商注册，见上节模型同步**） |
| `session/prompt` | `{sessionId, prompt: [{type: "text", text}]}`，返回 `stopReason` |
| `session/update`（通知） | `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `config_option_update` / `usage_update` |
| `session/request_permission`（agent 反向请求） | 需应答 `{outcome: {outcome: "selected", optionId}}` |
| `session/set_config_option` | `{sessionId, configId, value}`（**configId 而非 configOptionId**，probe 实测），返回完整配置状态；模型选项是嵌套分组结构需拍平；运行中切换对下一轮生效；**对当前值做 no-op set 可重拉完整目录（本 TUI 用它做模型同步）** |
| `session/list` / `session/resume` / `session/close` | 持久化会话管理；**dsh 的 resume 额外要求 `cwd` 参数**（校验会话规范工作目录，标准 ACP 未定义，缺省返回 -32602） |

dsh acp surface 不支持 client filesystem 操作、elicitation、terminals、modes/plans——
spike 阶段无需实现这些反向处理。
