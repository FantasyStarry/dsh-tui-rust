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
| `Enter` | 发送输入框中的消息 |
| 输入 `/` | **弹出命令菜单**：继续输入过滤，`↑↓` 选择，`Tab` 补全，`Enter` 执行 |
| `Esc` | 任务运行中 → 取消（session/cancel）；输入非空 → 清空；有空闲队列 → 清空队列 |
| 忙时输入 | 自动**排队**（状态栏显示队列数），当前任务完成后逐条自动发送 |
| 权限弹窗 | `↑↓` 选择 · `Enter` 确认（紫色选中条）· `Esc` 拒绝 |
| `Ctrl+M` / `/model` | 模型切换（session/set_config_option，带当前标记；运行中也可切换，下一轮生效） |
| `Ctrl+E` / `/effort` | 推理档位切换（off/low/high/max） |
| `Ctrl+L` 或 `/list` | 持久化会话列表 → `Enter` 恢复（session/resume，需 cwd 校验） |
| `Ctrl+N` 或 `/new` | 新建会话（旧会话 close 后保留在持久化里） |
| `鼠标滚轮` / `PgUp` / `PgDn` | 滚动历史；状态栏显示滚动标尺；回到底部自动跟随 |
| `Home` / `End` | 跳到顶部 / 底部 |
| `↑` / `↓` | 输入历史 |
| `Ctrl+C` | 退出（stdin EOF 触发 dsh 优雅关机） |

命令一览：`/help` `/new` `/list` `/model` `/effort` `/clear`（清屏，不影响会话）`/quit`。

### 模型选择与 web 端的关系

**TUI 与 web GUI 的模型互不同步——这是设计，不是缺陷**：web 与 acp 是两个独立
profile，模型是**会话级**状态（dsh acp 新会话默认走 profile 配置的
`deepseek-v4-flash`）。TUI 的补偿机制：

- 你在 TUI 里切换过模型/档位后，选择会持久化到 `~/.dsh-tui/prefs.json`，
  之后每个新会话自动应用
- 想改 TUI 会话的"出厂默认"，patch acp profile 的 dsh-acp 配置即可
  （`$DSH_HOME/profiles/acp/`），无需改 TUI 代码

视觉语言（基于 gpt-image-2 生成的设计稿，本地 `design/` 参考，不入库）：

- 顶栏：🐋 + 渐变字标 DSH·TUI，右侧模型药丸 + 上下文进度条（>70% 变黄、>90% 变红）
- 转写区：蓝色 `❯` 用户前缀、暗色斜体思考行、青色工具行 + 彩色状态点
  （completed 绿 / failed 红 / running 黄）+ 工具实参预览（`⤷` 暗行，来自 rawInput）、
  回合间发丝分隔线
- 正文 markdown-lite：``` 代码块带语言标注边框、`行内代码`、**粗体**、标题、
  列表与引用（保守渲染，识别不了的原样显示，流式安全）
- 状态行：状态点 + braille spinner + 运行计时 + 滚动标尺，右侧 keycap 风格按键提示
- 输入框：圆角紫边 + 蓝色 `❯` + 占位符；运行时边框变黄
- 弹窗：圆角边框 + 全宽紫色选中条（权限/会话列表共用）

> 鼠标捕获开启后，Windows Terminal 中需 `Shift`+拖拽 才可选择终端文本（TUI 惯例）。

### 已知限制（Phase 1）

- 正文按纯文本渲染（markdown/高亮留给 Phase 2）；思考流为暗色文本
- ACP `session/resume` 不回放历史内容（内核上下文已恢复，但 TUI 不显示旧消息）
- 会话列表无标题（dsh ACP 面禁用了模型生成标题），按 cwd + 短 ID 展示

## Roadmap

- [x] **Phase 0** — ACP 管道验证：initialize → session/new → prompt → 流式
      session/update → stopReason → session/close（已实测通过，真实模型回复）
- [x] **Phase 1 MVP** — ratatui 聊天界面（流式正文/思考/工具卡）、权限弹窗 UI、
      `session/list` / `session/resume`（probe 自检通过；resume 需带 cwd 参数）
- [x] **可用化里程碑** — 模型/推理档位热切换（`set_config_option`，probe 验证
      configId 契约）、忙时消息队列、markdown-lite 正文渲染、工具 rawInput 预览
- [ ] **Phase 2** — diff 视图、完整 markdown/高亮、主题系统
- [ ] **Phase 3** — companion 插件 bundle（`tui` profile）+ npm 分发（平台预编译二进制）

## 协议速查（dsh acp surface 实测）

| 调用 | 说明 |
|------|------|
| `initialize` | 参数 `{protocolVersion: 1, clientCapabilities: {}}`，无需 authenticate |
| `session/new` | 参数 `{cwd: <绝对路径>, mcpServers: []}`，返回 `sessionId` + `configOptions` |
| `session/prompt` | `{sessionId, prompt: [{type: "text", text}]}`，返回 `stopReason` |
| `session/update`（通知） | `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `config_option_update` / `usage_update` |
| `session/request_permission`（agent 反向请求） | 需应答 `{outcome: {outcome: "selected", optionId}}` |
| `session/set_config_option` | `{sessionId, configId, value}`（**configId 而非 configOptionId**，probe 实测），返回完整配置状态；模型选项是嵌套分组结构需拍平；运行中切换对下一轮生效 |
| `session/list` / `session/resume` / `session/close` | 持久化会话管理；**dsh 的 resume 额外要求 `cwd` 参数**（校验会话规范工作目录，标准 ACP 未定义，缺省返回 -32602） |

dsh acp surface 不支持 client filesystem 操作、elicitation、terminals、modes/plans——
spike 阶段无需实现这些反向处理。
