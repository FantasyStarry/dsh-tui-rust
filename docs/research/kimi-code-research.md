# Kimi Code CLI 研究调查报告

> 面向 dsh-tui-rust（ratatui + ACP 客户端，包裹 DeepSeek Harness Node 内核 `dsh --profile acp`）的 UX/功能借鉴研究。
> 数据来源：https://github.com/MoonshotAI/kimi-code （默认分支 `main`，未 clone，全部通过 GitHub API / raw 文档在线读取）。
> 调研时间：2026-09（仓库 `pushed_at` 2026-08-31）。

---

## 1. 仓库概览

| 项目 | 值 |
| --- | --- |
| 仓库 | [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) |
| 默认分支 | `main` |
| 许可证 | MIT（[LICENSE](https://github.com/MoonshotAI/kimi-code/blob/main/LICENSE)） |
| 语言 | TypeScript（pnpm monorepo） |
| 定位 | "Kimi Code CLI — The Starting Point for Next-Gen Agents"，终端 AI 编码代理 |

### 1.1 Monorepo 结构

由 [root package.json](https://github.com/MoonshotAI/kimi-code/blob/main/package.json) 与 [AGENTS.md](https://github.com/MoonshotAI/kimi-code/blob/main/AGENTS.md) 的 Project Map 可得：

- **`apps/kimi-code`** — CLI / TUI 应用本体（本调研重点）。入口链：`src/main.ts` → `src/cli/commands.ts` → `src/cli/run-shell.ts` → SDK `KimiHarness` → `src/tui/kimi-tui.ts`。TUI 只通过 `@moonshot-ai/kimi-code-sdk` 消费内核能力，**禁止直接 import `@moonshot-ai/agent-core`**（与 dsh-tui-rust "Rust 只做前端壳" 的架构原则同构）。
- **`apps/kimi-inspect`** / **`apps/vis`** — 会话/转写调试可视化工具。
- **`apps/vscode`** — VS Code 插件（仓库里仅有壳）。
- **`packages/agent-core`**（v1 引擎）与 **`packages/agent-core-v2`**（v2 引擎，DI×Scope 架构，`LifecycleScope`：App/Workspace/Session/Agent 四层）— 统一 agent 引擎：Agent、Session、profile、skills、tools、plan、permission、background、records 等。
- **`packages/kap-server`** — Kimi Code 服务端（REST + WebSocket，基于 agent-core-v2）；**`packages/klient`** — 客户端 SDK。
- **`packages/kosong`**（LLM/provider 抽象）、**`packages/kaos`**（执行环境与文件/进程抽象）、**`packages/oauth`**、**`packages/telemetry`**、**`packages/transcript`**（转写渲染数据层）、**`packages/minidb`**（嵌入式 JSON 文档库）、**`packages/tree-sitter-bash`**（纯 TS bash 解析器）、**`packages/protocol`**、**`packages/acp-adapter`** / **`packages/acp-server`**（ACP 面）。
- **`packages/pi-tui`** — **TUI 组件库**。README [致谢](https://github.com/MoonshotAI/kimi-code/blob/main/README.md)明确："Our TUI is built on top of [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui)"（earendil-works/pi-mono 的 TUI 包，vendored 进 monorepo）。
- **`docs/`** — VitePress 双语文档站（en/zh）。
- **`plugins/`** — 官方/精选插件与 marketplace 清单（`marketplace.json`）。
- **`.agents/`** — 仓库自带的 agent skills（如 `write-tui`、`gen-changesets`、`agent-core-dev`）。

### 1.2 构建方式

- **Node.js ≥ 24.15.0 + pnpm 10.33.0**（`.npmrc` 设 `engine-strict=true`），脚本：`pnpm dev:cli` / `pnpm test`（vitest）/ `pnpm typecheck` / `pnpm lint`（oxlint）/ `pnpm build`（tsdown 打包）。
- 发布形态：**单二进制**（安装脚本下载预编译产物，终端用户无需 Node），`apps/kimi-code/tsdown.native.config.ts` 负责 native 打包；另有 Nix flake（`flake.nix`）与 npm 分发两条路径。还内置 `kimi web`（本地 REST/WS 服务 + 浏览器 UI，预构建 bundle 在 `apps/kimi-code/dist-web`，由另一个 code-app 仓库同步而来）。
- **双引擎并存**：`kimi`/`kimi -p`/`kimi acp` 默认走 v2 引擎（agent-core-v2 + kap-server），`KIMI_CODE_LEGACY_FLAG=1` 切回 v1（agent-core）。

### 1.3 TUI 技术

基于 **pi-tui**（earendil-works/pi-mono 的终端 UI 框架，Kimi 自建组件体系）。应用层 TUI 布局见 [apps/kimi-code/AGENTS.md](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/AGENTS.md)：

- `src/tui/kimi-tui.ts` — `KimiTUI` 总协调器：接线 state、布局、编辑器、会话、SDK 事件、对话框，**并分发 slash 命令 handler**；重逻辑下沉到 `controllers/`。
- `src/tui/commands/` — **slash 命令的定义、解析、排序与动态 skill 命令生成**。
- `src/tui/controllers/` — `session-event-handler`（SDK 事件路由）、`streaming-ui`（流式渲染）、`session-replay`（resume/回放）、`tasks-browser`、`editor-keyboard`、`auth-flow`。
- `src/tui/components/` — chrome（footer/todo/welcome）、dialogs（选择器/审批面板/问题弹窗/设置弹窗）、editor（输入框 + 文件引用补全）、media（image/diff/code highlight）、messages（assistant/tool call/thinking/usage/subagent 块）、panes（activity/queue 侧栏）。
- `src/tui/reverse-rpc/` — 把 SDK 的审批/提问回调翻译成 UI 面板数据、把用户选择转回 SDK 响应（**正是 dsh-tui `src/acp.rs` 中 `session/request_permission` 处理的对应物**）。
- `src/tui/theme/` — 主题/颜色 token 的唯一来源；规定"不得直接用 chalk 具名颜色"（CI 有 guard 测试）。

TUI 侧规范细节（对 dsh-tui 有直接参考价值）：可打印字符比较必须走 `printableChar()` 解码（Kitty 键盘协议下 `q` 会以 CSI-u 序列 `\x1b[113u` 到达，裸比较永不命中）；`KimiTUI.start()` 到工作区信任门之前禁止按裸命令名 spawn 子进程（Windows 上 cmd.exe/CreateProcess 会先解析当前目录，工作区里被植入的二进制会在用户确认信任前执行）——这是 dsh-tui 启动 `dsh` 子进程前值得抄的安全约束。

---

## 2. 功能深入

### 2.1 Slash 命令系统

文档：[slash-commands.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/slash-commands.md)、[kimi-command.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/kimi-command.md)。

**UX**：输入框内敲 `/` 弹出命令补全菜单，边输边过滤，**别名也参与匹配**；`Esc` 关闭；`/` 开头的输入若不匹配任何内置或 Skill 命令，则作为普通消息发给 Agent。部分命令只在 **idle 态**可用（流式中执行会被拦截，需先 `Esc`/`Ctrl-C` 打断），表中有 "Always available" 列标注。

**命令全集**（按组）：

| 组 | 命令 |
| --- | --- |
| 账号/配置 | `/login`（OAuth device-code 或 API key）、`/logout`、`/provider`、`/model`、`/secondary-model`（子代理模型池）、`/settings`、`/experiments`、`/permission`（选权限模式）、`/editor`、`/theme` |
| 会话管理 | `/new`(alias `/clear`)、`/sessions`(alias `/resume`)、`/tasks`、`/fork`（fork 后打印 `kimi --resume` 命令并复制到剪贴板）、`/title`(alias `/rename`)、`/compact [hint]`、`/undo [n]`（回滚 prompt、todo、plan 状态；压缩前的 prompt 不可撤销）、`/reload`、`/reload-tui`、`/init`（分析代码库生成 AGENTS.md）、`/export-md`、`/export-debug-zip`、`/copy`、`/add-dir`、`/web` |
| 模式/运行控制 | `/yolo [on|off]`、`/auto [on|off]`、`/plan [on|off]`、`/plan clear`、`/swarm`、`/goal [...]`（自主目标：status/pause/resume/cancel/replace/next，非交互 `kimi -p` 下退出码 0=完成/3=阻塞/6=暂停） |
| 信息/状态 | `/help`(alias `/h`,`/?`)、`/btw [question]`（fork 出旁路子代理问答，不干扰主回合）、`/usage`（token/上下文/配额）、`/status`、`/mcp`（服务器连接状态）、`/plugins`、`/version`、`/feedback` |
| 退出 | `/exit`(alias `/quit`,`/q`) |

**内置 Skill 即命令**：`/mcp-config`（MCP 配置 + OAuth 登录）、`/custom-theme`、`/update-config`（检视/编辑 config.toml 与 tui.toml）、`/check-kimi-code-docs`、`/import-from-cc-codex`（导入 Claude Code/Codex 的指令、skills、MCP 设置）、`/sub-skill`（本地 skill 分层重组）。

**动态 Skill 命令**：已激活的外部 Skill 自动注册为 slash 命令，命名空间前缀 `/skill:<name> [extra text]`（后缀文本拼到 Skill prompt）；子 skill 以点号命令 `/parent.sub` 出现在面板；`flow` 类型 Skill 也在 `/skill:` 下暴露。**忙时输入的 Skill 命令会排队而不是被拒**，按 `Ctrl-S` 可把排队的命令立即注入当前回合。

**实现位置**：声明/解析/排序在 `apps/kimi-code/src/tui/commands/`，执行分派在 `src/tui/kimi-tui.ts`；动态 skill 命令生成也在 commands 目录（见 [apps/kimi-code/AGENTS.md](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/AGENTS.md)）。

**CLI 侧等价物**：`kimi --session/-S`、`--continue/-c`、`--model/-m`、`--prompt/-p`（非交互，`--output-format stream-json`）、`--yolo/-y`、`--auto`、`--plan`、`--skills-dir`、`--agent`、`--agent-file`、`--add-dir`；子命令 `login`/`acp`/`web`/`doctor`/`export`/`migrate`/`upgrade`/`vis`/`provider`。

### 2.2 权限/审批系统

文档：[interaction.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/guides/interaction.md)、[config-files.md#permission](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/config-files.md)、[mcp.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/mcp.md)。

- **审批面板**：Agent 调用有副作用的工具（改文件、跑命令）时弹审批面板。`↑↓`+`Enter`，或按 `1`/`2`/`3` 直接选；`Esc`/`Ctrl-C`/`Ctrl-D` 拒绝；`Ctrl-E` 展开面板内 diff/文件预览。选项含：
  - **"Approve for this session"**（会话级自动放行同类调用）；
  - **永久规则**：写入配置文件（`[[permission.rules]]`）。
- **权限模式**（`/permission` 或启动参数）：
  - `manual`：每次询问；
  - `yolo`（`/yolo`）：常规工具调用自动放行，但敏感文件（`.env`、SSH key）与退出 Plan 模式仍会问，Agent 仍可提问；
  - `auto`（`/auto`）：完全无人值守，包括敏感文件和 plan 退出，Agent 不提问。
- **规则语法**（`config.toml`，按顺序首条匹配生效）：
  ```toml
  [[permission.rules]]
  decision = "allow"          # allow | deny | ask
  scope = "user"              # turn-override | session-runtime | project | user
  pattern = "Read"            # 工具名 或 工具名(参数模式)，如 Bash(rm -rf*)
  reason = "审计说明"
  ```
  MCP 工具按 glob 匹配：`mcp__github__*`。参数模式仅部分内置工具支持（`Bash(command-pattern)`、`Read(path-pattern)`）。
- **只读默认放行**：Read/Grep/Glob 等只读工具默认不询问（getting-started 明确"Read-only operations are executed automatically by default"）。
- **子代理权限继承**：主 Agent 接受的 "always allow" 规则自动传播给其派发的所有子代理（见 [agents.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/agents.md)）；`Agent` 工具本身默认放行。
- 实现侧：审批逻辑在内核（agent-core 的 permission 模块），TUI 通过 `src/tui/reverse-rpc/` 桥接 SDK 回调与 UI 面板。

### 2.3 生命周期 Hooks（本地脚本钩子）

文档：[hooks.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/hooks.md)。**这是 dsh 内核目前没有、kimi 独有的机制**，也是本次调研最有借鉴价值的点。

- **配置**：`~/.kimi-code/config.toml` 的 `[[hooks]]` 数组，每条约 4 个字段：
  | 字段 | 类型 | 说明 |
  | --- | --- | --- |
  | `event` | string | 必填，事件名（见下表） |
  | `matcher` | string | 可选，正则过滤事件目标 |
  | `command` | string | 必填，触发的 shell 命令 |
  | `timeout` | integer | 秒，1–600，默认 30 |
  多规则命中同事件时**并行执行**；工作目录 = 会话项目目录；非 Windows 下置于独立进程组，超时先发信号再强杀。
- **数据流**：触发时 CLI 把事件详情（触发原因、工具名、命令内容等）打包成 JSON，经 **stdin** 传给脚本；脚本以**退出码 + stdout** 应答：
  - `0` = 放行（stdout 可附加到上下文）；
  - `2` = 拦截（stderr 内容作为拦截理由写回上下文，模型据此换更安全的做法）；
  - 其他非零 / 超时 / 崩溃 = **fail-open**（默认放行，钩子错误不阻塞工作）。
  - 也可通过 stdout 返回 JSON `{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "..."}}` 来拦截。
- **只有 3 个事件可拦截**：`PreToolUse`（工具调用前、**权限检查之前**）、`Stop`（模型回合将结束，可追加消息让模型继续）、`UserPromptSubmit`（用户提交消息，返回文本追加到上下文，拦截则本轮不调模型）。其余为 fire-and-forget 观察事件。
- **事件全集**：`UserPromptSubmit`、`UserPromptQueued`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`Stop`、`StopFailure`、`TurnStarted`、`Interrupt`（用户 Esc 打断）、`SessionStart(startup|resume)`、`SessionEnd(exit|archive)`、`SessionHeartbeat`（配置了才启 60s 定时器）、`SubagentStart`/`SubagentStop`、`TaskStarted`、`PreCompact(manual|auto)`/`PostCompact`、`PermissionRequest`/`PermissionResult`、`Notification(task.completed)`。
- **典型用法**：安全拦截（`PreToolUse` + `Bash` matcher，脚本检测 `rm -rf` 等）、桌面通知（`Notification`/`SubagentStop`）、自动附加上下文（`UserPromptSubmit` 时注入 git 分支等）。
- **插件也可声明 hooks**（manifest `hooks` 字段，字段同 `[[hooks]]`，工作目录=插件根，多两个环境变量 `KIMI_CODE_HOME`/`KIMI_PLUGIN_ROOT`，仅插件启用时生效）。
- 官方警告：因为 fail-open，Hooks 适合告警和轻量拦截，**不能作为唯一安全屏障**——高危操作仍靠权限审批与人工确认。

### 2.4 子代理（Subagents）

文档：[agents.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/agents.md)、[config-files.md#secondary_model](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/config-files.md)。

- **内置三件套**：
  - `coder`：默认子代理，通用软件工程助手（可读写文件、执行命令、搜索、落地修改）；
  - `explore`：**只读**代码库探索，不改任何文件；
  - `plan`：只做实现规划/架构设计，**连 shell 都不可用**。
- **分派方式**：主 Agent 通过 `Agent`（单发）与 `AgentSwarm`（并行多发，有 `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` 并发上限）工具调度；每次分派在终端呈现为审批请求（除非命中放行规则或 YOLO 模式）；也支持后台运行子代理（完成自动回传，无需轮询），可回叫已有子代理实例继续任务。
- **上下文隔离**：每个子代理独立上下文窗口，只看主 Agent 显式传入的任务描述，看不到主对话历史；中间推理与工具调用记录不回灌，只有最终结果进主上下文。代价是独立消耗 token。
- **递归保护**：内置子代理不能再派发子代理；自定义 agent 默认继承 `coder, explore, plan` 白名单（成员不可再派发），链条必然终止；只有显式声明 `subagents` 白名单才能开更深层级。
- **自定义 agent 文件**：Markdown + YAML frontmatter（`name`/`description`/`whenToUse`/`override`/`tools`/`disallowedTools`/`subagents`），body 即系统提示词，支持 `${base_prompt}`、`${skills}`、`${agents_md}`、`${cwd}` 等模板变量。发现层级：**Explicit(--agent-file) > Project > Extra > User > Plugin > Built-in**。项目级 `agents/` 文件可能用 `override: true` 整个替换内置系统提示词——官方明确警告"不信任的仓库里的 agent 文件即脚本，运行前要审查"。
- **子代理模型池**（实验特性 `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1`）：`[secondary_model]` 给子代理配便宜模型池 + `default_model` + `force` 固定；`Agent`/`AgentSwarm` 工具获得 `model` 参数，主 Agent 按池内说明文字逐次选择；`"primary"` 保留字表示继承调用方模型。
- **持久化**：子代理运行时状态存会话目录 `agents/<id>/wire.jsonl`（prompts、消息、最终状态按时间序）。
- **`/btw`**：开一个旁路子代理问答，完全不占主回合。

### 2.5 会话（Sessions）

文档：[sessions.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/guides/sessions.md)、[data-locations.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/data-locations.md)、[slash-commands.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/slash-commands.md)。

- **存储**：`$KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/`，`state.json` 存元数据（**title**、lastPrompt、时间戳、forkedFrom），`agents/main/wire.jsonl` 存主代理完整事件流（用于恢复与回放，还带请求轨迹：发给模型的 tool schema、请求参数、MCP 工具清单，可调试）；顶层 `session_index.jsonl` 索引（每行 sessionId/sessionDir/workDir）。输入历史按工作目录单独存 `user-history/<md5(workDir)>.jsonl`。
- **新建/恢复**：`kimi` 直接建新会话；`kimi --continue` 恢复当前目录最近会话；`kimi --session [id]` 指定或交互选择；`/new` 丢弃当前上下文开新会话；`/sessions`(alias `/resume`) 浏览历史。
- **标题**：`/title [文本]`（无参数显示当前标题，有参数设置，上限 200 字符）；标题持久化在 `state.json`。
- **压缩/上下文管理**：接近窗口上限时**自动压缩**（触发阈值 `loop_control.reserved_context_size`）；`/compact [hint]` 手动压缩，hint 提示模型保留什么。压缩有 `PreCompact`/`PostCompact` 钩子事件，压缩摘要可在 UI 里 `Ctrl-O` 折叠展开。
- **fork**：`/fork` 保留完整历史复制出新会话，**当前会话不受影响**，打印并复制 `kimi --resume` 命令供新终端进入；已保存的 `/goal` 不复制。
- **导出**：`kimi export <sessionId>` 打 ZIP（含诊断日志）；TUI 内 `/export-debug-zip`、`/export-md`（人类可读 Markdown 转写）。
- **undo**：`/undo [n]` 撤销最近 n 条 prompt（含 todo 列表与 plan 状态回滚，不改代码）；压缩前的 prompt 不可撤销。
- 缓存过期提示：`tui.toml` 的 `cache_expiry_hint`——恢复久置会话或长时间空闲后提交时弹窗提示"上下文缓存大概率已过期"，建议压缩或开新会话（v2 引擎）。

### 2.6 MCP 配置 UX（`/mcp-config`）

文档：[mcp.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/mcp.md)、[slash-commands.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/slash-commands.md)。

- `/mcp-config` 是内置 Skill 命令：**AI 原生会话式编辑** MCP 服务器配置（添加/编辑/删除/认证），用户不必手写 JSON；`/mcp` 查看当前会话所有服务器的连接状态。
- 配置存 `mcp.json` 两级（用户级 `~/.kimi-code/mcp.json` + 项目级 `.kimi-code/mcp.json`，同名项目级覆盖用户级）。结构：
  ```json
  {
    "mcpServers": {
      "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
      "linear": { "url": "https://mcp.linear.app/mcp" },
      "legacy": { "transport": "sse", "url": "https://mcp.example.com/sse" }
    }
  }
  ```
  支持 stdio / HTTP / SSE 三种传输；可选字段 `env`、`cwd`、`headers`、`bearerTokenEnvVar`（HTTP/SSE 凭据）、`enabled`、`startupTimeoutMs`、`toolTimeoutMs`、`enabledTools`/`disabledTools`（工具白/黑名单）；HTTP/SSE 的 OAuth 通过 `/mcp-config login <name>` 走浏览器授权。
- **工具命名与权限**：`mcp__<server>__<tool>`，权限规则用 `*`/`**` 通配（如 `mcp__github__*`）；未命中规则即弹审批；会话级 "Approve for this session" 同样适用。
- **安全细节**：项目级 stdio MCP 服务器会在工作区信任提示里逐个展示传输与启动命令，**默认 "Don't trust"**；删除配置不打断已开会话（`/mcp` 里标 `removed`，调用失败并给提示）；会话中途新增的服务器只进之后的新会话；YOLO 模式下 MCP 工具自动放行，官方警告只在完全信任服务器时使用。

### 2.7 插件 / Skill 生态

文档：[plugins.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/plugins.md)、[skills.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/skills.md)、[marketplace.json](https://github.com/MoonshotAI/kimi-code/blob/main/plugins/marketplace.json)。

- **Skill**：Markdown + YAML frontmatter（`name`/`description`/`type: prompt|inline|flow`/`whenToUse`/`disableModelInvocation`/`arguments`），body 支持占位符 `$ARGUMENTS`、`$0..$n`、`$<arg>`、`${KIMI_SKILL_DIR}`。发现层级 **Project > User > Extra > Built-in**（`.kimi-code/skills/`、`~/.agents/skills/`、`extra_skill_dirs`）。模型可按 `description`/`whenToUse` 自动调用（`disableModelInvocation` 可关）；最多 3 层嵌套。目录形态 `SKILL.md` + 同目录脚本/参考资料。
- **插件**：目录或 zip，manifest `kimi.plugin.json`（或 `.kimi-plugin/plugin.json`）。可携带：`skills`、`agents`（自定义 agent）、`sessionStart.skill`（会话开始时自动装载某个 Skill，只注入文本不执行代码）、`systemPrompt`/`systemPromptPath`（系统提示词贡献，单条 32KB、总预算 64KB）、`mcpServers`、`hooks`、`commands`（把 Markdown 文件注册为 `/pluginId:command` 带 `$ARGUMENTS` 替换的提示词命令）。
- **安装/管理**：`/plugins` 面板四个 Tab（Installed/Official/Curated/Custom），快捷键 Space 启用/禁用、D 移除、M 管理 MCP、I 详情、R 重载；也支持 `/plugins install <本地目录|zip URL|GitHub URL>`（4 种 GitHub 形式：release/分支标签/提交），网络只走 `github.com` 与 `codeload.github.com`。
- **信任模型**（README 宣传"每个安装的信任级别 upfront 呈现"）：具体机制是——来源分档（official=Kimi 维护 / curated=精选 / custom=任意 URL）、安装过程**不执行任何命令型工具与旧工具运行时**、所有路径解析后必须留在插件根内（含符号链接）、坏 manifest/不安全路径进 `/plugins info` 诊断、项目级 MCP 服务器有工作区信任门（默认不信任）。插件变更需 `/reload` 或新会话生效。
- **市场**：`marketplace.json`（version 1）当前含 `kimi-datasource`（金融/宏观/法律/学术数据 MCP）、`kimi-webbridge`（驱动真实浏览器）、`kimi-computer-use`（桌面 GUI 操作），及 curated 的 `superpowers`、`vercel-plugin`、`modern-web-guidance`。
- 数据位置：`$KIMI_CODE_HOME/plugins/installed.json`（安装记录与启用态）+ `plugins/managed/`（本地/zip 安装的托管副本，**始终运行托管副本**，改源目录需重装）。

### 2.8 视频 / 附件输入

文档：[interaction.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/guides/interaction.md)、[keyboard.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/keyboard.md)、[config-files.md#image](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/config-files.md)。

- **粘贴**：macOS/Linux `Ctrl-V`、Windows `Alt-V`，直接粘贴剪贴板里的图片/视频到输入框；输入框显示**可编辑占位符**，提交时替换为真实媒体内容；纯文本剪贴板回退为普通粘贴。
- **能力门控**：媒体支持取决于当前模型的多模态能力（`image_in` / `video_in`，在 `[models]` 的 `capabilities` 里声明；k3 系列支持 video_in）。
- **压缩管线**：`[image] max_edge_px`（默认 2000 最长边缩放）、`read_byte_budget`（默认 256KB 每图字节预算，约束模型反复截图读图时的请求体大小）；模型通过 `ReadMediaFile` 工具读图，`region` 参数可按裁剪区全保真重读。
- **视频用例**（README 主打卖点）：粘贴录屏/演示片段，让 agent"看"难以言传的内容——参考片段转 LUT、长视频剪短、录屏转可运行代码等。
- 剪贴板读取的跨平台细节：Linux 依次试 Wayland 与 X11，WSL 回退用 PowerShell 读 Windows 剪贴板。
- 实现位置：`src/tui/components/editor/`（输入框 + 文件引用/媒体补全 provider）、`src/tui/components/media/`（image/diff/高亮展示）。

---

## 3. AGENTS.md 与 CONTRIBUTING.md（项目自身对 agent/人的规则）

### 3.1 根 [AGENTS.md](https://github.com/MoonshotAI/kimi-code/blob/main/AGENTS.md)

面向 agent 协作开发的 TypeScript monorepo，根文件只放"热路径"规则：

- **工作原则**：以代码而非文档为准；改代码前先读相关代码与最近的 `AGENTS.md`；改动聚焦、不夹带无关重构；提交**不得加 co-author 署名、不得暴露 agent 身份**（commit message / PR 描述 / 说明文本）。
- **Project Map**（上文 1.1 已详述），特别标注：**"When writing or modifying its terminal UI, use the `write-tui` skill（`.agents/skills/write-tui/SKILL.md`）"**——TUI 的架构取向、新功能放哪、测试位置、主题机制、对话框交互/视觉规范（DESIGN.md）都在该 skill 里。
- **环境**：Node ≥ 24.15.0、pnpm 10.33.0、`engine-strict=true`。
- **Monorepo 维护**：增删 workspace 包必须**同时**更新 `pnpm-workspace.yaml` 与硬编码的 `flake.nix`（`workspacePaths`/`workspaceNames` 两份列表），自动化检查只覆盖核心包闭包、漏检叶子包。
- **编码规则**：agent-core-v2 / kap-server / transcript 是**无注释区**（只允许导出符号上的 JSDoc 与 lint 抑制指令，CI 强检）；可选属性直接传 `undefined` 而非条件展开；单参数内部方法不做 options 对象；测试尽量并入既有文件；测试失败先修测试；破坏性变更走 changesets + major。
- **实验特性**：未公开功能必须置于 env 开关后（`KIMI_CODE_EXPERIMENTAL_*` 单开，`KIMI_CODE_EXPERIMENTAL_FLAG` 全开），发布时翻 `default`。
- **工作流**：优先 `rg`；公开文本/测试数据用中性占位符；PR 标题走 Conventional Commits；agent 开 PR 必须填模板（链接 issue、说明改了什么，禁止 AI 味套话）；提交前必须跑 `gen-changesets` skill 生成 changeset（一句话用户可感知的变化；**禁止自行决定 major**，默认 minor 回退 patch）；禁止提交草稿/交接文档（`HANDOVER-*`、`*-designs.html` 等），临时文件放 `.tmp/`（gitignored）。

### 3.2 [CONTRIBUTING.md](https://github.com/MoonshotAI/kimi-code/blob/main/CONTRIBUTING.md)（另有 [中文版](https://github.com/MoonshotAI/kimi-code/blob/main/CONTRIBUTING.zh-CN.md)）

- **先讨论后编码**：新功能/用户可见行为变更/超 100 行重构/公共 API 变更/原因不明的 bug 修复，先开 issue；无讨论的 PR 可能直接关闭。清晰可复现的 bug 修复、文档/CI 小改、与既有 issue 完全吻合的小改动可直开 PR。
- **对 AI 贡献者的要求**：与手写贡献同一标准——**必须理解自己提交的东西**（改了什么、边界行为、为何适合本代码库），讲不清楚就是没准备好。
- **开发设置**：`pnpm install` 后 `pnpm dev:cli` / `pnpm test` / `pnpm typecheck`（会先 build 包）/ `pnpm lint`（oxlint）。
- **Commit 约定**：Conventional Commits（feat/fix/docs/chore/refactor/test/ci/build/perf/style），PR 标题由 `pr-title-checker` CI 强制。
- **Changesets**：影响发布产物的 PR 必须带 changeset；文档/测试/CI-only 可跳过；仓库内约定见 `.changeset/README.md`，agent 协作时用 `gen-changesets` skill。
- **Code style**：全 TS、oxlint、`pnpm lint:fix` 自动格式化。
- **与 TUI 包直接相关的**：见 1.3 节——`apps/kimi-code/AGENTS.md` 规定了 TUI 文件布局、模块职责边界（cli 只解析参数、KimiTUI 只协调不积累业务规则、components 不得直接调 SDK 或读写会话状态、theme 是颜色唯一来源）、可打印字符解码规范、色彩规范（禁 chalk 具名色、对比度 4.5:1/3:1、禁顶层缓存 styled chalk、主题切换须单帧内生效，均有 CI guard 测试）、以及信任门之前禁裸命令名 spawn 子进程的安全约束。

---

## 4. 对 dsh-tui-rust 的可落地建议（按 性价比 排序）

> 映射前提（来自 dsh-tui-rust README 与 src/acp.rs）：TUI 已有 `/` 命令菜单（静态列表）、权限弹窗（渲染内核给的 option 列表）、会话 list/resume（需 cwd）、模型/推理档位热切换（`set_config_option`）、忙时消息队列、工具卡 + rawInput 预览、usage 进度条、`/web`。dsh 内核已具备：skills、MCP client、subagent、权限请求、会话持久化、压缩、插件生态。**dsh ACP 面不支持**：client filesystem、elicitation、terminals、modes/plans；resume 需额外 `cwd` 参数；ACP 面禁用了模型生成会话标题。

**推荐 1：生命周期 Hooks（客户端实现）—— 内核没有、纯 TUI 可做，收益最大**
- kimi 机制：`[[hooks]]`（event/matcher/command/timeout）+ stdin JSON + 退出码 0 放行 / 2 拦截 + fail-open + `PreToolUse`/`Stop`/`UserPromptSubmit` 三个可拦截事件（见 2.3）。
- dsh 映射：dsh ACP 的 `tool_call` 通知 → 权限 `session/request_permission` 之间就是 TUI 的拦截窗口。TUI 在应答权限前先跑匹配的本地钩子：钩子拒绝则直接回 `cancelled` 并注明原因；`PromptSettled` 后可发桌面通知（`Notification` 事件等价物）；`UserPromptSubmit` 前可注入上下文。配置放 `~/.dsh-tui/hooks.toml`，零内核改动。
- 努力：中高；影响：高（安全拦截 + 通知 + 审计，全终端类工具通用卖点）。

**推荐 2：权限弹窗增强——会话级放行 + 本地永久规则层**
- kimi 机制：审批面板 "Approve for this session" + `[[permission.rules]]`（`decision`/`scope`/`pattern`/`reason`，工具名或 `Bash(rm -rf*)` 参数模式，MCP 通配 `mcp__xxx__*`）。
- dsh 映射：dsh 内核的 `request_permission` option 列表里可能已有会话级选项（TUI 照渲染即可）；**TUI 侧补一层** `~/.dsh-tui/permission.json` 的本地规则（按工具标题/rawInput 前缀匹配），命中 allow/deny 就直接自动应答，命中 ask 才弹窗——不依赖内核是否支持，且可覆盖 `tool_title` 与 `rawInput`。
- 努力：中；影响：高（长会话不再被重复审批打断；可给"只读工具永不问"的默认策略）。

**推荐 3：/compact 与上下文管理 UX**
- kimi 机制：`/compact [hint]`（hint 指示保留重点）+ 接近窗口自动压缩 + `PreCompact`/`PostCompact` + 压缩摘要可折叠 + 缓存过期提示弹窗 + `/usage` 面板（token/上下文/配额）。
- dsh 映射：dsh 内核已具备压缩能力（README 明确"压缩"在内核能力清单），但 ACP 面是否暴露压缩方法需要探针验证——若未暴露，这是**内核侧缺口**，TUI 可先用"提示用户"或经 `/web` API 变通。至少可做：usage 进度条已有（>70% 黄 / >90% 红），补 `/usage` 明细面板与"压缩后摘要折叠（Ctrl-O）"。
- 努力：中；影响：高（长会话的 token 经济学是 CLI 用户最痛的日常）。

**推荐 4：命令菜单打磨——别名、分组、idle 门控、动态注册**
- kimi 机制：别名参与过滤（`/h`、`/?`、`/resume`）、面板分 Account/Session/Mode/Info/Exit 组、idle-only 与 "Always available" 标注、**激活的 skill 动态注册为 `/skill:<name>`**、忙时命令排队 + `Ctrl-S` 注入、`$ARGUMENTS` 参数展开。
- dsh 映射：dsh-tui 的 `COMMANDS` 是静态 `&[Cmd]`（src/app.rs）；可低成本加别名、描述分组与忙时禁用（`/list` 忙时已拒，但菜单还亮着）；dsh 有 skills——TUI 可启动时查询（如 `dsh` 的 skill 目录或内核能力）动态生成 `/skill:<name>` 项，未匹配命令降级为普通消息（kimi 行为）。
- 努力：低–中；影响：高（每天触达的入口）。

**推荐 5：会话标题生成（廉价模型或本地启发式）**
- kimi 机制：标题持久化在 `state.json`，`/title [文本]` 手动设置/查看（见 2.5）。
- dsh 映射：dsh ACP 面禁用模型生成标题（dsh-tui README 已知限制），会话列表按 cwd+短 ID 展示。TUI 可：首个回合结束后取第一条用户消息/首段回复，做本地启发式摘要（截断/关键词）或**走一条廉价模型补丁路径**（dsh 有 `llm-pi-ai` 提供商 + 非交互模式可用），存 `~/.dsh-tui/session-titles.json`，会话列表与状态栏显示。这是纯客户端、不改内核。
- 努力：中；影响：中高（"恢复哪个会话"的辨识度）。

**推荐 6：工具输出折叠与 diff 视图**
- kimi 机制：长工具输出自动折叠成卡片，`Ctrl-O` 全局切换折叠/展开，审批面板 `Ctrl-E` 展开 diff/文件预览（见 keyboard.md）。
- dsh 映射：dsh-tui 已有工具卡 + rawInput 预览但**不渲染工具输出**（只有状态点）。ACP `tool_call`/`tool_call_update` 有 status 流转，输出本身是否随 ACP 事件回传需验证（内核工具结果通常进上下文）。diff 视图已在 Phase 2 roadmap——kimi 的"折叠卡片 + 快捷键开关"交互值得直接抄。
- 努力：中；影响：中高（长命令输出的可读性）。

**推荐 7：图片粘贴输入（ACP image content block）**
- kimi 机制：`Ctrl-V`/`Alt-V` 粘贴图片/视频 + 可编辑占位符 + 模型 `image_in`/`video_in` 能力门控 + `[image]` 压缩（见 2.8）；kimi 的 ACP 面声明 `promptCapabilities.image=true`。
- dsh 映射：ACP 标准 `session/prompt` 支持 `{type:"image", ...}` content block；dsh 是否接受 image block 需实测（现 probe 只发 text）。TUI 做剪贴板图片 → base64 block + 占位符编辑 + 按模型能力禁用/提示。
- 努力：中；影响：中（截图/报错图直接对话，Phase 1 后很自然的增量）。

**推荐 8：状态栏自定义（status_line）**
- kimi 机制：`tui.toml` `[status_line] items`（mode/goal/model/tasks/cwd/git/tips 插槽顺序）+ `command`（自定义命令，首行替换状态栏，stdin 收 JSON 快照：model/cwd/git 分支/权限模式/上下文用量/session id/版本，300ms 上限、1s 节流、失败回退内置布局）。
- dsh 映射：dsh-tui 状态行已显示 状态点/spinner/计时/滚动标尺/按键提示；加一个 `~/.dsh-tui/tui.toml` 的 items 配置与可选的 user command 即可。
- 努力：低；影响：中（个性化 + 把 git 分支等日常信息放眼前）。

**推荐 9：/init 与 AGENTS.md 工作流**
- kimi 机制：`/init` 分析当前代码库生成 `AGENTS.md`；`AGENTS.md` 内容经 `${agents_md}` 注入系统提示词（见 agents.md 的 SYSTEM.md 变量表）。
- dsh 映射：先验证 dsh 内核是否已注入 AGENTS.md（大概率支持，DeepSeek Harness 生态通用）；若注入已存在，TUI 只需 `/init` = 向内核发一条"分析本项目并生成/更新 AGENTS.md"的结构化 prompt（或写盘后提示 `/reload`）。
- 努力：低；影响：中（新项目 onboarding 的仪式感 + 长期上下文质量）。

**推荐 10（暂缓）：fork / 导出 / Plan 模式**
- kimi 的 `/fork`（打印 `--resume` 命令）、`/export-md`、Plan 模式都**依赖内核侧会话复制与 plan 状态**；dsh ACP 面明确无 modes/plans，fork/export 也未见对应方法。这些只能等内核 ACP 面扩展，或走 `/web` 的 REST API 变通——**先不做**，列入"内核能力雷达"。

**一句话总结**：最该抄的是 kimi 的**"壳层职责"**——hooks（PreToolUse 拦截/通知）、权限规则层、命令菜单的别名/分组/动态注册、标题与状态栏这类纯客户端 UX；凡是 dsh 内核已给的（skills/MCP/subagent/压缩），TUI 只做呈现与入口，不重复造轮子。

---

## 附：主要引用链接

- 仓库与 README：[MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) / [README.md](https://github.com/MoonshotAI/kimi-code/blob/main/README.md)
- AGENTS / CONTRIBUTING：[AGENTS.md](https://github.com/MoonshotAI/kimi-code/blob/main/AGENTS.md) / [CONTRIBUTING.md](https://github.com/MoonshotAI/kimi-code/blob/main/CONTRIBUTING.md) / [apps/kimi-code/AGENTS.md](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/AGENTS.md)
- 功能文档：[slash-commands.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/slash-commands.md) · [interaction.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/guides/interaction.md) · [sessions.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/guides/sessions.md) · [hooks.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/hooks.md) · [agents.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/agents.md) · [mcp.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/mcp.md) · [plugins.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/plugins.md) · [skills.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/skills.md) · [config-files.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/config-files.md) · [data-locations.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/data-locations.md) · [env-vars.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/env-vars.md) · [kimi-command.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/kimi-command.md) · [kimi-acp.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/kimi-acp.md) · [keyboard.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/keyboard.md) · [getting-started.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/guides/getting-started.md) · [use-cases.md](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/guides/use-cases.md)
- TUI 致谢：[pi-tui（earendil-works/pi-mono）](https://github.com/earendil-works/pi-mono/tree/main/packages/tui)
- 插件市场：[marketplace.json](https://github.com/MoonshotAI/kimi-code/blob/main/plugins/marketplace.json)
