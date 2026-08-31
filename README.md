# dsh-tui-rust

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的终端客户端（类 Claude Code 形态）。

**核心原则：Rust 只做终端前端壳，Node 内核（dsh）通过协议复用，永不修改。**

## 架构

```
┌─────────────────────────┐    ACP v1 (JSON-RPC over stdio)    ┌─────────────────────────┐
│  dsh-tui (Rust 二进制)   │ ◄────────────────────────────────► │  dsh --profile acp       │
│                         │                                    │  (Node 子进程)           │
│  · ratatui 终端渲染      │   session/new · session/prompt     │                         │
│  · 键盘交互 / 权限弹窗    │   session/update (流式)            │  完整内核：全部工具、      │
│  · 会话列表 / resume     │   session/request_permission       │  沙箱、持久化、MCP、      │
│  · diff / markdown 渲染  │   session/close · resume           │  插件生态、模型路由       │
└─────────────────────────┘                                    └─────────────────────────┘
```

唯一耦合面 = **ACP v1 标准协议**。内核的全部能力（30+ 工具包、沙箱、会话持久化、
压缩、subagent、skills、MCP client、插件系统）免费继承，随官方升级自动获得。

## 为什么不 fork 官方仓库（内核隔离策略）

结论：**不 fork，用"npm 包引用 + 进程边界"的方式消费内核。**

| 隔离层 | 机制 |
|--------|------|
| 进程隔离 | dsh 以子进程运行（`dsh --profile acp`），TUI 崩溃不影响内核，内核崩溃可凭持久化会话 resume |
| 协议隔离 | 只依赖官方承诺的标准 ACP v1 surface（无私有方法、无 `_meta`），上游只要保持 ACP 兼容就不会破坏 TUI |
| 环境隔离 | dsh 自带 profile 机制：acp profile 的插件树、补丁、持久化都在 `$DSH_HOME/profiles/acp/` 独立目录，与 web profile 互不干扰 |
| 版本契约 | 要求 `dsh >= 0.1.2-alpha.2` 在 PATH 上（或用 `DSH_BIN` 环境变量指向可执行文件） |

fork 的问题：会把整个 Node monorepo（100+ 包）复制进来，从此背负上游同步负担，
而且"顺手改内核"的诱惑会导致永久分叉。fork 只有在需要修改内核本身时才合理——
而那正是本架构明确禁止的事。

未来若需要 TUI 专属的内核扩展（Phase 3），正确做法是做一个 **out-of-tree 插件
bundle**（独立 pnpm 包，通过官方机制 `dsh plugin --profile tui add <包>` 安装），
依然不是 fork。

## 运行

前置条件：`dsh` 在 PATH 上（`npm i -g @deepseek-ai/dsh`），Rust 工具链。

```sh
cargo run                          # 交互式 TUI（需要真实终端 TTY，如 Windows Terminal）
cargo run -- --probe              # 非 TTY 自检：initialize / new / list / resume
DSH_BIN=/path/to/dsh cargo run    # 指定 dsh 路径
```

### Phase 1 界面与按键

| 按键 | 作用 |
|------|------|
| `Enter` | 发送输入框中的消息（`/quit` `/new` `/list` 斜杠命令） |
| `Esc` | 任务运行中 → 取消（session/cancel）；否则清空输入 |
| 权限弹窗 | `↑↓` 选择 · `Enter` 确认（默认首选 allow_once 项）· `Esc` 拒绝 |
| `Ctrl+L` 或 `/list` | 持久化会话列表 → `Enter` 恢复（session/resume，需 cwd 校验） |
| `Ctrl+N` 或 `/new` | 新建会话（旧会话 close 后保留在持久化里） |
| `PgUp` / `PgDn` | 滚动历史；有新内容且在底部时自动跟随 |
| `↑` / `↓` | 输入历史 |
| `Ctrl+C` | 退出（stdin EOF 触发 dsh 优雅关机） |

状态栏显示：运行状态 · 当前模型 · 上下文占用（usage_update）· 会话短 ID。

### 已知限制（Phase 1）

- 正文按纯文本渲染（markdown/高亮留给 Phase 2）；思考流为暗色文本
- ACP `session/resume` 不回放历史内容（内核上下文已恢复，但 TUI 不显示旧消息）
- 会话列表无标题（dsh ACP 面禁用了模型生成标题），按 cwd + 短 ID 展示

## Roadmap

- [x] **Phase 0** — ACP 管道验证：initialize → session/new → prompt → 流式
      session/update → stopReason → session/close（已实测通过，真实模型回复）
- [x] **Phase 1 MVP** — ratatui 聊天界面（流式正文/思考/工具卡）、权限弹窗 UI、
      `session/list` / `session/resume`（probe 自检通过；resume 需带 cwd 参数）
- [ ] **Phase 2** — diff 视图、markdown 渲染、模型/effort 切换
      （`session/set_config_option`）、主题
- [ ] **Phase 3** — companion 插件 bundle（`tui` profile）+ npm 分发（平台预编译二进制）

## 协议速查（dsh acp surface 实测）

| 调用 | 说明 |
|------|------|
| `initialize` | 参数 `{protocolVersion: 1, clientCapabilities: {}}`，无需 authenticate |
| `session/new` | 参数 `{cwd: <绝对路径>, mcpServers: []}`，返回 `sessionId` + `configOptions` |
| `session/prompt` | `{sessionId, prompt: [{type: "text", text}]}`，返回 `stopReason` |
| `session/update`（通知） | `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `config_option_update` / `usage_update` |
| `session/request_permission`（agent 反向请求） | 需应答 `{outcome: {outcome: "selected", optionId}}` |
| `session/set_config_option` | 切换 model / reasoning_effort |
| `session/list` / `session/resume` / `session/close` | 持久化会话管理；**dsh 的 resume 额外要求 `cwd` 参数**（校验会话规范工作目录，标准 ACP 未定义，缺省返回 -32602） |

dsh acp surface 不支持 client filesystem 操作、elicitation、terminals、modes/plans——
spike 阶段无需实现这些反向处理。
