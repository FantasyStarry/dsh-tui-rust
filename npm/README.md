# dsh-tui npm 分发包

`dsh-tui` 的 npm 包装层：`bin/*.js` 是解析器 shim，`dist/<平台键>/` 存放
`scripts/build-release.*` 暂存的**平台预编译二进制**。

## Shim 的二进制解析顺序

1. `DSH_TUI_BIN` 环境变量（显式覆盖）
2. 包内 `dist/<platform>-<arch>/dsh-tui(.exe)`（随 npm 分发的预编译产物）
3. `~/.dsh-tui/bin/`（install.ps1 / install.sh 的安装位置）
4. PATH（where / which）

都没有 → 打印安装指引并退出 1。`dtr` shim 同逻辑，允许回退到 `dsh-tui`
二进制（两者是同一份代码的别名）。

## 发布流程

```powershell
# 0. 登录 npm（未登录时 publish 会 401）
npm login
npm whoami   # 确认

# 1. 构建当前平台产物（cargo build --release + 暂存到 npm/dist/<平台键>/）
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1

# 2. （可选）交叉构建其它平台后重复暂存，多平台产物合并进 dist/

# 3. 发布（包名 @spongzi/dsh-tui —— 无 scope 的 dsh-tui 已被他人占用，
#    @fantasystarry scope 不存在会报 "Scope not found"；publishConfig.
#    access=public 已写入 package.json，无需再传 --access）
cd npm
npm publish
```

发布后用户侧：`npm i -g @fantasystarry/dsh-tui` → 直接运行 `dsh-tui` / `dtr`
（bin 名不含 scope，与源码安装的命令完全一致）。

## 注意

- 无 scope 的 `dsh-tui` 包名已被他人占用（MashedPotato817/dsh-tui，与本仓库
  无关），故发布名固定为 **`@spongzi/dsh-tui`**——npm 用户天然拥有
  `@<自己用户名>/` scope，无需建组织；改用不存在的 scope 会报
  "Scope not found"。改回无 scope 名会继续 E404。
- `package.json` 的 `files` 含 `dist/`——只会上传已暂存平台的产物；
  未覆盖的平台走 shim 的回退链（源码构建 / PATH）。
- companion 插件不随 npm 包分发（它是 dsh profile 的 link 依赖，指向
  仓库源码）——用仓库根的 `bootstrap.ps1` / `bootstrap.sh` 引导挂载。
