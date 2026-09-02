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

## 路线图

- [x] **M0 骨架**：插件契约、cordis.patch.yml、差分渲染器、键盘、Channel 投影、假内核 dev harness
- [x] **M1 真内核闭环**（实测验收 ✔）：agents 镜像对齐真实 API（dsh 0.1.1-rc.2：`AgentHandle{agent,dispose}`、`followup(UserMessage)`、`assistant/chunk` 流式信封）；profile 挂载实测（`link:` 挂载 + Standard Schema `Config` + `inject:[agents]` + loader 激活等待 + `agentDefaultModel` 默认模型接入 + 工厂注册竞态重试）；流式 delta 真终端上屏
- [x] **M2a 可用性**（实测验收 ✔：PTY 端到端 + 假内核契约冒烟）：主题 token 骨架（`NO_COLOR` 可降级）；状态栏显示当前 route/model/思考强度与 token 用量（取自 `request/header` 与 `assistant/message.usage`）；思考块折叠 + 思考中计时；`/model` 三段选择器（provider → model → 思考强度），经 `agent/request` waterfall 运行中热切换、`agentDefaultModel.saveSelection` 尽力持久化
- [x] **M2b 视觉**（代码就绪，待真终端验收）：scrollback 封存（流/活动区分帧，已定稿行写入终端原生滚动缓冲）；Markdown 渲染（标题/列表/引用/行内样式/围栏代码块）；轻量代码高亮（js/ts/json/py/bash/yaml）；工具卡三态 + write/edit 结果的 diff 卡（增删行着色，来自 `tool/result.meta.diffs`）
- [x] **M2c 视觉改版**（分层卡片语言）：用户消息暖色全宽气泡、助手连续 teal 左栏、代码块全宽深底卡片、工具卡背景面板 + 状态色头部（`⏺` + 增删计数）、思考旋转动画；顶部 chrome 状态条（brand · session · cwd）、标题化盒式输入框（提示嵌底边）、状态栏式页脚（状态 · 路由 · token 用量）；主题 token 扩至 21 个（19 fg/bg 语义色 + 2 边框），精确 SGR 复位支持嵌套背景填充，`NO_COLOR`/256 色降级保留
- [ ] **M3 会话**：`/resume` 浏览器、会话标题、`/compact`、rewind（双击 Esc 时间回溯）
- [ ] **M4 壳层**：权限审批面板、hooks、状态栏插槽、fullscreen 备用屏 + 鼠标选区

## License

MIT
