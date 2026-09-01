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
# 1. 构建当前平台产物（cargo build --release + 暂存到 npm/dist/<平台键>/）
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1

# 2. （可选）交叉构建其它平台后重复暂存，多平台产物合并进 dist/

# 3. 发布（需要 npm 账号；包名 dsh-tui 如被占用需在 package.json 改名）
cd npm
npm publish
```

发布后用户侧：`npm i -g dsh-tui` → 直接运行 `dsh-tui` / `dtr`。

## 注意

- `package.json` 的 `files` 含 `dist/`——只会上传已暂存平台的产物；
  未覆盖的平台走 shim 的回退链（源码构建 / PATH）。
- 包名 `dsh-tui` 在 npm 上如已被占用，改名后同步更新 README 安装命令。
- companion 插件不随 npm 包分发（它是 dsh profile 的 link 依赖，指向
  仓库源码）——用仓库根的 `bootstrap.ps1` / `bootstrap.sh` 引导挂载。
