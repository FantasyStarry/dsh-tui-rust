# DeepSeek Harness 仓库研究报告（面向 dsh-tui-rust）

> 研究目标：为 Rust TUI 客户端（dsh-tui-rust）包装 Node 内核 `dsh --profile acp`（ACP v1 over stdio）提供依据。
> 核心原则：Rust 只做终端前端；`dsh` 作为子进程运行、**永不修改内核**；一切经由标准 ACP v1 协议消费。
> 数据采集时间：2026-08-31（仓库 `master` 分支最新提交 `dd6322d`，即 `release: dsh@0.1.2-alpha.3`）。所有信息均来自 GitHub 仓库、npm registry 与官方文档站点，未克隆仓库。

---

## 1. 仓库基本事实

| 项目 | 结论 | 证据 |
|---|---|---|
| 仓库 | https://github.com/deepseek-ai/deepseek-harness | — |
| 默认分支 | **`master`**（不是 main） | GitHub API `default_branch: "master"` |
| 描述 | "DeepSeek Harness: Everything is a Plugin." | 仓库 description / README |
| 语言 | TypeScript（pnpm workspace 单体仓库） | API `language: "TypeScript"` |
| License | **MIT**（`LICENSE`；npm 包 0.1.0 起为 MIT，早期 0.0.1 系列为 BSD-3-Clause） | [LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)、npm registry |
| npm 最新版 | **`@deepseek-ai/dsh@0.1.1-rc.2`**（`latest`/`next` dist-tag）；**`0.1.2-alpha.3`** 在 `alpha` tag（2026-08-31 发布） | https://registry.npmjs.org/@deepseek-ai/dsh |
| 版本节奏 | 2026-08-10 首发 `0.0.1-rc.1` → 2026-08-31 `0.1.2-alpha.3`，21 天内 13 次发布，迭代极快 | npm `time` 字段 |
| 成熟度声明 | **Developer preview**，"THERE WILL BE COMPATIBILITY-BREAKING CHANGES" | [README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md) |
| 文档站点 | https://deepseek-harness.github.io/deepseek-harness/ （VitePress 投影，源码在 `website/`） | README |
| 官方主页 | https://deepseek.com/harness | GitHub API `homepage` |
| 二进制 | `dsh` → `lib/bin.js`（ESM，Node ≥ 22.19，支持 24+） | npm registry `bin` 字段 |

**架构哲学**：README 明确写着 "built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis)"。架构文档（[docs/architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)）进一步说明：

> "Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and the agent loop itself, so each is replaceable from configuration. There is no privileged core to patch: you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads."

即：**没有可 patch 的特权核心**——模型适配器、工具注册表、会话日志、agent 主循环本身都是插件；扩展 dsh = 在旁边挂一个插件；所有注册都是"效应"（effect），插件卸载时自动回卷。Cordis 设计思想来自论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

**文档组织**（仓库 `docs/` 目录，全部中英双语 `.md`/`.zh.md` 配对，经 `.i18n.yaml` 对齐）：

- `docs/architecture.md` —— 有序地图：组合机制、核心包、事件、主循环、capability seam、扩展点表。**改 `packages/` 前必读**。
- `docs/development.md` —— 贡献者入门：前置条件、构建（`pnpm run build`）、tsconfig Host/Client 双聚合、CI、常用命令。
- 根 `AGENTS.md` —— 面向 agent 的"常驻命令"（standing orders）；`docs/AGENTS.md` —— 文档写作标准（分层：architecture / subsystems / Agent Notes / cookbook / user / 生成目录）。
- `docs/cordis-primer.md`（+ `docs/cordis-tutorial/`）—— Cordis 入门。
- **生成的目录**（从源码生成、有保鲜检查）：`docs/config-catalog.md`（146KB，每个插件的配置字段 JSDoc）、`docs/tool-catalog.md`（92KB，工具清单）、`docs/persistence-catalog.md`、`docs/module-graph.md`、`docs/capability-seams.md`、`docs/subsystems/*`（按包组的子系统参考页，含 `ts type-equiv` 源码等价声明）。
- `docs/cookbook/` —— 扩展手册：`extension-cookbook.md`（插件形状）、`adding-a-package.md`、`adding-a-tool.md`、`adding-an-llm-adapter.md`、`adding-a-settings-card.md`。
- `docs/user/` —— 产品向指南（Web UI guide、develop/practice）。
- `.agents/notes/` —— Agent Notes（决策记录，`implemented/` 表示已落地）。

---

## 2. 插件系统深挖

### 2.1 基本模型（Cordis）

插件是挂到共享 `ctx` 上的服务（service）+ 类型化事件（typed event）+ 可逆效应（reversible effect）。注册 = 效应，插件卸载自动撤销。事件是扩展点：会话事件（`session/event`，持久事实）、agent 事件（`agent/*`，活体 Agent 的 inbox/step/status/request/validation/continuation）、capability 事件（`fs/*`、`tools/*`、`telemetry/*`）。瀑布式事件（waterfall）如 `agent/pre-step`、`agent/request`、`llm/stream`、`tools/*` 的监听器必须调用 `next()` 放行；`agent/turn-stopping` 是串行的。

### 2.2 Bundle：插件的分发格式

**bundle** 是"Cordis 配置行 + 其挂载代码"的分发格式，保证上层仍可 patch 它插入的任何行（[docs/architecture.md#profiles-and-bundles](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)）。声明方式：在包自己的 `package.json` 的 `dsh` 字段里：

- `dsh.profile.bundles` —— profile 依次叠加的 bundle 列表；
- `dsh.bundle` —— 指向该 bundle 的 patch 文件（如 `cordis.patch.yml`）。

bundle 目录：`packages/bundle/{base, web-app, headless, sdk-app, sdk-minimal, acp-app}`。`dsh-base`（`packages/bundle/base/`）是 `web`/`headless`/`sdk`/`acp` 四个 profile 共享的第一层：模型适配器、全套工具、持久化、沙箱与审批策略、settings、credentials、遥测。`dsh-acp-app` 在其上追加"仅自动化的 ACP 服务器"。`sdk-minimal` 是刻意例外：单个 bundle 持有完整的显式 SDK 树，不套 `dsh-base`。

### 2.3 Profile：命名组合

一个 profile 是 Harness home（默认 `~/.dsh`，见下）下 `profiles/<name>/` 目录，含：

- `package.json`：out-of-tree 插件依赖 + profile 清单 `dsh.profile`（有序 `bundles` 列表 + `patchReload: live | startup`）；
- `cordis.patch.yml`：用户自己的 patch 层。

出厂模板：`web`、`headless`、`sdk`、`sdk-minimal`、`acp`（首次使用自动初始化）；**其他 profile 必须通过 `dsh plugin` 创建**。

**层叠顺序**（[apps/cli/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)）：

```
空根
 → 每个 dsh.profile.bundles 里的 bundle patch（按列表顺序）
 → profile 自己的 cordis.patch.yml
 → home 级 $DSH_HOME/cordis.patch.yml（层级最高）
 → --patch 覆盖
```

- patch 按 **id 定位一行并整体替换其 config（不做深合并）**，或 `insert` 新行；支持 `!!js` 表达式（如 `disabled: !!js process.platform === 'win32'` 平台门控）。
- 自定义 profile 默认 `patchReload: live`（热重载）；出厂的 `web` 是 live；`headless`/`sdk`/`sdk-minimal`/`acp` 是 `startup`（启动时一次性应用——**对 ACP 这种 stdio 应用，配置改动需重启进程**）。
- 查看组合树：`dsh --profile web --dump-config` / `--dump-default-config`（打印可加载的 YAML，含 `# ==` 来源注释）。

### 2.4 `dsh plugin --profile <name> add <pkg>` 怎么工作

`apps/cli/README.md` 的入口模式表：

> `dsh plugin --profile <name>` — Manage a profile's plugins by forwarding to pnpm in the profile directory.

即：`dsh plugin` 子命令在 **profile 目录里转发给 pnpm** 安装插件包。bundle 解析顺序：先在 dsh 安装内解析内建 bundle（`@deepseek-ai/dsh-base`、`dsh-web-app`、`dsh-headless`、`dsh-sdk-app`、`dsh-sdk-minimal`、`dsh-acp-app`），再解析 profile 自己的 `node_modules`（pnpm 安装 out-of-tree 插件的地方）。`dsh-base` README 的示例：profile 的 `package.json` 声明 `dsh.profile.bundles: ["@deepseek-ai/dsh-base"]`，`dsh plugin --profile add <pkg>` 追加更多 bundle。

### 2.5 `cordis.patch.yml` 长什么样

最小、可读的真实例子是 **`packages/bundle/acp-app/cordis.patch.yml`**（acp profile 的全部叠加层，只有 4 行）：

```yaml
# The automation-only ACP application over dsh-base. Stdout belongs to ACP.
- id: system-prompt
  config:
    persona: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

- id: session-title-llm
  disabled: true

- insert:
  - id: acp-app-startup
    name: '@deepseek-ai/dsh-acp-app'

  - id: acp
    name: '@deepseek-ai/dsh-acp'
    inject: [acpAppStartup]
    config:
      provider: deepseek-official
      model: deepseek-v4-flash
```

要点：按 id 覆盖整行 config（如换 persona）；`disabled: true` 关行；`insert` 追加新行（`name` 是包名，`inject` 声明服务依赖）。完整的基础行集见 `packages/bundle/base/cordis.patch.yml`（约 90 行，`apps/cli/composition.md` 渲染了这张图）。

### 2.6 out-of-tree 插件能做什么（扩展点全表）

[扩展手册](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md) 给出四种"插件形状"：

1. **工具插件**：`ctx.tools.register()`（原生 JSON-Schema `ToolDefinition` 也接受，MCP 工具就是这样进来的；一等工具用类型化 `defineTool`）。工具 schema 自动进入提示词组装。
2. **钩子插件**：监听瀑布事件，如 `ctx.on('tools/pre-execute', ...)` 返回 `{ kind: 'deny', reason }` 或 `next()`——权限门控、沙箱、plan-mode 都走这里。另有 `tools/execute`（包裹调用生命周期，可换 `exec.signal`）、`tools/post-execute`（结果变换）、`tools/result`（只读观测）。
3. **UI 插件**：从 `session/event` 渲染（`assistant/chunk` 文本增量、turn/step 边界、工具活动），输入走 `agent.followup()` / `agent.steer()`。
4. **外部协议驱动插件**：把线上协议适配到 `ctx.agents`；stdio 驱动独占 stdout，创建/恢复 agent，把协议请求映射到 `followup()`/`cancel()`，`AgentHandle.dispose()` 静默拆除。**`packages/acp/acp` 就是官方的工作示例。**

**架构文档的"新行为去哪"映射表**（节选，完整见 [architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#where-new-behavior-goes)）：

| 目标 | 机制 |
|---|---|
| 加模型提供商 | 在 `ctx.llm` 注册 adapter |
| 加模型可见能力 | 注册 `ctx.tools` |
| 单会话不同能力集 | 组合一个 agent preset（隔离 realm） |
| 加 shell 执行 | 注册 `ctx.shell` 后端（本地经 `ctx.subprocess` 派生） |
| 加持久终端 | 注册 `ctx.terminals` 后端 + `dsh-tool-terminal` |
| 加**人类命令**（不走模型轮） | 注册 `ctx.commands` |
| 加后台工作 | 注册 `ctx.jobs`，`job_*` 工具收集/停止 |
| 拦截请求/工具/turn | `agent/*`、`tools/*` 事件；`agent/turn-stopping` 停 turn |
| 加模型可见上下文 | `agent.inject()` |
| 加 UI/编辑器集成 | 驱动 `ctx.agents` + 渲染 `session/event` |
| 加持久会话状态 | 扩展 `SessionEventMap`（model-visible = logged） |
| fork 活会话 | `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| 限定到单 agent 的注册 | 该 agent 的 `agent.ctx` |

**官方模板/示例清单**：`docs/cookbook/adding-a-package.md`（新包清单：包名 `@deepseek-ai/dsh-<name>`、ESM、`ctx.effect()` 注册、README 含 Model Experience 段）、`adding-a-tool.md`（首个工具教程）、`adding-an-llm-adapter.md`、`adding-a-settings-card.md`、`docs/user/develop/basic/tool.md`；插件仓库可打 GitHub topic [`dsh-plugin`](https://github.com/topics/dsh-plugin) 提高可发现性。`apps/cli/config/examples/` 还有若干**可选 overlay**（GitHub review webhook、会话级 Schedule、memory MCP server、运行时 Cordis 工具），默认不进任何 profile。

---

## 3. ACP 面（`dsh --profile acp`）

### 3.1 包与启动

- 服务器包：`packages/acp/acp`（`@deepseek-ai/dsh-acp`）；profile bundle：`packages/bundle/acp-app`（`@deepseek-ai/dsh-acp-app`）。
- 启动：`dsh --profile acp`（仓库内 `pnpm dsh --profile acp`）。stdin EOF = 受控关闭；SIGINT/SIGTERM/连接断开都会先排干 agent 再退出；**stdout 只输出换行分隔的 ACP JSON-RPC 帧**（协议纯度）。
- `--help` 会由 app 自带的零选项命令提供者处理：打印帮助即退出，不占用 stdin/stdout。
- 配置字段（`dsh-acp` 行 config）：`provider`、`model`（出厂 `deepseek-official` / `deepseek-v4-flash`，可 patch 整体替换）、`sessionListPageSize`（默认 100）。完整字段见生成的 [config-catalog.md#deepseek-aidsh-acp](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md)。
- persona：`You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.`（`{{model}}`/`{{cwd}}` 按路由和 `session/new` 的 cwd 解析）。

### 3.2 标准 ACP v1 方法矩阵（[dsh-acp README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)）

| 调用 | 语义 |
|---|---|
| `initialize` | 稳定 ACP v1 + 扩展：`session/list`、`session/resume`、`session/close`、Streamable HTTP MCP；仅有持久附件存储且路由支持图片时才广告图片提示 |
| `authenticate` | 立即成功，**服务器不需要认证** |
| `session/new` | 新持久 agent：校验绝对 workspace 与 stdio/HTTP MCP 声明后才发布；返回完整配置选项状态 |
| `session/list` | 确定性"最新优先"分页列出持久化、可恢复的根会话；支持可选绝对 `cwd` 过滤 |
| `session/resume` | 恢复持久化的非活动会话：先校验 canonical workspace，**日志恢复但不重放旧 update**；请求里的 MCP 声明会重新连接；跨进程重启有效（同一 profile 持久化根） |
| `session/close` | 静默取消 + 排干 update + 递归销毁后代 + 冲刷持久化，只拆除被寻址的 Agent 作用域；其他会话不受影响 |
| `session/set_config_option` | 串行化更新广告的 `model` / `reasoning_effort`，返回完整结果状态 |
| `session/prompt` | 文本、资源链接、图片（保持顺序）；每会话同时最多一个在途 prompt；admission 时快照路由并在该 turn 的每个模型步钉住 provider/model/reasoning_effort |
| `session/cancel` / `$/cancel_request` | prompt 属的取消；无在途 prompt 时取消自主工作；未知 session id 是 no-op |
| `session/update` | 已提交的 assistant 消息与 thoughts、泛型工具生命周期、配置变化、上下文用量；按会话串行化推送 |
| `session/request_permission` | 一次性 allow/reject 权限询问；客户端可自动应答 |

**会话配置**：来自活 LLM 服务目录的不透明 provider/model 选项 + 当精确模型声明了 `reasoning_effort` 时的选择器。

**MCP 信任模型**：ACP 客户端是受信控制器——stdio MCP 条目授权其绝对命令与环境变量；HTTP 条目授权其绝对 HTTP(S) URL 与请求头；初始化或发现失败会回滚未发布的 Agent。

**明确不支持**（省略或拒绝）：`session/load`、删除、fork、附加目录、SSE/ACP-transport MCP、modes、commands、plans、terminals、客户端文件系统操作、elicitation（交互式追问）。**只有 MCP 工具**（无 MCP resources/prompts 消费端）。图片仅支持光栅格式（PNG/JPEG/WebP/GIF），需持久附件存储 + 精确图片路由。**单一主 workspace**（无附加目录）。

**更新语义（wire）**：只发标准语义更新——committed messages/thoughts、泛型工具生命周期、配置、上下文用量；原始 provider delta、重试、DSH 私有展示数据一律不上线。settlement 前置条件 = 静默（quiescence）：prompt/close 只有在 admission、Agent 活动、有序 update、后代、持久化、拆除都到达终态后才 settle。

### 3.3 会话生命周期与多会话

一条连接可同时跑多个独立会话（设计记录：[2026-06-14-acp-multi-session.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-06-14-acp-multi-session.md)）。每个会话模块拥有自己的 Agent 句柄、MCP 挂载、prompt 槽、update 链、幂等的 close 操作；关闭一个会话不影响共享 Context 的其他会话/前端。持久化让 `session/list`/`resume`/`close` 跨进程生效（JSONL 日志 + projection cache 检查点，供其他消费者读取 ACP 创建的会话）。

### 3.4 近期 ACP 演进（无 CHANGELOG，按提交/设计记录）

- 2026-06-14：多会话（multi-session）支持。
- 2026-07-23：确立"**ACP as an automation-only protocol**"契约（[note](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.md)）：只暴露标准 ACP v1 面，不泄漏 DSH 私有展示数据；不支持的 surface 省略/拒绝。
- 2026-08：`session/list`、`session/resume`、`session/close`、`set_config_option`、Streamable HTTP MCP、图片 prompt 均已就位；`acp-app` 说明"inherited projection cache checkpoints ACP-created sessions for later consumers"（projection 缓存为后续消费者检查点化 ACP 会话）——同一持久化根下其他进程可读。
- 版本线：`0.1.1-rc.2`（latest）开始 `dsh-acp`/`dsh-acp-app` 进入 CLI 依赖树；`0.1.2-alpha.x` 起官方一致性测试用 `@agentclientprotocol/sdk@1.4.0`（devDependency）驱动真实 acp profile（"keyless control-surface conformance test"）。
- 官方配套客户端：`packages/subagent/subagent-acp`（`dsh-subagent-acp`）——从另一个 harness 派生并驱动本服务器的 ACP 客户端。

---

## 4. 最新动态（TUI 可借力的点）

**版本/发布**：13 次 npm 发布（2026-08-10 → 08-31）；dist-tag：`latest`/`next` = 0.1.1-rc.2，`alpha` = 0.1.2-alpha.3；仓库 HEAD 即 `dsh@0.1.2-alpha.3`。

**0.1.2-alpha 新增/成形的能力**（npm dependencies + 仓库目录）：

- **Agent presets（预设）**：`packages/preset/agent-presets` + `persona`。一个 preset = 一个目录里的 `agent.cordis.yml`，可给单个会话换工具/prompt 段/skills/人设，其他会话不受影响；roster 由"配置根 + harness home"发现。**CLI 0.1.2-alpha 起随包携带**：`dsh.configTrees: [{path: packages/preset/agent-presets/presets, mount: config/agent-presets, scanRoster: true}]`。出厂预设：`cordis`、`minimal`、`ptc`、`standard`（`packages/preset/agent-presets/presets/`）。
- **Skills（技能）**：`packages/skill/*`（注册表 + 文件系统提供者 + `tool-skill` 消费端 + badge）。模型可见：会话技能目录 + `skill` 加载工具；用户可直接 `/name` 调用。项目/用户目录技能自动发现并热刷新。
- **MCP**：`packages/mcp/mcp-client`——dsh 作为 MCP **客户端**挂载外部服务器（工具注册进 `ctx.tools`）；ACP 面另支持会话级 MCP 附加。
- **Subagents**：`packages/subagent/*` 提供者注册表（`spawn-in-process` / `fork-in-process` / `acp` / `codex` / `claude-code` / `dsh-sdk`）+ `tool-subagent`、`tool-subagent-control`（list/interrupt）、`tool-subagent-report`。
- **Workflow（工作流）**：`packages/workflow/*`（`ctx.workflowEngine` + worker-thread 引擎 + `tool-workflow`），结构化 in-process 子代理。
- **Jobs（后台任务）**：`packages/jobs/*` + `tool-jobs`（后台工作可被 `job_*` 工具收集/停止，跨会话）。
- **Goals（目标）**：`packages/goal/*`（`ctx.goals` + 轮次驱动 + `command-goal` + `tool-goal`）。
- **Webhook**：`packages/webhook/*` + `dsh-webhook-github`（GitHub review webhook 覆盖 `apps/cli/config/examples/`）。
- **Hooks 桥**：`dsh-hooks-claude-code` / `dsh-hooks-codex`——把 Claude Code/Codex 的 hook 配置文件映射到 dsh 扩展点（`agent/session-start`、`agent/pre-step`、`agent/request`、`tools/pre-execute`、`tools/post-execute`、`agent/turn-stopping`）。
- **Session projection + cache**：`session-projection`、`session-projection-cache`——已提交事件增量折叠成类型化状态（turnBoundary 等），host 消费者 `stateOf()` 读、`snapshot()` 批量裁切；**缓存把 ACP/其他进程创建的会话检查点化，供后续消费者读**（对 TUI 做会话索引很有价值）。
- 其他：`sdk-app` / `sdk-minimal`（SDK JSON-RPC profile）、`schedule`（cron）、`compaction-basic` + `tool-result-pruner`、`plan-mode`、`spill`、`token-meter`、`tool-str-replace-editor`、`tool-call-timeout-policy`、`repeat-tool-reminder`、实验性 Agent Teams（`experimental/`，不随正式版）。
- 近期提交热点：session-projection 视图一致性/记忆化、连接稳定性（stalled host 容忍）、Web UI 会话轮导航、语法高亮懒加载等。

**对 TUI 的含金量**：以上能力大多**经由 ACP 方法面或共享 `~/.dsh` 状态**可达——例如 jobs/goals/plan 的结果会以工具结果形式进入 `session/update`；sessions 落盘 JSONL + SQLite 查询 + projection cache 让 TUI 可离线读历史；presets/skills 是配置文件，TUI 可读可写（不改内核）。

---

## 5. 对 dsh-tui-rust 的具体建议（不改内核）

前置事实（决定设计约束）：

- Harness home 解析顺序：显式配置 > `$DSH_HOME` > `~/.dsh`（[dsh-home-paths](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/home-paths/README.md)）；home 下至少有 `profiles/<name>/`（package.json + cordis.patch.yml）、home 级 `cordis.patch.yml`、`.env`、settings 文档、JSONL 会话日志、SQLite 会话查询、身份文件。
- `acp` profile 是 `patchReload: startup`：**改配置必须重启子进程**。
- 插件可破坏 stdout 纯度：不要假设子进程 stdout 每行都是合法 JSON-RPC（防御性解析，容忍/标记脏行）。
- ACP 面只有 `model`/`reasoning_effort` 两个配置选项，无 preset/plan/mode 切换——预设差异要落到"不同 profile/不同进程"层面。

**建议清单**：

1. **会话管理斜杠命令（纯 ACP）**：`/new [cwd]`、`/list`（`session/list` 分页 + `cwd` 过滤）、`/resume <id>`（`session/resume`，不重放旧 update，适合重启后接续）、`/close`、`/cancel`。TUI 只需维护会话 id 表；`session/list` 确定性排序可做最近会话选择器。`/resume` 时把该会话原本的 MCP 声明重发。
2. **`/model` 与 `/effort` 命令**：用 `session/set_config_option` 切换广告的 `model`/`reasoning_effort`；把 `session/new` 返回的完整配置选项渲染成可搜索列表（provider/model 来自活服务目录，TUI 不要硬编码）。
3. **权限 UX**：把 `session/request_permission` 渲染成原生 TUI 弹窗（allow/reject/始终允许/本次拒绝），并支持 `--auto-approve`/`--auto-deny` 模式与 `$/cancel_request` 处理。一次性应答，无需持久状态。
4. **读 `~/.dsh`（$DSH_HOME）补全元信息，绝不写内核**：启动时解析 `settings.yaml`（settings 文档按 namespace 分节，schema 默认值 < 组合 base < 用户层）与 `profiles/acp/cordis.patch.yml` 展示当前 provider/model/插件行；读 `profiles/` 目录列出可用 profile 供选择；读 session JSONL/SQLite/projection cache 做离线历史浏览与全文检索（`docs/persistence-catalog.md` 是字段权威）。不要碰 `.env` 里的密钥，只探测是否存在以提示"未配置 API key"。
5. **插件安装走内核自己的命令**：提供 `/plugin add <pkg>` 斜杠命令 → 调用 `dsh plugin --profile acp add <pkg>`（转发 pnpm 到 profile 目录）→ 提示用户重启；`/plugin list` 读 profile package.json。TUI 只做壳，不直接改内核文件。进阶：`dsh --profile acp --dump-config` 展示生效的完整插件树（含用户 overlay 来源注释）。
6. **按 preset/profile 分身的"预设切换"**：ACP 面没有 preset 选项，但 TUI 可为每个预设建一个独立自定义 profile（`dsh plugin` 创建，`dsh.profile.bundles` 里装 `dsh-base`+`dsh-acp-app`+预设 patch），`/preset <name>` 切换 = 杀掉当前子进程、换 profile 重启（符合 startup-only 语义）。可同时开多个 dsh 实例分别接不同 ACP 子进程/workspace。
7. **内核版本感知**：启动时校验 `initialize` 返回的 capabilities（有 `session/list`/`resume` 吗？），按需降级；检查 npm dist-tag（`latest` 0.1.1-rc.2 vs `alpha` 0.1.2-alpha.3）并提供升级提示；README 明确"兼容性可破坏"，TUI 应把 ACP 帧解析做严格（未知方法/字段忽略并警告）。
8. **状态栏数据**：从 `session/update` 的 context usage 渲染 token/上下文用量；从工具生命周期事件渲染"正在运行工具"指示器；用 `assistant/chunk`（text-delta/thinking）做流式输出。这些都是标准 ACP 语义更新，无私有方法。
9. **子进程监督**：stdio 管道管理（stdin 写 JSON-RPC、stdout 读帧、stderr 单独收集为日志）、崩溃/退出检测与自动重启（`session/resume` 续上）、优雅关闭序列（`session/close` → 断开 → SIGINT/SIGTERM）。ACL 上给子进程 `~/.dsh` 与 workspace 的权限，符合内核的沙箱默认（`workspace-write` 局限写工作区 + 会话临时目录）。
10. **会话历史导出/复用**：`/export` 用 `session/list`+`resume`+prompt 重放或直接读 JSONL 生成转录；与官方 `dsh-subagent-acp` 对齐交互约定（同为"标准 ACP 面"），未来可直接对接 ACP SDK（`@agentclientprotocol/sdk`）或参考其 Rust 等价实现。

---

## 附：关键文件/URL 索引

- 仓库：https://github.com/deepseek-ai/deepseek-harness （默认分支 `master`）
- README：https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md
- 架构：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
- 开发：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/development.md
- 文档标准：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/AGENTS.md ；根 AGENTS.md：`/AGENTS.md`
- ACP 协议契约：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md
- ACP profile bundle：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/acp-app/README.md ；patch：`packages/bundle/acp-app/cordis.patch.yml`
- base bundle：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/base/README.md ；patch：`packages/bundle/base/cordis.patch.yml`
- CLI（dsh 命令）：https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md ；组合图：`apps/cli/composition.md`
- boot（profile 机制）：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/README.md
- 扩展手册：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md
- npm：https://registry.npmjs.org/@deepseek-ai/dsh （latest 0.1.1-rc.2 / alpha 0.1.2-alpha.3）
- 文档站点：https://deepseek-harness.github.io/deepseek-harness/
