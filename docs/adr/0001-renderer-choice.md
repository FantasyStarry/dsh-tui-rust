# ADR 0001 — 渲染内核：自建 pi-tui 风格差分渲染，不用 Ink/React

- 状态：已接受（M0）
- 日期：2026-09（Orca 重启时）

## 背景

Orca 需要一个终端渲染内核。三个参考项目给出两条路线：

1. **dsh-TUI 路线**：移植 Ink 渲染器 + React 19 + Yoga 布局（package.json 里 react/react-reconciler 一串依赖，还有 `force-production-react` 这类双实例 React 的防坑补丁）。
2. **pi / kimi-code 路线**：pi-tui 风格 —— 组件 `render(width) → string[]`，宿主做差分刷新（定位首个变更行、清到行尾、只重绘变更行）+ CSI 2026 同步输出。kimi-code 的整个 TUI 就是 vendor 的 pi-tui。

## 决策

Orca 采用**路线 2 的自建实现**（`src/tui/renderer.ts`）：组件产出行数组，渲染器做差分 + 同步输出，不引入 React。

## 理由

- 「属于我自己的 TUI」—— 渲染内核是产品的身份核心，自建才有完全的所有权与演进自由；
- 依赖面小：零 React/Yoga，纯 Node 内置 + 极少工具库；生态插件接缝（未来的场景/对话框/渲染器注册）直接对齐 pi-tui 的接缝形态；
- 两个 UX 标杆（pi、kimi-code）都验证了这条路线可承载 Claude Code 级别的交互复杂度；
- dsh-TUI 的 React 路线已被验证可行，若未来需要 React 组件生态，届时可在 channel/真源层之上加 Ink 适配层 —— 真源与投影的分层保证了这条退路。

## 后果与待办

- 行宽度计算必须按 terminal cell：骨架用占位实现（`src/tui/width.ts`），生产必须换 `get-east-asian-width`（pi-tui 同款依赖）；
- ~~inline 主屏的 scrollback 密封~~ ✅（M2b 已落地）：帧拆为「流 + 活动区」——已定稿行在 `turn/start` 封存，随渲染流一次性写入（写在活动区顶部、溢出自然滚入回滚区，之后不再跟踪重绘）；头部横幅改为变更即入流（成为回滚区里的回合分隔条）；活动区只剩当前回合开行 + 界面框架，永不增长；
- 备用屏（fullscreen）、鼠标选区、OSC 52 复制、Kitty 键盘协议按 pi-tui 的实现逐个对齐。
