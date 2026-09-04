# Orca 🐋

**属于你自己的 DeepSeek Harness 终端前端** —— 一个 TypeScript Cordis 插件，挂载进 dsh 自定义 profile，跑在官方内核进程内。零内核改动，卸载无残留。

```sh
orca   # ≡ dsh --profile orca
```

## 为什么重来一次

本仓库的前身是一个 Rust 编写的 ACP 客户端（TUI spawn `dsh --profile acp` 子进程，stdio 上跑 JSON-RPC）。那条路的三个结构性问题最终让方向「做偏」：

1. **ACP 是 "automation-only" 协议** —— 只传输已提交块，原始流式 delta 永不上线，TUI 只能靠打字机动画假装流式；
2. **子进程管理是无底洞** —— Windows shim、孙进程、孤儿清理、stdout 污染防御；
3. **精力漂移到外围**（companion 插件、npm 发包、会话归档），而非 TUI 体验本身。

Orca 改为 **in-process 插件**：直接消费内核内部事件流（`session/event` 的真实流式 delta、`agent/status`、工具生命周期），子进程问题从根上不存在。旧实现完整保留在 git 历史中可随时考古。

## 架构

```
Cordis profile (orca)
  └─ cordis.patch.yml        # bundle 层：服务行、覆盖、挂载顺序
      └─ src/index.ts        # 插件契约：name / Config / apply（无默认导出）
          └─ src/app.ts      # TTY 检查 → agent 工厂 → 装配 → 统一退出清理
              ├─ src/adapter/channel.ts   # session/event → 转录行投影（真源）
              ├─ src/tui/renderer.ts      # 差分渲染 + CSI 2026 同步输出
              ├─ src/tui/input.ts         # raw 模式键盘
              └─ src/tui/chat.ts          # 纯函数帧构建
```

原则（继承自 [dsh-ecosystem-spec](https://github.com/T-Auto/dsh-ecosystem-spec)）：

- **Session 是真源**：transcript 只是投影，一切可从事件日志重建；
- **#183 纪律**：代码级 inject 保持为空，可选接缝一律 `ctx.get(name, false)` 软探测、静默降级，绝不让可选服务缺席拖垮启动；
- **插件崩溃不拖垮 TUI**，stdout 在 TUI 活动期间保持安静（诊断走 stderr）；
- **会话事件类型注册两条铁律**：log-only（无 surfaceOp）+ 写入每个可达 dsh-session 副本的 `KNOWN_SESSION_EVENT_TYPES`（落地时参照 `dsh-working-activity/src/registration.ts`）。

## 参考项目

| 项目 | 学什么 |
| --- | --- |
| [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) | 挂载形态（`dsh plugin --profile <p> add` → in-process 接管 TTY）、session 真源、`cordis.patch.yml` 层叠 |
| [earendil-works/pi](https://github.com/earendil-works/pi) | pi-tui 差分渲染（组件 → 行数组 → 只刷变更）、CSI 2026、UX 布局与主题 token |
| [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) | 壳层职责：hooks、权限规则层、命令菜单（别名/分组/忙时排队）、状态栏插槽 |

深度调研见 [`docs/research/`](docs/research/)（deepseek-harness / pi / kimi-code 三份）。

## 开发

```sh
pnpm install
pnpm build        # tsc → lib/
pnpm dev          # 假内核冒烟：渲染循环 + 键盘 + 降级启动路径
```

挂载到真实内核（需要本机已装 `@deepseek-ai/dsh`）：

```sh
dsh plugin --profile orca add <本包路径或 npm 包名>
dsh --profile orca          # 或安装后直接 orca
```

`ORCA_RESUME_SESSION=<id>` 恢复会话；`ORCA_PROVIDER`/`ORCA_MODEL` 成对覆盖模型路由（默认空 = 组合默认 `agentDefaultModel`，内核自身不会兜底缺省模型）；`ORCA_FULLSCREEN=1` 切备用屏（骨架期默认 inline 主屏）。

真机回归探针（ConPTY 启动真实 profile，驱动 `/` 菜单、`/model` 三段选择器、Esc、中文输入与光标停靠，零 API 成本）：

```sh
node scripts/probe-pty.mjs         # 全流程回归
node scripts/probe-pty.mjs --live  # 追加一次极小真回合：流式上屏 + Ctrl+O 思考展开/折叠
```

## 路线图

- [x] **M0 骨架**：插件契约、cordis.patch.yml、差分渲染器、键盘、Channel 投影、假内核 dev harness
- [x] **M1 真内核闭环**（实测验收 ✔）：agents 镜像对齐真实 API（dsh 0.1.1-rc.2：`AgentHandle{agent,dispose}`、`followup(UserMessage)`、`assistant/chunk` 流式信封）；profile 挂载实测（`link:` 挂载 + Standard Schema `Config` + `inject:[agents]` + loader 激活等待 + `agentDefaultModel` 默认模型接入 + 工厂注册竞态重试）；流式 delta 真终端上屏
- [x] **M2a 可用性**（实测验收 ✔：PTY 端到端 + 假内核契约冒烟）：主题 token 骨架（`NO_COLOR` 可降级）；状态栏显示当前 route/model/思考强度与 token 用量（取自 `request/header` 与 `assistant/message.usage`）；思考块折叠 + 思考中计时；`/model` 三段选择器（provider → model → 思考强度），经 `agent/request` waterfall 运行中热切换、`agentDefaultModel.saveSelection` 尽力持久化
- [x] **M2b 视觉**（代码就绪，待真终端验收）：scrollback 封存（流/活动区分帧，已定稿行写入终端原生滚动缓冲）；Markdown 渲染（标题/列表/引用/行内样式/围栏代码块）；轻量代码高亮（js/ts/json/py/bash/yaml）；工具卡三态 + write/edit 结果的 diff 卡（增删行着色，来自 `tool/result.meta.diffs`）
- [x] **M2c 视觉改版**（kimi-code 风格，代码就绪待真终端验收）：调色板对齐 kimi-code dark palette——蓝色 primary `#4FA8FF`、琥珀 roleUser `#FFCB6B`、灰阶 text/textDim/textMuted、teal accent（原珊瑚暖色系移除）；用户消息 `✨` 琥珀加粗角色前缀（无气泡）、助手 `● ` 正文色圆点 + markdown、thinking braille spinner + 斜体 dim 预览、封存折叠为 `● 已思考 Ns`；工具卡保留背景面板，状态标记改 `⠋`/✓/✗；chrome 对齐 kimi——primary 圆角输入框（`> ` 提示符位于第 2 列）、两行纯文本页脚（状态徽标 · 路由 · cwd + 右对齐 `context:` 用量，无背景填充）、欢迎信息盒（logo + Directory/Session/Model 行）、选择器平直 `─` 顶底边框 + `❯` 选中 + ` ← current` 成功标记 + `▼ N more` 滚动指示；1 格图片式 chrome 排水沟对齐转录区；**inline 布局：chrome 恒钉底（spacer 空行撑满视口，输入框固定在终端底边）**，open 行窗口按终端高度封顶；渲染器末行免尾随换行（整屏重绘不再丢行/漂移，phase 0.6 契约）；主题 token 精简为 19 个语义色（kimi colors.ts 映射），精确 SGR 复位保留，`NO_COLOR`/256 色降级保留
- [x] **M3 会话**（假内核冒烟 ✔，待真终端验收）：`/` 内联命令菜单（kimi 式：过滤/↑↓/Tab/Enter 补全后分发）· `/help`（分组/别名/内核命令追加，未知命令回退普通消息）· `/new`（别名 `/clear`）· `/resume`（别名 `/sessions`，`sessionQuery.listSessions` + 标题快照浏览器，50 条封顶）· `/title`（查看/`sessionTitle.rename`，`session/title` 事件折叠进页脚）· `/compact [hint]`（经 `commands.execute`，`compaction/*` 投影为系统行并封存）· `/usage` 明细 · rewind（空闲双击 Esc，经 `sessions.fork` 到上一 `turn/start` 边界后切换，`OPEN_TURN` 等失败降级提示）；`command/run-done`、`todo/write` 一并投影；欢迎卡延迟到连接后（Session/Model 行带真实值）+ 连接中徽标；可选接缝全部懒探测（启动时序竞态不再误报"未挂载"）
- [x] **M4 壳层**（假内核冒烟 ✔，待真终端验收）：审批面板（`approval/request` waterfall 应答者，FIFO 模态 picker，Enter/`1` 放行单次、`2`/Esc 拒绝，abort/`dispose` 以 `cancelled` 结算；`/yolo [on|off]` 为本地自动放行，开启时强制 policy 回 `ask` 以便请求到达；`/permission` 查看；`approval/asked-decided` 审计投影）· hooks 投影（`hook/invoked-result` 系统行，非常拦截只展示）· 状态栏插槽（标题 · yolo/never · `⑂` git 分支（`.git/HEAD` 2s 缓存，无子进程）· 压缩中徽标，kimi 两行式）· fullscreen 备用屏（`ORCA_FULLSCREEN=1` 进 `\x1b[?1049h`、退出恢复，不捕获鼠标以便终端原生选区复制）· 同进程热重载静默恢复（复用同一会话 + `sessionQuery.readSession` 日志重放，不再建新会话/刷欢迎卡；`agents.get/list` 与 `readSession` 镜像已对齐 dsh 0.1.2-alpha.5）
- [x] **M5 体验加固**（真机 PTY 探针 ✔ 全流程 + live 真回合）：自建键盘解析器取代 node:readline keypress——根除孤立 ESC ~500ms `escapeCodeTimeout` 延迟与 Esc+按键被拼成 alt 组合、原始 CSI 灌入输入框的"菜单/picker 关不掉、输入框错乱"类问题（40ms Esc 窗口、序列跨块续传、未知 CSI 吞除、UTF-8 分片安全）；渲染器帧收缩后光标停靠修正（关菜单/关 picker 光标回到输入框行）；宽度换 `get-east-asian-width`，满宽行（盒卡/页脚/输入框）经 `asciiEllipses` 剥离歧义省略号——ConPTY 记 1 格 / CJK 终端记 2 格的 U+2026 会把恰好满宽的行在真终端顶换行、吃掉下一行（输入框底边框消失的根因）；思考过程 `Ctrl+O` 展开/折叠双向（页脚提示与 `/help` 同步）；`scripts/probe-pty.mjs` 以 ORCA_LOG 应用层字节流为断言真源的 ConPTY 回归探针（含 `--live` 流式真回合验证、`--fullscreen` 备用屏验证、app/ConPTY 双层屏断言）
- [x] **M6 布局稳定 + fullscreen 重做**（冒烟 phase6/7 + 真机探针 ✔）：恒钉底——inline/fullscreen 一律 spacer 撑满视口，输入框从首帧固定在终端底边（"切完模型 UI 上移"类跳变不存在；M6 的 picker 闩锁已退役）；fullscreen 重做为 pi-tui 式整屏窗口模式——备用屏无原生回滚区，不再走 scrollback 封存流，转录渲染为 channel 行的滑动窗口（溢出出『上方还有 N 行』头注）、chrome 恒钉底、帧恰好填满终端高度，欢迎/路由线改走 channel 系统行进窗口；活动区行统一过 `asciiEllipses`（差分绘制行不得含歧义宽度字符，否则终端换行导致绘制失步）；布局原则参照 terminal-ui skill（DevEx TUI 42 条规则）与 pi 的 inline/alt-screen 双模式

## License

MIT
