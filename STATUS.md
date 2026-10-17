# Daylight 当前状态

最后更新：**2026-10-18（北京时间）**。本文件记录实际实现和验证结果；使用步骤见 [README.md](README.md)，开发约定见 [AGENTS.md](AGENTS.md)。

验证等级用语（按 [AGENTS.md](AGENTS.md)）：**规划中** < **代码已实现** < **本地测试通过** < **真实服务实连成功** < **云端部署验证通过** < **生产验收通过**。

## 本轮：CI/CD 六平台发布流水线 + 应用内自动更新（2026-10-17）

### 交付内容

- **`.github/workflows/release.yml`（新增）**：打 `v*` 标签触发，构建**六个平台**安装包并发布到 GitHub Release，同时产出自动更新用的 `latest.json` 与各平台 `.sig`。

  | 平台 | Runner | Rust target |
  | --- | --- | --- |
  | macOS Apple Silicon | `macos-14` | `aarch64-apple-darwin` |
  | macOS Intel | `macos-14`（**交叉构建**） | `x86_64-apple-darwin` |
  | Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` |
  | Linux ARM64 | `ubuntu-24.04-arm` | `aarch64-unknown-linux-gnu` |
  | Windows x64 | `windows-latest` | `x86_64-pc-windows-msvc` |
  | Windows ARM64 | `windows-11-arm` | `aarch64-pc-windows-msvc` |

  - `guard` 任务先校验**标签版本与 `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` 三处版本一致**，不一致直接失败，避免发出一个「版本号说不清」的包。
  - `fail-fast: false`：单平台失败不影响其余平台。
  - `includeUpdaterJson` 在当前的 `tauri-action` 里已更名为 `uploadUpdaterJson`；并显式设 `updaterJsonPreferNsis: true`（Windows 自动更新只能装 NSIS，不设就会把装不上的 `.msi` 写进 `latest.json`），`retryAttempts: 2`（六个 job 并发创建同一个 Release）。
  - `tauri-apps/tauri-action@v1`，`releaseDraft` 由 guard 任务归一化后的 `draft` 输出决定（**不写死**）：推标签默认正式发布，手动运行时可勾「只产出草稿 Release」来在不公开的前提下验证六平台构建。
- **应用内自动更新（Rust 侧，`src-tauri/src/update.rs`）**：`tauri-plugin-updater` + `tauri-plugin-dialog`。启动约 6 秒后**静默**检查一次（已是最新不打扰用户），托盘菜单新增「检查更新…」手动检查；发现新版本弹原生对话框，**用户点确认后**才下载安装，装完 `app.restart()`；下载期间用窗口标题显示「正在下载更新…」。绝不静默安装，也不需要 WebView 参与。
  - 配套：`tauri.conf.json` 增加 `plugins.updater`（可公开的 minisign 公钥 + 本仓库 `releases/latest/download/latest.json`）与 `bundle.createUpdaterArtifacts: true`。
  - 私钥生成在 `work/updater-key/daylight.key`（`work/` 不进仓库），只用于本机与 GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`。
- **`scripts/prepare-desktop.mjs` 支持交叉打包**：新增 `DAYLIGHT_TARGET_TRIPLE`，按目标平台下载官方 Node 发行版替换内置 Node，并用 `npm install --os/--cpu` 装对原生模块（`@napi-rs/canvas` 是按平台可选依赖安装的）。目标架构变化时会清掉 `node_modules` 重建，避免上一轮为别的架构装的二进制留在包里。下载带 3 次重试与 `work/node-dist-cache/` 本地缓存。`runtime/build-info.json` 记录 `platform/arch/targetTriple/nodeSource`。
  - 这是 **Intel Mac 包能出产物的前提**：GitHub 已不提供 x64 的 macOS runner，只能在 Apple Silicon 上交叉构建。
- **`.github/workflows/desktop.yml`（改造）**：移除与 `release.yml` 重复的 bundle 任务（改由打标签时构建），新增一条 macOS 上的**交叉打包自检**（为 `x86_64-apple-darwin` 准备运行时并用 `file` 断言内置 Node 是 `x86_64`，再还原本机架构）。
- **`package.json`** 增加 `repository` 字段：让「更新源指向本仓库」这件事可以被测试交叉校验，而不是靠人肉记住两个地方要同步改。

### 决策记录

- **D6 自动更新只在原生侧实现，不给应用页调用通道**：应用页由回环 HTTP（`src-tauri/capabilities/main.json` 里有 `remote: {"urls":["http://127.0.0.1:*/*"]}`）提供，页面可以调 Tauri 命令。「替换自己的安装文件」是本机权限最高的操作之一，把它做成纯 Rust 能力，页面即使被注入也够不到；签名校验也发生在原生侧，不依赖 WebView 里任何脚本。代价：更新入口在托盘菜单而不是应用内设置页；收益：更新能力不在远程来源页面的可达面内。
- **D7 交叉打包必须换内置 Node，不能只换 Rust target**：安装包内置 Node 二进制，`--target x86_64-apple-darwin` 只换 Rust 产物架构，内置 Node 与原生模块仍是构建机架构，会产出一个「Rust 是 x64、Node 是 arm64」的包——在 Intel Mac 上直接启动失败。因此 `prepare-desktop.mjs` 必须同时处理内置 Node 与 `npm install --cpu`，并由 `desktop-tests` 里的「发布矩阵与内置 Node 架构映射一一对应」守死：**矩阵里每个 target 都必须在 `TRIPLES` 中有映射**，否则会静默退回「复制本机 Node」。
- **D8 签名为发布必需，不提供「无签名也发布」的开关**：`createUpdaterArtifacts: true` + 缺少 `TAURI_SIGNING_PRIVATE_KEY` 时打包会**明确失败**。这是刻意的——没有签名就不该发布更新，客户端也会拒绝安装（同时挡住被篡改的包）。

### 本轮验证记录

| 项目 | 命令 | 结果 | 等级 |
| --- | --- | --- | --- |
| 交叉打包（Apple Silicon → Intel Mac） | `DAYLIGHT_TARGET_TRIPLE=x86_64-apple-darwin npm run desktop:prepare` | 成功；内置 `node` 经 `file` 确认为 `Mach-O 64-bit executable x86_64`（官方 `node-v22.23.3-darwin-x64`），原生模块只剩 `@napi-rs/canvas-darwin-x64`（切回 arm64 时只剩 `canvas-darwin-arm64`，无残留） | 本地测试通过 |
| 交叉打包缓存与重试 | 连续两次同一目标 | 第二次命中 `work/node-dist-cache/`；实测遇到过 `nodejs.org` 连接超时并验证重试后成功 | 本地测试通过 |
| 桌面专有测试 | `npm run test:desktop` | **14/14 通过**（含：发布矩阵与内置 Node 架构映射一一对应、自动更新配置与原生侧流程、Windows PATH 键名大小写、前端产物文件名跨平台合法性、内置运行时只含目标平台原生模块、`latest.json` 地址改写与完整性校验） | 本地测试通过 |
| GitHub Actions（首次真实运行）| `desktop.yml`，仓库 `yunforis/DaylightDesktop` | 首次运行：`macos-14` / `ubuntu-22.04` 全绿，`windows-latest` 连抓三个真实缺陷（下三行）。**修复后 `macos-14` / `ubuntu-22.04` / `windows-latest` 各 17/17 步全部通过** | **云端部署验证通过（三平台 verify）** |
| CI 发现并修复：Windows 凭据文件权限 | `windows-latest` → 桌面专有测试 #4 | `expected 384 / actual 438`：Windows 无 POSIX 权限位，断言按平台分支改写 | 云端抓到，本地修复 |
| CI 发现并修复：Windows `desktop:check` 静默失败 | `windows-latest` → Rust 壳层检查 | 退出码 1 且无任何输出；根因是 `env.PATH` 与 `Path` 大小写不同键共存，系统挑到了不含 cargo 的那个 | 云端抓到，本地修复 |
| CI 发现并修复：CRLF 行尾让断言失效 | `windows-latest` → 桌面专有测试 #11 | 剥注释的 `$` 锚点正则匹配不到 CRLF 行尾，把注释当成了违规代码；测试读源码已统一走 `readText()` 归一化行尾 | 云端抓到，本地修复 |
| CI 发现并修复：资源文件名以点结尾 | `windows-latest` → Rust 壳层检查 | `resource path `runtime\dist\assets\LICENSE_JBIG2-C_izpuvI.` doesn't exist`；Vite 默认命名对无扩展名文件产出以点结尾的名字，Windows 非法。`vite.config.js` 修命名，`prepare-desktop.mjs` 打包前整树校验 | 云端抓到，本地修复 |
| **六平台发布流水线首次真实运行（草稿）** | `release.yml`，`workflow_dispatch` + 勾草稿，标签 `v0.1.0` | `macos-arm64` / `macos-x64` / `windows-x64` / `windows-arm64` 四个目标**真实构建成功**；`linux-x64` / `linux-arm64` 在 AppImage 打包失败（下两行）；`校验版本` 通过，草稿 Release 里已能看到产物 | **云端部署验证通过（4/6 目标）** |
| CI 发现并修复：AppImage 打包被 musl 原生模块打断 | `linux-x64` / `linux-arm64` → `构建并发布` | `failed to run linuxdeploy`（Tauri 默认日志级别丢掉了 linuxdeploy 的 stderr）。用 `--verbose` 拿到真实原因：linuxdeploy 对 AppDir 里每个 ELF 跑 `ldd`，而 `@napi-rs/canvas-linux-*-musl` 的解释器在 Ubuntu 上不存在 → `ldd` 非零退出 → linuxdeploy 抛异常。根因是这些平台包**只声明 os/cpu、没有 libc 字段**，npm 在 Linux 上把 gnu 与 musl 两份都装了进来 | 云端抓到，本地修复 |
| 定位手段：让打包器说出外部工具的 stderr | 读 Tauri `tauri-bundler` 源码 + `--verbose` 重跑 | 打包器仅在日志级别为 Error 时丢弃输出（`return Err(GenericError("failed to run linuxdeploy"))`），级别更高时走 `output_ok()`，会把 stderr 拼进错误信息。已把 `--verbose` 固定进发布工作流，失败时另有一步打印 AppDir 现场 | 本地测试通过（源码级确认）+ 云端实测 |
| 运行时只留目标平台的原生模块 | `npm run test:desktop` #13 + 反向对照 | linux/x64 与 linux/arm64 目标各自只剩 `canvas-linux-x64-gnu` / `canvas-linux-arm64-gnu`；**撤掉修正重新准备后该测试精确失败并点名 `canvas-linux-x64-musl`** | 本地测试通过 |
| CI 发现并修复：并发创建劈出两份草稿 Release | 用 Release API 逐个核对产物清单 | 同一标签 `v0.1.0` 下出现**两份**草稿（创建时间差 2 秒）：一份 11 个产物（只有 macOS + Windows x64），另一份 23 个（有全部 Linux 产物却没有 Windows x64），两份 `latest.json` 各缺一半。根因：`tauri-action` 用「按标签查已有 Release」的接口找草稿，而那个接口**不返回草稿**，六个并发 job 于是各建一份 | 云端抓到，本地修复 |
| CI 发现并修复：`latest.json` 用的是资产 API 地址 | 匿名实测 `GET api.github.com/repos/.../releases/assets/<id>` | `Accept: application/octet-stream` → 302 到真正的二进制；**普通通配 Accept（客户端更新器的行为）→ 200 + `application/json`**，拿到的是资产元数据而不是安装包。客户端会「下载」到一段 JSON，签名校验必然失败，自动更新整条链路走不通 | 云端抓到 + 本地实测请求语义，已修复 |
| `latest.json` 地址改写与完整性校验 | `npm run test:desktop` #14 | API 地址 → `releases/download/<tag>/<文件名>`；签名与其它字段原样保留；**重复运行不再改动**（幂等）；指向不存在的资产、或形态不认识的地址一律报错；六个平台缺任何一个都能被检出 | 本地测试通过 |
| **六平台发布流水线真实运行（修复后完整一轮）** | `release.yml`，`workflow_dispatch` + 勾草稿，标签 `v0.1.0`，run [`39053509331`](https://github.com/yunforis/DaylightDesktop/actions/runs/39053509331) | `校验版本` + **六个平台 job**（`macos-arm64` / `macos-x64` / `linux-x64` / `linux-arm64` / `windows-x64` / `windows-arm64`）+ `修整 latest.json` **全部 success**。全程只创建 **1 份**草稿 Release（`id=415954992`，`draft=true`，第二轮复用了第一轮那份，走的正是幂等复用分支），收齐 **27 个产物**：macOS 双架构 `.dmg` + `.app.tar.gz` + `.sig`、Windows 双架构 `-setup.exe`（NSIS）+ `en-US.msi` + `.sig`、Linux 双架构 `AppImage` + `.deb` + `.rpm` + `.sig`，以及 `latest.json` | **云端部署验证通过（六平台出包，草稿）** |
| `latest.json` 指向公开下载地址（真实产物核对） | 从草稿 Release 读回 `latest.json`（`Accept: application/octet-stream`） | 18 个平台键全部指向 `https://github.com/yunforis/DaylightDesktop/releases/download/v0.1.0/<文件名>`，不再是需要鉴权的 asset API 地址；`windows-x86_64` / `windows-aarch64` 指向 `-setup.exe`，另有 `-msi` 键指向 `.msi`；六个必需平台（darwin/linux/windows × aarch64/x86_64）齐全 | 云端部署验证通过（草稿） |
| 发布正文模板 | `sed "s/{{VERSION}}/0.1.0/g" .github/release-body.md` | 版本占位替换正确，六平台下载表与实际产物名一致 | 本地测试通过 |
| 产物文件名与引用自检 | `npm run test:desktop` #12 + 反向对照（撤掉修正重新构建） | 修正生效时 0 个非法名、117 个 `/assets/` 引用全部存在；**撤掉修正后该测试精确失败并点名那两个文件** | 本地测试通过 |
| Rust 壳层 | `npm run desktop:check` | `cargo check` 通过（新增 updater / dialog 插件与 `update.rs`） | 本地测试通过 |
| 签名安装包构建 | `TAURI_SIGNING_PRIVATE_KEY=work/updater-key/daylight.key npm run desktop:build` | 成功；产出 `Daylight.app` 284.39 MiB、`Daylight_0.1.0_aarch64.dmg` 97.48 MiB，以及**自动更新产物** `macos/Daylight.app.tar.gz`（99.06 MiB）+ `Daylight.app.tar.gz.sig` | 本地测试通过 |
| **更新包签名校验（正向）** | 复刻 `tauri-plugin-updater` 的 `verify_signature` 流程（`minisign-verify`），用 `tauri.conf.json` 里的**公钥**校验打包产出的 103,867,487 字节 `.app.tar.gz` | 校验通过；trusted comment 里的 `version:0.1.0` 与公告版本一致 | 本地测试通过 |
| **更新包签名校验（反向对照）** | 同工具校验「篡改 1 字节」的同一文件 | 被拒绝：`InvalidSignature`。证明上一条不是空检查 | 本地测试通过 |
| 更新配置已编入二进制 | 在 `daylight-desktop` release 二进制里查找公钥与端点字符串 | 两者都已嵌入 | 本地测试通过 |
| 发布流水线结构 | `python3 -c "yaml.safe_load(...)"` 解析两个工作流 | YAML 合法；矩阵解析出 6 个目标，与 `prepare-desktop.mjs` 的 `TRIPLES` 一一对应 | 本地测试通过（静态校验） |
| 发布动作与输入名核对 | 读 `tauri-action` 官方 README（`v1`） | 确认使用 `@v1`、`uploadUpdaterJson`（旧名 `includeUpdaterJson`）、`updaterJsonPreferNsis`；据此外出修正了 Windows 更新包会指向 `.msi` 的问题 | 本地核对官方文档 |
| Linux 依赖清单 | 对照 Tauri v2 官方 Debian/Ubuntu 前置依赖 | 工作流依赖清单已对齐官方列表（补 `build-essential curl wget file libxdo-dev libssl-dev`，加 AppImage 需要的 `patchelf`） | 本地核对官方文档 |
| `npm ci` 与锁文件一致性 | 改动 `package.json` 后 `npm ci --dry-run` | 通过（607 包），CI 不会因加 `repository` 字段而失败 | 本地测试通过 |
| 前端构建 | `npm run build` | 通过 | 本地测试通过 |

### 未验证 / 明确边界

- **六平台出包已在草稿 Release 上真实验证通过，但还没有发布正式版本、也没有在实机上启动过**：`desktop.yml`（三平台 verify）三平台全绿；`release.yml` 六平台矩阵在修掉两个缺陷（Linux AppImage 误收 musl 原生模块、并发创建重复 Release 与 `latest.json` 用了 asset API 地址）后**完整跑通一轮**：`校验版本`、六个平台构建、`修整 latest.json` 全部 success，唯一一份草稿 Release 里收齐六平台安装包与 `latest.json`。**注意这仍是草稿**：`v0.1.0` 标签要到发布时才创建，公开更新地址 `releases/latest/download/latest.json` 在发布前返回 404，客户端会显示「还没有取到可用的更新信息」。**发布动作需要人明确决定后再做**；`latest.json` 里的 `releases/download/v0.1.0/...` 地址在发布后才会生效。
- **文件名必须在 Windows 上也合法**：安装包里的每个文件名不能以点或空格结尾、不能含 `<>:"|?*`、不能用 `CON`/`PRN`/`NUL`/`COM1`/`LPT1` 这些保留名。构建发生在 macOS / Linux 上，这类文件名在那里完全合法，问题只会在 Windows 用户机器上出现。Vite 的默认资源命名就踩过：没有扩展名的文件（pdfjs-dist 的 `LICENSE_JBIG2`）会被命名成 `LICENSE_JBIG2-C_izpuvI.`。`vite.config.js` 已修掉这一点，`prepare-desktop.mjs` 在打包前会检查一遍并直接报错，`desktop-tests` 也有断言守着。\n- **Windows 上凭据文件没有 POSIX 权限位**：`server/secure-json.js` 写盘请求 `mode: 0o600`，Windows 会忽略它，Node 读回来恒是 `0o666`（CI 实测 `expected 384 / actual 438`）。这一侧的实际保护是「主密钥存进 Windows 凭据管理器」+「`%APPDATA%` 目录继承的 ACL」，都无法用 `fs.stat` 断言。`desktop-tests` 已改为按平台分支断言，并在注释里写明原因，不假装 Windows 上也验证了 0600。
- **Windows 上 PATH 的键名是 `Path`，曾导致 `desktop:check` 静默失败**：`scripts/desktop.mjs` 里写的是 `env.PATH = ...`，而 `env` 是从 `process.env` 展开出的普通对象（大小写敏感），于是新增了一个键而不是改已有的 `Path`，交给子进程的环境块里同时存在 `Path` 与 `PATH`，系统挑到了不含 cargo 的那个——`spawnSync('cargo')` 找不到可执行文件，`npm run desktop:check` 只给出退出码 1、**全程没有任何输出**（CI 日志里唯一线索就是这一行）。已改为按键名不敏感地定位 PATH，并在 `cargo` 启动失败时明确报出原因；`desktop-tests` 里有静态断言守住写法。**这个差异只在 Windows 上存在**：macOS/Linux 的环境块是真·大小写敏感，复刻不出「系统在重复键里挑一个」的行为，所以本机无法行为验证，只能靠 `windows-latest` 上的真实运行。
- **Windows 检出是 CRLF 行尾**：正则里的 `.` 不匹配 `\r`，带 `$` 锚点的断言在 CRLF 上会静默失效。写上面那条 PATH 守卫时就踩了一次——剥注释的 `/\/\/.*$/` 在 CRLF 下匹配不到行尾，把注释里那句「不要写 `env.PATH`」当成了违规代码，于是在 `windows-latest` 上失败、在 macOS 上通过。测试里读源码现已统一走 `readText()` 先归一化行尾。
- **文件名必须跨平台合法，构建期就要挡住**：Windows 不允许文件名以点或空格结尾、不允许含 `<>:"|?*`、不允许 `CON`/`PRN`/`AUX`/`NUL`/`COM1..9`/`LPT1..9` 这些保留名。构建在 macOS/Linux 上跑，这类名字在那里完全合法，只有 Windows 用户会中招。Vite 的默认资源命名踩过这个坑：没有扩展名的文件（pdfjs-dist 的 `LICENSE_JBIG2`）会被命名成 `LICENSE_JBIG2-C_izpuvI.`，Tauri 打包时报 `resource path ... doesn't exist`；`vite.config.js` 已修，`prepare-desktop.mjs` 打包前会整树检查并报错。**这也是 `windows-latest` 那一步存在的意义**：不要在 Mac 上看到绿就认为跨平台没问题。
- **自动更新未做端到端验证**：已验证「签名能被应用内嵌公钥接受、篡改即拒绝」，但**下载 → 校验 → 替换安装文件 → 重启**这条完整链路需要先发布两个真实版本才能验证。Linux 上还额外依赖 AppImage 形态（`.deb` 装的版本不会自动更新）。
- **`tauri.conf.json` 里的公钥与 `work/updater-key/` 的私钥是本轮新生成的**，此前没有更新密钥。若私钥丢失，客户端会拒绝后续所有更新，只能让用户手动重装——`work/updater-key/` 需要自行备份（不进仓库）。
- **macOS 未签名未公证**：本轮与 CI 默认产出未签名包，首次打开需要在「系统设置 → 隐私与安全性」手动放行。配好 `APPLE_*` Secrets 后可自动签名公证，需要 Apple 开发者账号。
- **安装包在真实 Linux / Windows runner 上构建成功 ≠ 应用在那两个系统上跑起来了**：六平台构建是在 GitHub 托管的 `ubuntu-22.04` / `ubuntu-24.04-arm` / `windows-latest` / `windows-11-arm` 上真实执行的（不是本地模拟），但**没有在实机上启动过**——没有对应机器可用，也没有人验证过界面、托盘、托盘菜单、PDF 预览与自动更新在 Windows / Linux 上的实际表现。这一条要一直挂到真有实机验证为止。
- **原生模块只能留目标平台那一份，尤其是 Linux 的 glibc/musl**：`@napi-rs/canvas` 的平台包只声明 `os`/`cpu`、**没有 `libc` 字段**，npm 在 Linux 目标上会把 `canvas-linux-*-gnu` 与 `canvas-linux-*-musl` **同时**装上。musl 那份会让 AppImage 打包直接失败（linuxdeploy 对 AppDir 里每个 ELF 跑 `ldd`，musl 的解释器在 Ubuntu 上不存在），而且白占约 28 MB。`prepare-desktop.mjs` 现在按 lock 的 os/cpu 元数据清除异平台原生包，并在打包前独立复核一遍；`desktop-tests` #13 也用包自身的 `os`/`cpu` 断言守着。**换 npm 版本或新增原生依赖时都要留意这一类「装多了」的问题**——它在 macOS 与 Linux 上都很容易看不出来。

## 上一轮：与 Daylight 真源对齐 + 桌面端专有改造（2026-10-17）

### 对齐基线

- Web 真源：`/Users/auroral/ProjectDevelopment/Daylight`，提交 `82d682b`（该工作区仍在并发开发，同步时点见本节验证记录）。
- 对齐方式不变：**重新基线 + 重贴桌面补丁**，由 `scripts/desktop-sync.mjs` 一条命令完成，可重复执行。它只读真源、只写本仓库，补丁锚点找不到就报错，不静默跳过。
- **同步口径（本轮新增约定）**：基线取真源**已提交的 HEAD**，而不是真源的工作目录。做法是先 `git -C <真源> archive HEAD | tar -x -C work/web-head`，再用 `DAYLIGHT_WEB_DIR=work/web-head node scripts/desktop-sync.mjs`。理由：真源工作区经常有未提交的在改代码（本轮同步时为 `docs/hackathon-report/*`、`src/components/event-dialog.jsx`、`src/components/studio-calendar.jsx`），直接同步会把别人写了一半的改动带进桌面端。已核对这两个组件文件与 HEAD 逐字节一致，未被带入。
- 本轮对齐的增量很小：真源在 `be75dac` 之后又提交了 2 条，功能增量只有 `shared/reminder-rules.js`（+38 行，`3faef80`），文档增量是 `README.md`/`README_EN.md`/`DEPLOY.md`/`CONTRIBUTING.md`/`docs/assets/readme/*`（`82d682b`，桌面端有自己的一套文档，不参与同步）。`shared/reminder-rules.js` 新增了**规则级提示音 `soundId` 与闹钟级 `alarm`**、**全局提示音与早间简报 `briefing`**（`DEFAULT_BRIEFING` / `normalizeBriefing` / `nextBeijingTime`）。对齐后 `shared/` 与真源逐字节一致。
  - 需要如实说明的范围：这两侧目前**都没有消费方**——`normalizeBriefing` / `nextBeijingTime` / `DEFAULT_BRIEFING` 除 `shared/reminder-rules.js` 自身外无任何引用（真源侧同样如此，`src/` 里搜不到 `soundId`），所以本轮同步进来的是**提醒引擎能力**，桌面端「本地测试通过（引擎归一化）」而非「界面已经能设置提示音/早间简报」。等真源把 UI 补上后重新同步即可自动获得。
- 上一轮（第二轮对齐，基线 `be75dac`）追上的上游能力，全部在桌面端直接可用：
  - **邮件写回真实邮箱**（`server/agent.js`，默认关闭；开关未开时明确报错，不会只改本地留下不一致）；
  - **一句话提醒规则解析** `POST /api/reminders/parse`（无状态，规则存在手机端，不写业务数据）；
  - **视图作用域隔离** `server/view-scope.js`（切回单邮箱时按当前视图隔离列表）；
  - **真实会议链接** `shared/meeting-link.js`、**邮箱身份** `server/mailbox-identity.js`、**RAG 开关** `server/rag/flags.js`；
  - **品牌与界面**：全站图标换成「日出信封」（`src/components/brand-mark.jsx` + `public/logo.png` 等）、搜索高亮 `src/components/highlight-text.jsx`；
  - **PDF 预览组件化**：上游新增 `src/components/pdf-preview.jsx`，桌面端**改为直接复用**（见 D3）。
- 对齐后差异收敛为最小集合：
  - `src/`：仅 `App.jsx`、`main.jsx`、`command-palette.jsx` 分叉；桌面专有新文件 `src/lib/desktop.js`。
  - `server/`：仅 `index.js`、`auth.js`、`store.js`、`infra/config.js` 分叉；桌面专有模块 `desktop-entry.js`、`desktop-http.js`、`secure-json.js`。
  - `shared/`、`public/`、`index.html` 与 Web **逐字节一致**（已用 `cmp` 逐文件核对）。
- 同步素材说明：`Dockerfile` 与 `docs/submission/evaluation-cases.json` 纳入同步，**只因为共享测试套件会读取它们**；桌面端不使用容器部署，也不参与比赛材料提交。缺了它们会出现 2 项桌面独有的测试失败（`Dockerfile 的 build 阶段…` 整条，以及 `server/mail-evaluation.test.js` 因读不到评测用例而整文件加载失败）。

### 决策记录

- **D1 本地单用户认证（采用默认）**：启动时由原生壳层经 `/desktop/session` 注入本地 `owner@daylight.local`（admin）会话；不引入云端账号、订阅或注册后端。
- **D2 去管理端（与默认口径有一处刻意不同）**：**前端** Landing / 登录 / 注册 / 找回密码 / 法律页 / 管理端页面与入口**全部移除**；**后端** 不删除 `/api/admin/*` 的 280 余行实现，而是在桌面模式用单点守卫统一返回 404（`index.js` 中 `app.use('/api/admin', ...)`）。
  - 理由：桌面端 `App.jsx` 是桌面自有文件，删除前端页面零成本且不产生后续同步负担；而 `server/index.js` 是 Web 侧改动最频繁的文件，删块会让每次重新基线都要做脆弱的自动删除，换来的收益只是「本地唯一用户（本就是 admin）看不到自己账号的管理接口」，不划算。守卫方案同样做到了「管理端接口在桌面端不可达」，且可重复、可校验。管理端模块 `server/admin-assistant.js` 因此保留（仅被不可达路由引用）。
- **阶段 7 后台任务（/api/jobs）**：桌面端**沿用本地进程内模式**，不伪造任务队列。
  - 依据：Web 的前端本身就把「无任务队列」当作一等公民状态——`jobs-page.jsx` 对 404 显示「当前服务未启用后台任务，邮件同步结果请在邮件与执行记录中查看。」；`use-background-jobs.js` 在收到 404 时把 `supported` 置为 false 并停止轮询。桌面端 `server/index.js` 的非生产分支已有进程内 worker 与定时器（`registerWorker('mail.sync')` + `setInterval` + `refreshIdleWatcher`），同步在本地模式下是同步返回结果。
  - 结论：引入忠实于 PG 版本的任务平台需要重写租约、快照提交、outbox（`storage/index.js` 依赖 pg pool，`jobs/repository.js` 的租约用 SQL 时间），风险与工作量都不成比例；对一个单用户本机应用，同步流程已经可用且可观测。该差异已明确标注为**本地模式**，页面文案由 Web 侧代码提供，不是桌面端特例。

- **D3 PDF 预览复用上游组件（推翻上一轮的自研方案）**：上游新增的 `src/components/pdf-preview.jsx` 用 `pdfjs-dist` 在页面内渲染，并用 `import.meta.glob('/node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*')` 把 CJK CMap、标准字体与 wasm 解码器打进前端产物；`useWorkerFetch: false` 让主线程取回资源后再交给 worker。它本来就是为「宿主没有内置 PDF 查看器」写的，与桌面端需求完全重合。
  - 因此**删除**上一轮自研的 `src/components/pdf-canvas-viewer.jsx`、5 条相关桌面补丁，以及后端 `/desktop/pdfjs/*` 静态目录（连带 `express`/`fs`/`path` 依赖与 cookie 豁免）。
  - 收益：少一个组件、少一个后端路由、少 5 条补丁，上游后续改进自动继承；代价：渲染尺寸改由 `ResizeObserver` 驱动，交互变成单页 + 上下页 + 缩放（上游的产品选择），桌面端跟随。
- **D4 把 `Dockerfile` 与评测用例一起同步**：两者与桌面端运行无关，但共享测试套件会读取它们。同步进来比维护一份「桌面端豁免哪些测试」的清单更简单，也让「测试结果与真源逐条一致」这个断言保持可验证。
- **D5 同步基线只取真源已提交的 HEAD（本轮新增，用户确认）**：`scripts/desktop-sync.mjs` 是整树复制，默认会读真源**工作目录**，因而会把真源未提交的在改代码一并带进桌面端。已发现的具体后果：上一轮提交（`ad79a6b`）里 `src/components/event-dialog.jsx`（日程弹窗双栏改版）与 `src/components/studio-calendar.jsx` 实际是真源**未提交**的 WIP，至今仍未在真源提交。
  - 本轮起基线改为「真源 `git archive HEAD` 的导出」，那两个文件已回退到 `82d682b` 版本。选择理由（用户确认）：桌面端要能回答「等于真源哪个提交」，可复现优先于提前拿到未评审的改动；真源一旦提交，下一次同步会自动拿回。
  - 注意这**不是**「桌面端不要这个改版」，而是「不把未提交代码当成已发布能力」。判定方法：`git -C <真源> status --porcelain`，有输出就要改用 HEAD 导出。

### 桌面端专有改动（阶段 10）

- **PDF 预览改为复用上游组件**（本轮推翻上一轮的自研方案，理由见 D3）：上一轮新增的 `src/components/pdf-canvas-viewer.jsx`、对应 5 条桌面补丁、以及后端 `/desktop/pdfjs/*` 静态目录**全部删除**。离线可用性改由前端产物保证：`import.meta.glob` 把 CMap/标准字体/wasm 打进 `dist/`，其中体积小于 4 KB 的 134 个 CMap 由 Vite 内联为 `data:` URL，其余作为 `dist/assets/*.bcmap` 落盘。
- **Office 附件不再需要桌面补丁**：上游自身就有 `if (!url || url.startsWith('/')) return null` 的判断。桌面端附件地址都是相对路径（`/api/attachments/...`），会走「该附件暂无公网地址，无法内嵌 Office 预览，请下载后本地打开」，不会请求 `view.officeapps.live.com`；上一轮为此写的补丁已移除。
- **CSP 与安全边界（澄清）**：`src-tauri/tauri.conf.json` 的 CSP 保留 `img-src/media-src ... blob: data:`、`worker-src 'self' blob:`、`font-src`、`frame-src 'self'`，并在 `connect-src` 上补 `data: blob:`。需要明确：该 CSP 由 Tauri 注入**壳层加载页**；应用页由回环 HTTP 提供，Express **没有**下发 CSP 头，真正的边界是 `Host` 回环 + `Origin` 一致 + 壳层 cookie 三层校验（`server/desktop-http.js`）。不把「配置了 CSP」当成应用页已受 CSP 保护。
- **打包缺失修复**：`scripts/prepare-desktop.mjs` 原先只复制 `server/` 与 `dist/`，漏了 `shared/`，而 `server/scenarios/service.js` 会 `import` `shared/scenario-templates.js` —— 安装版会直接启动失败。已修正为 `['server', 'dist', 'shared']`，并由 `desktop-tests` 中的打包运行时测试守护。
- **语音输入**：沿用 Web 的能力探测实现 `src/lib/little-d-speech.js`（`SpeechRecognition`/`webkitSpeechRecognition` 探测 + 不支持时的明确文案），`little-d.jsx` 已改为复用它。
- **重活不阻塞界面**：后台 Node 进程与 WebView 是不同进程，OCR/PDF 解析不会阻塞渲染；OCR 由 `tesseract.js` 自带的 worker 执行。
- **端口回退**：固定端口被占用时回退随机端口（`server.on('error')` + `EADDRINUSE`），原生壳层解析 `DAYLIGHT_READY <port>` 后再导航。

### 上一轮验证记录

| 项目 | 命令 | 结果 | 等级 |
| --- | --- | --- | --- |
| 前端构建 | `npm run build` | 通过；`dist/` 8.4 MB，含 `pdf.worker.min-*.mjs`、34 个 `.bcmap`、标准字体与 4 个 `.wasm`（另有 134 个 CMap 被内联为 `data:` URL） | 本地测试通过 |
| 补丁锚点 | `node scripts/desktop-sync.mjs --check` | 17 条补丁在 Web 真源上全部命中 | 本地测试通过 |
| 真源增量同步（`be75dac` → `82d682b`） | `git archive HEAD` 干净基线 → `DAYLIGHT_WEB_DIR=… node scripts/desktop-sync.mjs` | 397 个文件重写、12 个 Web 专有文件移除；功能增量只有 `shared/reminder-rules.js`（+38 行）。同步后 `shared/` 逐字节一致，真源未提交的 `event-dialog.jsx`/`studio-calendar.jsx` 未被带入 | 本地测试通过 |
| 逐条用例状态 diff | Web HEAD 干净基线 vs 桌面端各跑一次 `node --test server/*.test.js` | 两侧同为 680 / 587 通过 / 58 失败 / 35 跳过，672 条顶层用例状态 diff 为空 | 本地测试通过 |
| 文件级对齐 | `cmp` 逐文件比对 `src/ server/ shared/ public/` | 除 3 + 4 处桌面补丁文件外与真源逐字节一致 | 本地测试通过 |
| 共享业务测试 | `node --test server/*.test.js` | 680 项：587 通过 / **58 失败** / 35 跳过；与 Web 真源**逐条用例状态完全一致**（状态 diff 为空） | 本地测试通过（含与真源相同的历史失败） |
| 桌面专有测试 | `npm run test:desktop` | **8/8 通过**（无 PG/Redis/MQ 启动并重启读回、鉴权三层边界、会话一次性、凭据加密、端口回退、补丁锚点自检、pdf.js 离线资源与自产 PDF 渲染、打包运行时不含 `vite` 且能独立启动） | 本地测试通过 |
| PDF 真实渲染 | 真实 Chromium 打开桌面后台 `/app/recruitment` → 体验招聘示例 → 预览简历 | 画布 1758×2488（CSS 879px，DPR 2），整页 4,373,904 个不透明像素、20,866 个字形像素；工具栏「第 1 / 1 页 100%」，无错误提示 | 本地测试通过（真实浏览器 + 真实后台） |
| 路由冒烟 | 真实 Chromium 遍历 `/app` 等 11 个路由 | 全部正常渲染；顶栏「10月17日 · owner@daylight.local」，品牌图标 `/logo.png`，登录/注册/管理端链接 0 个；`/app/jobs` 显示「当前服务未启用后台任务」 | 本地测试通过 |
| 后端冒烟（生产模式、无 PG/Redis/MQ、仅回环） | 真实后台 + `curl`，鉴权三层由 `npm run test:desktop` 守护 | 就绪并打印 `DAYLIGHT_READY 14377`；`/desktop/start?token=…` 302 到 `/app`；无 cookie 403；伪造 `Host: evil.example` 403 | 本地测试通过 |
| 运行时打包 | `npm run desktop:prepare` | 通过；`runtime/` 301 MB，含 `shared/`、`pdfjs-dist`、`@napi-rs/canvas`（`server/pdf.js` 的服务端 PDF 渲染确实用到），**不含 `vite`** | 本地测试通过 |
| Rust 壳层 | `npm run desktop:check` | `cargo check` 通过（上一轮记录；本轮 `desktop:build` 再次完成 release 编译与打包） | 本地测试通过 |
| 安装包 | `npm run desktop:build` | `Daylight.app` 282.53 MiB、`Daylight_0.1.0_aarch64.dmg` 96.54 MiB（macOS arm64；`82d682b` 基线上复打包成功） | 本地测试通过 |

### 安装包

```
src-tauri/target/release/bundle/
├─ macos/Daylight.app                     282.53 MiB（`du -sh` 303 MB）
└─ dmg/Daylight_0.1.0_aarch64.dmg          96.54 MiB
```

- 安装包内含 Node 二进制、后台代码（`server/` + `shared/`）、前端产物与运行时依赖，终端用户无需安装环境。
- 本轮只产出 macOS arm64；x64 / Windows / Linux 需在对应平台或 CI 上执行同一条 `npm run desktop:build`。
- 与上一轮相比 `.app` 约 +5 MB：前端产物新增了随包分发的 pdf.js CMap / 标准字体 / wasm（`dist/` 8.4 MB）；后台的 `pdfjs-dist` 仍需保留，因为 `server/pdf.js` 的服务端 PDF 渲染会用到。

**共享业务测试的 58 项失败**：全部是同时启动真实 Express 服务、mock timer、依赖本机环境的集成测试（招聘 API、草稿发送、小 D 真实 HTTP 等），在 Web 真源上以**完全相同的集合**失败。本轮用「逐条用例状态 diff」核对（而不是只比失败集合），差异为空。CI 中该步骤 `continue-on-error: true`；这些是历史遗留，不是桌面端改造引入。

**PDF 渲染核对的自动化前提**：自动化浏览器的标签页始终是 `visibilityState: 'hidden'`，`requestAnimationFrame` 与 `ResizeObserver` 回调都不会触发，而 pdf.js 的绘制循环与上游组件的尺寸测量正依赖这两个 API。核对时用 `setTimeout` 顶替，因此这是**应用逻辑 + 真实浏览器渲染管线**的验证，不等于在可见 GUI 窗口下的观察。

### 未验证 / 明确边界

- **真实邮箱与真实模型**：本轮**未做**任何真实 IMAP/SMTP/模型实连，也未运行示例以外的提取。特别地，本轮同步进来的「邮件写回真实邮箱」默认关闭，只验证了「开关未开时明确报错、不静默改本地」这条路径，**未验证真实写回**；`/api/reminders/parse` 需要已配置模型，本轮也未用真实模型调用。历史实连记录见下方 2026-10-15 及更早小节，仅作历史证据。
- **界面渲染**：PDF 渲染已在真实浏览器核对（见上表），但**没有**在可见窗口的 Tauri GUI 中逐平台核对；Office 附件提示、邮件正文 `iframe`、图片/音视频预览同理。
- **Windows / Linux**：未在对应实机运行；CI 配置已就绪（三平台 verify + 六平台 release），但**Actions 未实际运行过**。
- **睡眠唤醒**：未做显式的系统唤醒事件监听。Node 的定时器在唤醒后会继续触发，属于可接受行为，但未实测。
- **字体**：`index.html` 仍从 `fonts.googleapis.com` 取 Noto Sans SC / Sora / Space Grotesk，离线时回退系统字体；桌面端未内置字体文件（避免安装包体积与字重授权扩散）。
- **/api/jobs**：桌面端无任务列表接口（见上方决策），后台任务页显示「当前服务未启用后台任务」。

## 桌面端改造（2026-10-15，历史存档）

> 以下小节为历史记录原文，保留用于追溯。其中与桌面端当前默认行为不一致处已在上方更正：本版桌面端**默认不连 PostgreSQL**（`infra.postgres.enabled = false`）、默认不连 RabbitMQ，配置落盘加密。

- **项目定位变更**：从 Web 应用改为纯桌面端应用（Tauri 2）。移除了 Landing 页、用户注册/登录/找回密码、管理后台、法律页等 Web 专属内容。根路径 `/` 直接重定向到 `/app` 工作区。
- **桌面认证**：启动时自动创建本地用户 `owner@daylight.local`（admin 角色），通过 `desktop-http.js` 的 token 机制认证，无需用户注册登录。Rust 壳层使用系统 keyring 保存加密密钥。
- **Tauri 壳层**（`src-tauri/`）：系统托盘（打开/数据目录/退出）、关闭窗口隐藏到托盘、单实例限制、窗口状态记忆、外部链接用系统浏览器打开、启动加载页。
- **内置 Node 运行时**：`npm run desktop:prepare` 将 Node 二进制和 server 代码打包到 `src-tauri/runtime/`，用户无需安装 Node。
- **验证结果**：
  - `npm run build` 前端构建通过
  - `npm run desktop:check`（cargo check）Rust 编译通过
  - `npm run desktop:build` 打包成功，生成 `Daylight.app`（292MB，含内置 Node）
  - `.app` 实际启动验证通过：Tauri 主进程 + Node 后台（`127.0.0.1:随机端口`）正常运行
  - 桌面端后台接口验证通过：`/desktop/session` 认证、`/api/state` 状态、`/api/sync/demo` 示例导入均正常
  - `npm test`：150/172 通过，22 个失败为历史集成测试问题（mock timers 环境敏感），非桌面改造引入

## UI / 认证 / 主题（2026-10-15）

- 候选人详情 Sheet：内容区 `min-h-0` + 可滚动，简历版本改用 shadcn `Select`（不再用原生 `<select>`）。
- `/app` 工作区**始终要求登录**（不再依赖 `infra.auth.requireAuth` 开关）；API 默认 `requireAuth: true`。
- 主题色深化：墨绿 / 晴蓝 / 琥珀 / 玫雾 会改变背景、卡片、侧栏、圆角、氛围渐变与日历色，而不只是按钮 primary。

## 外部日历 / 待办责任人 / 存储说明（2026-10-15）

- **外部日历**：设置「外部日历」支持 Google OAuth、Outlook/Microsoft 365 OAuth、iCloud/通用 CalDAV；邮件提取与手动增删改会推送远端。日历页有「导出到外部日历」（推送已连接日历 / 下载 ICS）。另提供 `/api/calendar.ics`。真实 OAuth/CalDAV 需用户自备 Client ID/密钥或 App 专用密码。
- **待办**：提取支持 `assignee` 责任人；后续提醒邮件命中已完成任务时会重开（`pending`），并保留重开来源。
- **存储**：**默认启用 PostgreSQL**（`infra.postgres.enabled=true`，连不上自动回退 JSON）；双写并以库为权威，JSON 作缓存；启动 hydrate 取较新一侧。设置「数据」页展示当前主存储。

## 设置：模型与单价合一（2026-10-15）

- 设置「模型」页将 API Key / Base URL / 模型名称与可选费用单价合并为同一卡片；单价随当前账号的模型配置一起保存。
- 选择提供商预设时可带入参考单价（中转/自定义不强制）；估算费用仍基于接口 usage，不是官方账单。

## 新手指引 / 错误页 / 加载（2026-10-15）

- 新手指引升级为「具体用法」9 步（设置→同步→总览→日历→邮件→待办→招聘→日志→小 D）；进度存 `daylight.onboarding.v2`，刷新不闪弹窗；登录不再对已完成用户反复触发。
- 全局 404、`/502` / `/500` 与工作区加载失败页；`ErrorBoundary` 兜底渲染错误。
- `index.html` 首屏 boot + `BootScreen` 鉴权/工作区等待，路由切换不再每次重验导致白屏闪烁。

## 分支合并（2026-10-15）

在 `feat/cloud-native-platform` 上合并 `origin/master` 的智能招聘能力。**冲突与配置以本分支（本地平台版）为准**，招聘业务能力兼容接入，不覆盖本机 `data/settings.json` / `data/infra.json`。

- 冲突文件（`server/agent.js` / `index.js` / `store.js`）已手工合并：保留本分支 userPrefs、mailFilters、附件 OSS、拉取策略；并接入招聘 `handleSpecialEmail` / feishu / PDF。
- 前端以本分支 shadcn + `/app` 壳层为主：路由 `/app/recruitment` + 侧栏「智能招聘」；邮件分类含「求职简历」与显示开关；设置增加飞书会议；邮件详情接入简历附件重试。招聘页业务组件复用对方逻辑，外层布局/导航为本分支风格。
- IDLE：本机已配置 `syncStrategy: idle`；代码默认 poll（无配置时），有配置则尊重本地；保存后 `refreshIdleWatcher`；状态字段读 `active`。
- MQ：代码默认 `mq.enabled=true`（provider=rabbitmq）；连不上时 `initQueue` / `enqueue` 自动回退进程内同步执行。自动同步统一 `enqueue('mail.sync')`。设置页展示 `infra.mq`（兼容旧 `queue` 字段）。
- 验证：本轮 `npm run build` 通过；`npm test` **170/170 通过**。招聘真实 OCR/模型联调仍以 2026-10-14 记录为准，本轮未重复实连。

## 智能招聘实现（2026-10-14）

新增按邮箱隔离的招聘模块，保持 React + 单 Node 服务 + JSON。业务存储、附件访问和外部服务入口分开，为后续数据库、对象存储、后台任务迁移保留边界；当前仍是单进程本地 demo，不具备多实例并发写入能力。

- `resume` 求职分类和邮件显示开关；求职投递不会创建日程或待办。
- PDF 原件保存、文字层提取、逐页本地中英文 OCR、结构化候选人及来源证据。
- 候选人按明确联系方式合并，保留投递与简历版本；失败附件分别重试，成功版本不重复。
- 智能招聘页面、人才详情、原邮件/PDF、自然语言工具对话、完整及部分条件匹配、实际日志回放。
- 待审核面试草稿、手填链接或飞书 API 创建、审核后 SMTP 发送、成功后面试入历、来信改期与取消审核。重复确认不重复发信；日历写入失败时仅补写日历，旧改期草稿和同一面试的并发变更不会重复发送。
- 新依赖为 `pdfjs-dist`、`@napi-rs/canvas`、`tesseract.js`，用于真实本地 PDF/OCR；不增加数据库、队列或 Agent 框架。

新入口：招聘存储 `server/recruitment-store.js`，业务/工具 `server/recruitment.js`，邮件附件编排 `server/resumes.js`，PDF/OCR `server/pdf.js`，飞书 `server/feishu.js`，共享 JSON 模型调用 `server/model-json.js`，页面 `src/Recruitment.jsx`。原收信、API、日历和日志入口继续使用。

新增 `/api/recruitment` 状态、`/chat` 对话、`/demo` 预置导入、`/candidates/:id` 资料、`/attachments/:id` PDF 与 `/retry`、`/interviews/:id` 草稿编辑及 `/meeting`、`/send`。均基于现有邮箱作用域；附件可通过已注册邮箱与附件 ID 打开。

本次验证结果：

- 最终集成 `npm test`：**165/165 通过**，`npm run build` 与 `git diff --check` 通过。覆盖原有 124 项回归和 PDF/OCR、实际 MIME 附件入库、人才及版本去重、邮箱隔离、模型工具与证据核验、失败附件恢复、审核发送及重启防重复、改期取消、旧草稿与并发变更、发信后日历补写等业务验证。自动测试中的 IMAP、模型、SMTP、飞书为模拟服务；下列实际 OCR/模型验证单独列出。
- 原 `data/settings.json`、`data/calendar.json`、`data/traces.json` 的 SHA-256 与本轮开始时一致；验证使用 `work/` 独立目录，没有改写用户配置、真实邮件、日历或历史日志。基线：`work/recruitment-verification/baseline-hashes.json`。
- 实际中文扫描 PDF 与混合 PDF 通过本地 OCR 验证，语言包首次新缓存下载并识别约 17.8 秒，复用缓存约 2 秒。发现并修复 PDF.js 与不同版本原生 canvas 混用导致扫描图像渲染崩溃的问题，统一 canvas 0.1.100。材料：`work/resume-pdf-verification/ocr-results.json`、`first-download-check.json`。合成 PDF 已经渲染视觉检查；OCR 存在常见标点和少数字段标签误识别，不宣称任意简历准确无误。
- **真实配置模型 + 合成 PDF 验证成功**：一份中文文字 PDF 和一份中文扫描 PDF，实际 PDF/OCR 后各调用一次配置的 DeepSeek，提取姓名、年龄、教育、项目、科研、竞赛与荣誉，保存 2 位候选人，日程和待办均为 0；总耗时约 33.4 秒。材料：`work/resume-live-model-2WO5Id/verification.json`。没有读取真实收件箱或发送邮件。
- **真实配置模型 + 预置人才对话验证成功**：自然语言筛选、第一位详情追问、次日15:00–16:00邀约草稿均实际调用模型和本地工具，分别约 8.4、5.5、11.6 秒；人才资料为虚构示例，邀约仍是未发送草稿。材料：`work/recruitment-live-model-vU0EBn/verification.json`。此前实测发现模型未转义换行、截断 JSON，增加针对性格式处理和最多一次模型修正，并记录两次实际调用用量；接口连接中断仍明确报错可重试。
- 浏览器 QA：3118 合成 API 的 6 组检查通过；3119 实际 API 的预置3人才/PDF/过滤/日志通过；3121 实际前端、Express、工具调度、JSON 与日历链路使用本地 HTTP 模型和 mock SMTP，完整筛选→草稿→审核发送→入历→改期→取消通过。390px 无横向溢出，页面错误为0，保存不发送、服务端改写稿件后重新审核、成功防重复、日历失败仅补写均验证。材料：`work/recruitment-ui/verification.json`、`demo-verification.json`、`integration-verification.json`。独立验证服务已停止。
- 飞书通过模拟 HTTP 验证凭证、创建/更新预约、缓存、真实返回链接校验和错误提示；**尚未配置真实飞书应用，未验证实际创建会议或外部候选人入会**。真实招聘邮件送达未实连，沿用已实现 SMTP 能力；模拟发送不算真实送达。

以下历史记录不作为新增招聘能力完成真实服务联调的证据。

## 1. 当前阶段

**当前代码支持多个邮箱独立日历与待办、切换后立即读取最近 N 封、冲突日程入历并标识，以及通过当前邮箱采纳并发送真实回信。** 保留 3 个候选时段、回复草稿、每分钟自动同步当前邮箱、分类/摘要/优先级、日程新增/取消/调整、结构化字段和处理日志回放。保持 React + 一个 Node 服务 + JSON 文件；新增 PDF/OCR 依赖，见上方招聘实现。QQ、163、126、Gmail、Outlook、iCloud 提供标准 IMAP/SMTP 预设，其他服务可自定义；服务商须允许客户端密码/授权码登录，暂不提供 OAuth。非全天新邀请或改期安排有重叠也入历并提示，全天活动不占冲突时段。本地验证与当前邮箱的真实同步测量见第 5 节；历史 QQ 实连记录保留，其余账号仍需按服务商权限复验。

**2026-10-14 同步优化已生效：最近 N 封先按 UID 检查，已处理邮件不再下载原文；官方 DeepSeek 的 flash/v4-pro 提取关闭思考模式，单次模型等待限制为 60 秒；变更通知按最新日历处理，确定的日程目标匹配失败在上下文未变时暂缓自动模型重试。** 当前真实邮箱的两次全重复同步为 0.645 秒和 1.424 秒，旧服务同类批次约 40.6–43.0 秒；这不是首次新邮件的耗时保证。原失败邮件在重启前由旧版自动重试成功，新版另通过真实模型内存复验确认不重复创建。当时已重启服务验证同步优化；本次招聘更新需安装新依赖并重新启动，完整证据与范围见第 5 节。

**2026-10-14 前端已重构为 shadcn/ui + Tailwind：** 默认进入总览页；另有日历、邮件、执行日志、设置。演示同步收入下拉菜单，去掉长营销文案与单页堆砌。新增依赖含 Tailwind / shadcn 组件与 `react-router-dom`；`npm run build` 通过。

**2026-10-14 studio-admin 风格与设置增强已落地（并补回功能）：** 默认中文 + 黑白主题；顶栏主题色 / 明暗 / 语言；侧栏可收缩。日历用 **FullCalendar 7**，中文 locale，工作/生活颜色区分，「我的日历」勾选筛选；日/周/月/年。月视图日期格悬停高亮，右上角显示 ➕，**仅点 ➕ 新建**（不再整格点击新建）。邮件页恢复**按主题分类筛选**（会议/任务/通知等）。证据链页恢复可观测性头图、统计条、全部/真实/示例筛选与流程说明。设置：拉取方式（最近 N 封或日期范围：今天/昨天/一周/月/年/自定义）、同步策略（轮询 / IMAP IDLE）、一键导出备份与恢复。持久化：JSON + sql.js。默认 Node **22**。

**2026-10-14 `feat/cloud-native-platform` 平台化进行中（不上 K8s）：** 商业 Landing + 登录/注册/找回密码（图形验证码）；待办页已恢复；邮件详情展示完整元数据；存储抽象对接 UDB PG / UMem Redis / URocketMQ|UKafka / US3，默认本地回退并可在设置「存储」页热更新。工作区路由前缀 `/app`。

**同日增量：** 业务日历/设置在启用 PostgreSQL 时双写 `mailbox_calendars` / `app_settings`，启动可从 PG 回填稀疏本地数据；`requireAuth` 开启后 `/app` 与受保护 API 需登录。日视图去掉 classic 白底描边、默认滚动到 7 点；年视图三列扁平月卡并隐藏日期格 ➕。本地 `npm run build` 通过；带现有 data（8 日程 / 6 邮件 / 3 待办）冒烟可用。未配置 PG 时仍落本地 JSON / `users.json`。

**同日认证联调：** `allowLocalDemoLogin` 开启时验证码接口回传 `text`（便于本地联调）；注册→登录→找回→重置→再登录 API 冒烟通过。待办 `shortDate` 已兼容 ISO 创建时间。

**同日 UI：** Landing 改为 Space Grotesk + Noto Sans SC 的墨色/苔绿商业页（产品/流程/模块/可靠多段内容）；登录注册找回为左右分栏 AuthShell。首次进入工作区弹出「是否拉取邮件」与「是否新手指引」；指引为灰色蒙版 + 侧栏高亮 + 上一步/下一步/跳过。

**同日 Landing 商业化：** 页脚含使用条款 / 隐私政策 / 其他政策（`/legal/*`）；下载区预留 macOS（M/Intel）、Windows、Linux、iOS、Android、鸿蒙入口，按 UA 加粗推荐项（客户端未上线则提示即将推出）；明暗切换用 View Transitions + 表面色过渡，去掉 `bg-foreground` 反色色带导致的跳变。`npm run build` 通过。

**同日 Landing 视觉重构（对齐 OpenAI Codex 气质）：** 居中 Hero（品牌标 + Daylight 大字 + 一句主张 + 双胶囊 CTA）、晨雾氛围渐变背景、Sora 标题字体、产品/流程/下载/收束分区留白加大；Hero 主按钮按设备推荐下载。深色模式为墨蓝雾面，非硬切黑白。

**同日认证与管理：** 注册需邮箱验证码（系统 SMTP 配在 `data/infra.json` 的 `systemMail`，凭据不入库文档）；侧栏优先显示用户名，并区分「账号」与「带标签的工作邮箱」；新手指引进度写入 localStorage 且挂在 BootGate 外，避免跳转重置；独立管理端 `/admin`（先 `/admin/login`）含分类可展开侧栏：监控 / 账号 / 工作区 / 系统服务；用户管理支持最近登录、会话列表、强制下线、关联邮箱；存储文案改为本地优先（`/app/admin` 已重定向；`/api/infra` 仅管理员可写）。邮箱支持工作 / 个人 / 生活 / 自定义标签与侧栏快速切换（含「全部/同类混合」）。顶栏为可唤起的全局搜索（⌘J），设置可改快捷键；待办支持右键菜单。

**存储架构现状（2026-10-14 晚）：** 本机 PostgreSQL + Redis + **RabbitMQ**（Docker `daylight-rabbit`，用户 `daylight/daylight`，管理台 `:15672`）。对象存储已实现阿里云 / 七牛 / 又拍云 / US3 / S3，并预留腾讯 COS / 华为 OBS / 百度 BOS / 火山 TOS / MinIO / R2；路径 `users/{用户名}/mailboxes/...`。系统发信模板（注册 / 找回密码 / 通知 / 功能更新）可在 `/admin/mail` 配置。日/周/年日历边框与月视图统一。`data/` 已 gitignore。

**同日小 D / 年视图 / 关联邮件：** 工作区右下角「小 D」磨砂玻璃助手（`POST /api/assistant/chat` + 工具调用读写当前邮箱日程/待办/邮件），支持 Web Speech 语音输入；年视图改为四列月卡、日程以色点展示；日程弹窗可打开关联来源/变更邮件原文。`npm run build` 通过。真实问答需已配置模型。

**同日修复与扩展：** 修复 `/app/mail` 的 `shanghaiDate` 未导入崩溃；年视图改用 FullCalendar React v7 的 `singleMonthMinWidth`（旧 `multiMonthMinWidth` 无效导致单列）；设置新增「分类」「过滤」：自定义日历类别（解析时注入模型）与规则引擎过滤垃圾/免打扰邮件（含域名/通配符/正则）。过滤规则单测通过。

**同日继续：** 去掉年视图；周/日视图改为 studio-admin 风格实心色块；登录用户模型/小 D/分类/过滤写入 `userPrefs`（按账号隔离）；日历侧栏可管理分类；日程弹窗强化关联邮件（含反查）并可打开原文；工作区全局右键菜单；持久化说明对齐 JSON + 可选云组件。用量：Token 取自接口 usage，费用仍按单价估算（对本 demo 足够）。

**同日收尾：** 开启 `requireAuth` 前必须已登录，避免配置自锁；自动同步经本地消息队列抽象投递；邮件详情大屏左右分栏（正文 / 完整元数据）。带现有 data（8/6/3）与注册门禁冒烟通过。

**V1.0.0 已完成初步目标，并由用户提交到 Git。** 基础日历、示例邀请和真实 QQ 邮箱 + DeepSeek 的邀请提取此前已跑通。用户手动发送真实测试邮件并确认成功生成日程。

已完成的完整流程：**真实邮件进入 QQ 收件箱 → 手动同步 → IMAP 读取 → DeepSeek 提取 → 日程保存并展示在日历中**。

### V1.0.0 版本基线

| 项目 | 记录 |
| --- | --- |
| 版本里程碑 | V1.0.0，本地邮箱日历 demo 首个可用版本 |
| Git 提交 | `20333fd894df91017b34ed8bed20483740e369bb`（简称 `20333fd`） |
| 提交说明 | `Initial commit && V1.0.0` |
| 提交时间 | 2026-10-12 14:51:22（北京时间） |
| 真实联调依据 | 用户明确确认手动发送真实邮件并验证成功；本地存在对应真实邮件导入记录和日程 |

V1.0.0 指上述 Git 提交里程碑。记录时尚无 Git tag，`package.json`、锁文件及 IMAP 客户端版本字段仍为 `0.1.0`。本次更新进展文档，以该提交作为后续开发基线。

本次核对的实际目录为 `E:\AAAproject\UCloud2609\Daylight`；之前使用过 `MailFlow` 名称。README 和临时迁移验证脚本已指向 Daylight。

V1.0.0 文档核对时的本地数据快照（非本次新增功能的测试结果）：

| 项目 | 当前状态 |
| --- | --- |
| 已保存日程 | 4 项，其中 1 项来自真实邮件 |
| 已处理邮件 | 6 封：4 封示例邮件、2 封真实 QQ 邮件 |
| 真实 QQ 邮件处理结果 | 1 封导入并生成 1 项日程，1 封标记为无日程并跳过 |
| 邮箱地址及 IMAP 授权码 | 已配置，QQ 邮箱真实读取已验证 |
| 当前模型 URL / 名称 | `https://api.deepseek.com` / `deepseek-flash` |
| 模型 API Key | 已配置，真实调用已验证；文档不记录密钥 |
| 当前读取数量 | 最近 10 封（程序初始默认值为 15 封） |

这些数字是 V1.0.0 核对时的快照，使用后会变化。以上实连结论依据当时的用户确认和本地处理记录；该次 V1.0.0 文档核对未再次读取 QQ 邮箱或调用真实模型，也未修改 `data/` 中的日程和设置。单封真实测试证明基础邀请流程可用，取消/调整及复杂格式仍需实连复验。

## 2. 已实现能力

### 日历和手动日程

- 月日历、月份切换、今天定位、日期选择、当日安排和当月日程列表。
- 新增、编辑、删除日程；标题、起止日期和时间、全天、分类、地点、备注。
- 保留已取消/已调整的原日程，显示删除线、状态、原因、变更邮件与更新时间；原取消记录只读，可以删除。
- 调整后的新日程标注「调整后」，原/新日程可互相跳转；本月、当日及分类的有效安排统计排除取消记录。
- 展示跨天日程；全天日程的存储结束时间为最后一天的次日零点。
- 按工作/生活筛选；搜索标题、地点、备注及来源邮件主题。
- 「我的日历」的「工作、生活，还有留给自己的时间。」旁新增「同步真实邮箱」，复用邮件助手真实同步入口，信封和箭头使用相同图标；配置不完整时打开设置，同步中禁用。
- 浅色页面和窄屏布局保留；本次变更的页面检查见第 5 节。

### 邮件 agent

- 选择 QQ、163、126、Gmail、Outlook、iCloud 或自定义 IMAP/SMTP；保存多个邮箱并在侧栏/设置中切换。新增/切换邮箱时立即后台读取该邮箱最近 1–50 封，默认 15 封；已处理邮件去重，失败邮件仍可重试。
- Node 服务每 60 秒读取当前邮箱与共用模型配置，完整时自动同步；也支持手动同步。后台只处理当前邮箱，停止服务后停止自动同步。
- 各邮箱独立保存服务器、客户端凭据和读取数量；日程、待办、完成状态、邮件、去重、冲突、草稿、日志、费用和最近同步时间隔离。模型 URL、API Key、模型名与计价配置共用；模型上下文只含当前邮箱数据。
- 自动与手动同步共用同步锁，已有同步正在运行时跳过本轮自动同步。成功/跳过或已有冲突草稿的邮件继续按 ID 去重，失败邮件仍在最近 N 封内时可在后续周期重试。
- 先获取最近 N 封的 UID 和内部日期，完整消费元数据请求后，仅按未处理 UID 获取源数据；成功、跳过或冲突邮件不下载原文、不重新解析、不新增日志或模型请求。重复占位只用于保持 `total` / `duplicate` 统计；默认 ID 前缀及 UIDVALIDITY 规则不变。连接、打开 INBOX 或读取失败时释放已有锁并立即关闭连接；正常结束时登出。
- 取消/调整的目标缺失、不唯一或无效这两类匹配错误，在 trace 保存 `match_retry` 与上下文摘要。当前有效真实/手动日程、已有非示例任务、模型接口/名称及提取规则版本未变时，自动和邮箱切换同步不重复调用模型、不新增尝试；手动同步仍可重试。上下文变化后恢复自动提取。网络、服务商、响应格式、时间及其他处理错误继续重试，仍受最近 N 封范围限制。
- 页面定期读取状态以展示后台导入，处理期间继续快速刷新日志和日历；自动同步有新处理结果或新失败时提示。已暂缓的匹配错误仍保留为失败，展示待匹配说明，不反复弹出自动提示。页面关闭后，只要 Node 服务仍运行，自动同步继续；服务停止则停止。
- 通过配置的 IMAP 服务器读取 INBOX；QQ 默认 `imap.qq.com:993`。直接 TLS 或 STARTTLS 均使用加密连接，以邮箱地址和客户端凭据登录。
- 用户点击「采纳并发送」后，使用当前邮箱的 SMTP 服务器、邮箱地址和客户端凭据回信；QQ 默认 `smtp.qq.com:465`，发信保留系统 DNS 与 TLS 域名校验。发送已有草稿无需模型配置。保存配置不表示连接成功。
- 解析邮件主题、发件人、日期、正文；正文优先使用纯文本，否则使用去标签的 HTML。
- 对每封本轮需要提取的普通正文邮件调用一次 OpenAI 兼容 Chat Completions 接口，使用 JSON object 输出；PDF 简历按附件提取，招聘对话可能调用多次模型。已处理和暂缓匹配的邮件不重复调用。
- 官方 `api.deepseek.com` 的 `deepseek-flash` / `deepseek-v4-pro` 请求增加 `thinking: { type: 'disabled' }`；其他模型和兼容接口保留通用请求。单次模型请求及响应正文读取最多等待 60 秒，超时保留错误并继续处理其他邮件；整批同步仍有邮箱和各封提取的累计开销。
- 解析零个、一个或多个日程；保存标题、起止时间、全天、分类、地点、备注。
- 模型输入增加当前有效的非示例日程摘要与来源信息，输出 `create` / `cancel` / `reschedule`；取消/调整使用 `targetEventId` 选择原安排。
- 取消原日程并保存取消通知；调整原安排后创建替代日程，仅变化的字段更新，其余继承。只改地点也走取消原安排、新建最新安排的流程。
- 真实模型提取规则版本为 `mail-calendar-tasks-v3`：能唯一确认同一活动且通知涉及的时间、地点和其他变化已与当前最新安排一致时，返回空操作并保留摘要，不重复调整或创建。没有相关原安排或最新安排时，完整调整通知可直接创建明确的最新活动并说明来源；纯取消通知保留摘要、不修改其他安排。有疑似对象却不能唯一匹配、或调整信息不足时仍失败，不猜目标、不部分写入。这些规则依赖模型判断，普通新邀请仍按邮件分别提取。
- 按邮件 `receivedAt` 从早到晚处理，同一时间保持输入顺序；每封提取使用当前有效候选，支持同批邀请、连续调整和取消。
- 取消/调整目标缺失、已取消、不唯一，或新时间无效时整封报错，不产生部分修改；保留再次同步重试能力。
- 按邮件 ID 跳过已处理邮件；真实邮件 ID 包含邮箱地址、UIDVALIDITY 和 UID。原默认邮箱保留 `qq:` 前缀，新邮箱使用 `imap:` 前缀；更改同一邮箱的服务商预设不改变 ID，不会重复提取。
- 单封模型失败后继续处理其他邮件，返回该邮件错误；失败邮件可在再次同步时重试。
- 提取成功后新邀请和改期安排全部写入日历；有重叠时邮件保存为 `conflict`，日程增加 `hasConflict` / `conflictEventIds`，保留回复草稿与候选。待办仍正常保存；无日程和待办操作的邮件为 `skipped`，保留分类和摘要。
- 邮件助手展示处理记录、正文、中文处理摘要、创建/取消/调整关联的日程；展示当前这次同步的错误。
- 点击「邮件处理记录」打开左右分栏的「邮件详情」：左侧显示原文和现有处理结果，右侧显示主题、发件人、邮件及处理时间、来源、内容摘要与日程操作。
- 普通正文邮件的真实模型在同一次请求中返回内容摘要与日程操作。每项操作保存名称、起止时间、全天、分类、地点、关键事项；取消保存原安排及原因，调整保存继承未变字段后的新安排、原因与原/新日程关联。
- 新邮件保存独立提取快照，日程后续编辑或删除不会改变当时字段。无日程邮件也保留摘要；右侧提供关联日程跳转，窄屏改为上下排列。
- 旧邮件没有快照时使用当前关联日程字段并明确标注，不迁移、不重新调用模型，旧邮件去重行为保持不变。

### 日程冲突与回复确认

- 本地比较实际起止时间，使用半开区间：前项结束等于后项开始不算冲突。有效真实/手动日程参与真实邮件检测，示例只比较示例日程；旧数据无 `status` 仍有效，取消记录不占时间。标记 `allDay: true` 的全天活动（含跨多天）不参与冲突检测，新建和调整为全天均正常写入，也不阻挡其他活动及候选时段；未标记全天的跨天安排仍检测重叠。
- 有冲突的新邀请直接写入；有冲突的调整仍取消原安排并创建、关联替代日程。按本封邮件应用全部操作后的有效日历检测冲突，同封互相重叠的安排均标识；取消/调整释放旧时段。同批按时间从早到晚处理，后续邀请会看到前面已写入的安排，冲突日程仍占用时间。
- 模型提取返回后重新读取当前本地日历，包含模型等待期间的手动修改。冲突检测和候选生成直接在现有 `importEmail` / `processEmails` 中完成，没有额外模型调用、排程服务或配置。
- 自动生成中文回复草稿，说明邀请或拟调整的名称/时间、冲突日程的名称/时间/地点，再提供 3 个同样时长的可行候选。普通活动按北京时间每天 09:00–18:00、半小时刻度逐日找空档，包含周末；超过 9 小时的非全天长活动保留原开始钟点逐日找。已保存的全天活动不占用候选时段，全天新安排直接写入，无需冲突回复。
- 候选从原请求与当前时刻的较晚者开始，避开当前有效安排，3 段彼此不重叠。继续搜索到已有占用之后，前几天忙满时仍找到真实空档；不代表对方可用，不自动预订。候选是处理时快照，日历变化后不自动刷新旧建议。
- 月视图、日程列表、当日安排和日程详情标识当前重叠的有效日程；日历和邮件助手保留冲突卡片及状态提示，邮件详情展示已创建安排、冲突快照、3 个建议和回复草稿入口。真实邮件可采纳并发送、修改后发送或拒绝，反馈和发送状态刷新后保留；发送不写入建议日程，示例仅保存反馈。
- 冲突邮件完成分析后按邮件 ID 去重，不计为处理失败、不反复提取。达成新安排可手动编辑，或通过新的邀请/改期邮件导入。历史邮件不补做冲突检测；此前版本暂缓入历的冲突记录不自动补建，界面保留其历史状态。候选和草稿保留处理时快照。

### 示例与持久化

- 4 封示例邮件使用预置提取结果：3 项日程、1 封跳过。
- 「演示取消与调整」追加 2 封预置通知：取消咖啡见面，取消设计评审原安排并新建后天 10:00–11:30、创意园 A 栋 302 的评审。
- 「演示日程冲突」独立导入 2 封预置邀请：明天 09:00–10:00 的项目进度沟通和 09:30–10:30 的新功能讨论均入历，重叠时标识并生成含 3 个候选的草稿。不要求先导入其他示例，不连接真实邮箱或模型。
- 示例变更只匹配示例日程；真实同步只匹配真实/手动日程；清除示例保留用户实际日程及配置。
- 固定示例邮件 ID 防止重复导入；“清除示例数据”后可以重新导入。
- 原默认邮箱继续使用 `data/calendar.json` / `data/traces.json`；新增邮箱分别使用 `data/mailboxes/<邮箱 ID>/calendar.json` / `traces.json`，首次从空日程和待办开始。原数据无需搬迁或清空，示例清理仅影响当前邮箱。
- `data/settings.json` 保存邮箱列表、当前邮箱和共用模型设置；页面不取得客户端凭据或 API Key 原值。编辑同一地址时密钥留空保留原值，变成新地址时创建/激活独立邮箱并要求其自己的凭据；原地址仍可切回。
- 同步和发送捕获邮箱 ID；同步/发送期间切换返回 409，完成后可切换，避免中途更换账户。草稿、发送反馈和 trace 持久化都绑定所属邮箱。

### 邮件标签与待办

- 普通正文邮件同次模型请求返回内容摘要、唯一分类和优先级：分类为 `meeting` / `task` / `notice` / `inquiry` / `invoice` / `promo` / `resume`；今天/明天需行动为 `high`，仅知晓为 `low`，其余 `normal`。PDF 简历完成附件提取后保存 `resume` 分类，不创建日程或待办。
- 在已有日程操作协议旁追加 `tasks`，提取任务标题、说明、截止时间和邮件中的截止原话。报告交付、需回复的问题、报销等行动写入本地清单；仅知晓和推广邮件不生成任务。
- 相对截止日参考邮件的北京时间日期；本周/下周的星期、今天/明天/后天和常见明确日期可在本地校正，日期缺时间默认为 18:00；无截止日保留空值。周五前即邮件所在周周五 18:00，不偷偷顺延已过的期限。
- 模型接收当前邮箱已有同来源任务（含已完成）以匹配同一事项；同时按规范化标题和截止时间合并明确重复项。任务保留所有来源邮件及 `/?mailbox=<邮箱ID>&email=<邮件ID>` 本地详情链接，打开时切换邮箱并定位原文；旧 `/?email=<id>` 链接仍定位当前邮箱。完成状态不会被提醒邮件重置。
- 日历旁「待办」按优先级、截止时间排序，展示原话、说明、预置示例标记和过期提示；支持勾选完成、展开已完成、撤销完成、打开来源原文。邮件详情展示当时提取的任务快照和当前关联任务。
- 待办保存在 `calendar.json` 的 `tasks` 数组中。旧 JSON 读取时返回空数组，不主动迁移或清空旧日程、配置、邮件。旧模型格式继续可用；历史已处理邮件不补 Tag，不重新请求模型。
- 独立「演示标签与待办」导入 6 封预置邮件、3 条任务，报告有两封来源；meeting 分类可在原日程邀请示例中查看。所有示例均明确标为预置，不调用真实模型。

### 可观测日志与回复草稿

- 一封邮件一条 trace，按邮件 ID 的摘要关联；重试追加 attempt，保留之前的阶段、错误、用量和费用。已成功处理/跳过邮件的重复同步不创建新尝试。
- 实际记录 `receive_email`、`parse`、`check_calendar`、`extract`、`create_task`、`draft_reply`：开始/结束时间、耗时、输入/输出短快照、工具名/参数/返回摘要及简短决策说明。
- 真实 IMAP 路径记录消息获取等待与 mailparser 解析耗时；连接和批量读取耗时属于同步共享开销，不伪装成每封邮件独立耗时。示例明确使用预置输入和预置提取，Token/费用为零。
- 真实模型记录返回的 prompt/completion Token，支持 OpenAI 和 DeepSeek 缓存命中字段。按输入/输出/缓存输入人民币单价计算费用，每次调用保存计价快照；失败返回已知 usage 时仍计入成本。
- 真实邮件单独汇总，重试费用累加且邮件数不增加；未知用量/未填单价不按零计费。完整平均费用与已计价样本平均费用区分展示。
- 当前邮箱对应的 `traces.json` 独立保存日志，不迁移旧日程与旧邮件。日志脱敏邮箱、手机号、配置密钥、常见鉴权格式和链接中的凭据/查询参数，限制文本与数组快照长度；不保存鉴权 headers 或模型私有推理。
- 日历下方与邮件助手展示同一日志面板：同步期间轮询刷新日志和日历，正在运行的阶段即时可见。每封处理完就保存日历，保留同步期间的手动编辑。
- 展示时间轴甘特条、累计耗时/Token/估算成本、可播放或逐步前进的回放，阶段内折叠展示 Thought（应用决策摘要）/Action/Observation，以及输入/输出和工具调用。
- 根据已保存的处理结果本地生成回复草稿，无额外模型请求；用户采纳/修改/拒绝和修改后的草稿单独记录。冲突草稿列出已有安排和 3 个候选；邮件记录保存完整原稿与修改稿原文，编辑器展示准备发送的正文，普通联系方式和链接查询参数保持原文。Trace 的草稿证据完整保留并脱敏，其他日志快照仍截断。草稿操作不撤销已生成日程、不创建候选。
- 真实邮件点击「采纳并发送」即通过当前邮箱的 SMTP 配置回信，正文优先使用邮件记录的 `userDraft`，兼容旧 trace 的 `user_draft`；无修改稿时使用邮件记录的 `draftReply`，缺失则回退到 trace 的 `draft_reply`。编辑后先保存修改稿，再点击发送。旧修改稿已被脱敏的内容无法恢复，可重新编辑补全。收件人取原邮件 `Reply-To` 的第一个有效邮箱地址，没有有效地址则回复 `From`；页面明确仅回复该地址，不执行「回复全部」。主题使用 `Re:`，新邮件的 `Message-ID` / `References` 用于关联原邮件。历史邮件缺少头信息时仍可使用已保存的发件人地址发送，旧版本的 accepted 反馈不算已发送。
- 发送结果持久化为 `reply_delivery`：成功展示发送时间并禁用编辑和再次发送；失败记录脱敏错误、保留草稿以便重试。已有成功发送状态不会重复发信，自动同步中的日志更新也保留发送状态。拒绝或预置示例不会发信，自动同步只生成草稿。
- 邮件详情可定位相应日志；上线前已处理邮件没有执行证据时明确提示，不补造时间和用量，也不绕过去重重新提取。

## 3. 代码入口

| 文件 | 职责及后续修改位置 |
| --- | --- |
| `src/App.jsx` | React Router 入口：总览 / 日历 / 邮件 / 执行日志 / 设置 |
| `src/pages/*` | 各页面（Overview 为默认首页，页面变短、演示入口收入下拉菜单） |
| `src/components/ui/*` | shadcn/ui 组件（Button、Card、Dialog、Sheet 等） |
| `src/components/app-shell.jsx` | 侧栏与顶栏布局 |
| `src/context/workspace.jsx` | 状态、同步、邮箱切换与 API |
| `src/index.css` | Tailwind + shadcn 主题变量（不再使用手写 `styles.css`） |
| `src/main.jsx` / `index.html` | React 挂载和页面入口 |
| `server/index.js` | Express API、草稿发送与结果保存、示例/真实同步入口、每分钟真实同步与共用同步锁、同步状态、合并变更以保留同步期间的手动编辑、开发/构建模式启动 |
| `server/sync.test.js` | 自动/API 同步验证：周期、配置检查、共用锁、去重、失败重试、匹配错误暂缓与恢复、冲突草稿反馈及模型等待期间的手动新增；独立数据与模拟 IMAP/模型 |
| `server/agent.js` | `readMailboxEmails` / `sendMailboxReply` 使用当前邮箱 IMAP/SMTP，保留 QQ 函数别名兼容；`extractEvents` 带当前邮箱有效日程和任务上下文调用模型；`importEmail` 应用新增/取消/调整并标记冲突；`processEmails` 顺序处理、去重和汇总 |
| `server/conflicts.js` / `server/conflicts.test.js` | 时间重叠检测、3 个同样时长的空闲候选及 8 项时间边界/全天/跨天/冲突安排占时验证 |
| `server/email-conflicts.test.js` | 邮件冲突业务验证：冲突入历及标记、候选/草稿、同封最终安排、交换时段、冲突改期/取消、全天免冲突、去重、快照、来源、并发编辑及一次本地模型调用 |
| `server/tasks.js` | 邮件标签枚举、截止日期推断、任务优先级与标题规范化 |
| `server/tasks.test.js` | 标签、期限、任务合并、来源、旧数据兼容及本地模型请求验证 |
| `server/store.js` | 邮箱预设、旧设置兼容、当前邮箱配置、按邮箱目录读写 JSON、默认示例、去除密钥原值的公开设置 |
| `server/traces.js` | 脱敏日志、trace/span/attempt 生命周期、Token 与费用计算、汇总、日志 JSON 保存 |
| `src/TracePanel.jsx` | 动态日志面板、甘特时间轴、步骤回放、草稿编辑与反馈、真实回信发送与状态 |
| `server/fixtures.js` | `exampleEmails` 邀请、`exampleChanges` 取消/调整、`exampleTasks` 标签/待办及 `exampleConflicts` 冲突预置示例 |
| `server/agent.test.js` | 20 项日程、取消调整、摘要与快照回归，内存数据和本地 HTTP 模拟模型 |
| `server/traces.test.js` | 9 项可观测业务验证：动态阶段、回放草稿、重试累计、费用未知与脱敏 |
| `server/reply.test.js` | 11 项系统 DNS / QQ TLS、回复地址/主题/关联头、实际 MIME 编码、草稿原文发送、API、去重、失败重试及旧记录兼容的本地验证 |
| `server/mailboxes.test.js` | 4 项多邮箱验证：旧数据读取不改写、日程/待办/草稿/去重隔离、各邮箱凭据与服务器、切换读取数量、同步/SMTP 等待期间切换及过期请求 409 |
| `server/mailbox-read.test.js` | UID 元数据去重、仅未处理邮件获取原文、默认前缀与 UIDVALIDITY、发送时间顺序、失败重试和连接清理的合成验证 |
| `server/model-request.test.js` | 官方 DeepSeek 非思考参数、通用接口兼容、v3 变更通知规则、响应正文等待超时和重试的本地验证 |
| `server/matching-retry.test.js` | 匹配失败不部分写入、相同上下文自动/切换暂缓、手动重试、日程/任务/模型变化恢复与服务故障照常重试 |
| `work/` | 临时验证脚本和运行日志，不属于正式应用代码 |

React + Vite 前端由同一个 Express 进程提供；模型调用发生在后端。数据默认保存在项目根目录的 `data/`。

## 4. API 和数据约定

| 方法和路径 | 行为 |
| --- | --- |
| `GET /api/state` | 日程、待办、邮件记录、最近同步时间、去除密钥原值的配置 |
| `GET /api/traces` | 已保存 trace、真实/示例分别汇总的计量、当前同步进度 |
| `PUT /api/traces/:id/feedback` | 保存 `action`（accepted/modified/rejected），修改时附 `draft`；邮件 `userDraft` 保存发送原文，trace `user_draft` 保存脱敏证据，原草稿保持独立 |
| `POST /api/traces/:id/send` | 根据当前邮箱 trace 和原邮件，通过该邮箱 SMTP 发送回信；使用已保存修改稿或原稿，记录 `reply_delivery`，成功记录不再发送 |
| `POST /api/events` | 新增手动日程 |
| `PUT /api/events/:id` | 编辑日程 |
| `DELETE /api/events/:id` | 删除日程 |
| `PUT /api/tasks/:id` | 保存 `status: pending/done`，完成时写 `completedAt`，撤销时清空 |
| `PUT /api/settings` | 保存当前/指定邮箱与共用模型配置；新地址创建或匹配独立邮箱，当前邮箱 ID 变化且配置完整时立即后台同步，返回公开设置及 `syncStarted`；拒绝清空已配置邮箱地址 |
| `POST /api/mailboxes/:id/activate` | 切换邮箱，恢复对应数据，并立即读取设定数量邮件（配置完整时）；同步/发信中返回 409 |
| `POST /api/sync/demo` | 导入示例邮件 |
| `POST /api/sync/demo-changes` | 导入示例取消及调整通知；需先有相关示例日程，响应 `mode` 为 `demo` |
| `POST /api/sync/demo-tasks` | 导入 6 封标签和待办预置示例，不要求先导入日程，响应 `mode` 为 `demo` |
| `POST /api/sync/demo-conflicts` | 独立导入 2 封预置邀请，均入历并标识重叠，保存冲突草稿，响应 `mode` 为 `demo` |
| `POST /api/sync/qq` / `POST /api/sync/mailbox` | 读取当前真实邮箱并调用模型提取；`qq` 为原接口兼容名称 |
| `DELETE /api/demo` | 清除当前邮箱的示例日程、邮件、待办和日志 |

- 日程核心字段：`id`、`title`、`start`、`end`、`allDay`、`category`、`location`、`description`、`source`。
- `source` 为 `manual`、`demo` 或 `email`；来自邮件的日程另有 `emailId`、`emailSubject`、`emailSender`。
- 新日程有 `status: 'active'`；原日程取消后 `status: 'cancelled'`，加 `cancellationType`（`cancel`/`reschedule`）、`cancelReason`、`cancelledAt`、`cancelledByEmailId`、`changeEmailId`/`changeEmailSubject`/`changeEmailSender`。取消保留原标题、时间地点及原来源。
- 调整在原日程添加 `replacementEventId`，新日程添加 `previousEventId` 并使用调整通知作为来源。旧数据未设置 `status` 时仍视为有效。
- 已处理邮件保存正文、`mode`（`demo`/`qq`）、`eventIds`、`status`（`imported`/`skipped`/`conflict`）和处理时间。新增 `createdEventIds`、`cancelledEventIds`（纯取消原安排）、`rescheduledEventIds`（被调整原安排）、`affectedEventIds`（取消及调整原安排的合集）和中文 `summary`；`eventIds` 包含相关原/新日程，旧记录仍可展示。
- 新读取的真实邮件另保存 `senderAddress`、`replyTo`（显示地址文本）、`messageId`、`references`（mailparser 原值），用于真实回信。邮件及草稿存于所属邮箱的数据文件。旧邮件缺少字段时可回退到 `sender`，不补读历史邮件头、不迁移数据。真实邮件的 `mode: 'qq'` 保留为兼容值，界面显示「真实邮箱」来源。
- 新记录另有 `extraction: { summary, actions }`：`summary` 为邮件内容摘要，区别于记录顶层的处理计数摘要；`actions` 为完整日程字段快照，带显式 `action`。新增附 `eventId`，取消附 `targetEventId`/`reason`，调整附 `targetEventId`/`reason`/`eventId`。快照独立于当前日程，包含跳过记录的空操作数组。
- 同步响应包含 `added`、`cancelled`、`rescheduled`、`tasksAdded`、`tasksMerged`、`conflicts`、`skipped`、`duplicate`、`deferred`、`errors`、`total`、`mode`。`added` 包含冲突及调整后新日程数，`conflicts` 为本次有冲突的操作数，仍计入已创建安排；`tasksMerged` 为关联已有任务的次数，`skipped` 为无日程和待办操作。`deferred` 为本轮上下文未变而暂缓模型重试的匹配失败邮件数，对应错误附 `deferred: true`；它不是去重或成功记录，不写入 `store.emails`。同步 `processed` 排除 duplicate 和 deferred。
- 邮件 `conflicts` 保存 `{ actionIndex, action, eventId, event, targetEventId?, existingEvents, suggestedSlots }`：`event` 为新建/新调整字段，`existingEvents` 为处理时的冲突对象快照，`suggestedSlots` 为 3 个 `{ start, end, allDay }`。`extraction.actions` 附 `outcome: 'conflict'` 并保留创建的 `eventId`，日程仍为 `status: 'active'`，增加 `hasConflict: true` 与 `conflictEventIds`。旧暂缓记录可能无 `eventId`，不会自动补建。
- Trace 支持 `status: 'conflict'`，表示分析已完成、草稿待确认；计入已完成处理数量和实际模型用量。证据快照保持短文本截断，`draft_reply` / `user_draft` 经相同脱敏后完整保留，避免丢掉候选时段。邮件记录的 `draftReply` / `userDraft` 独立保存发送正文原文，页面展示和发送以原文为准。
- `GET /api/traces` 的 `sync` 为当前邮箱最近一次同步状态；`id` 区分批次，`trigger` 为 `manual`、`auto` 或 `mailbox-switch`。结束时保存 `result` 或失败 `error`，供页面展示后台结果；该状态保存在服务内存，重启后重新开始。
- 页面请求携带 `X-Mailbox-Id`，邮箱切换后旧页面对日程、待办、日志、草稿或同步的请求返回 409，不跨邮箱操作。切换时清掉页面旧状态和弹窗，忽略迟到响应，重新读取新邮箱的数据。
- 模型输出 `{ summary, category, priority, events, tasks }`；兼容旧 `{ summary, events }` / `{ events }`，旧结果不补标签，摘要缺失时保持为空。省略日程 `action` 时按创建兼容；取消/调整要求唯一 `targetEventId`，调整可只提供变化字段。合并后的起止时间需有效。内部提取器仍兼容原数组输入。
- 模型请求为 `POST <Base URL>/chat/completions`，使用 Bearer Key、`model`、`messages` 和 `response_format: { type: 'json_object' }`；已有完整路径时直接使用。官方 `api.deepseek.com` 的 `deepseek-flash` / `deepseek-v4-pro` 另发送 `thinking: { type: 'disabled' }`；请求及完整响应正文等待上限 60 秒。提取规则版本为 `mail-calendar-tasks-v3`，保存在模型调用证据中。
- Trace 的 `match_retry: { context_key, message }` 仅用于已失败的取消/调整目标匹配。`context_key` 是当前模型可见日程/任务字段与模型接口、名称、提取规则版本的 SHA-256；不含密钥，`lastSync`、历史日志和已取消/示例事项不参与真实匹配摘要。相同上下文的自动/切换同步保留旧失败及尝试次数，手动同步或上下文改变时恢复提取，并清除旧标记；后续服务故障不会继承匹配暂停。
- 环境变量：`PORT` 修改监听端口；`DAYLIGHT_DATA_DIR` 修改 JSON 保存目录。模型和邮箱配置从 JSON 文件读取。
- 配置追加可选的 `tokenPriceIn` / `tokenPriceOut` / `tokenPriceCachedIn`，单位元/百万 Token，留空为 null。旧配置读取时返回空单价，不改写原文件；保存旧配置的其他字段时保留单价。
- 新处理邮件追加 `trace_id` 和本地回复草稿 `draftReply`；修改草稿时，在 `calendar.json` 的邮件记录追加 `userDraft` 原文。Trace 保存 `email_ref` 摘要、`attempts`、`spans`、`decision`、`draft_reply`、`user_action` / `user_draft`，以及累计 Token、已知费用和完整费用；所有可观测快照经统一脱敏。发送正文依次取 `email.userDraft ?? trace.user_draft ?? email.draftReply ?? trace.draft_reply`，旧记录缺失原文时保留兼容，重新编辑可保存完整修改稿。
- 发信状态仅保存在 trace 的 `reply_delivery` 中：`status: 'sent'` 带 `sent_at` / `message_id`，`status: 'failed'` 带 `attempted_at` / `error`（脱敏）。成功保存采纳反馈；accepted 反馈本身不代表已发信。发送时同步更新当前 recorder，避免正在运行的自动同步覆盖结果。
- 新协议追加顶层 `category` / `priority` / `tags`（分类与优先级），以及 `taskIds` / `createdTaskIds` / `mergedTaskIds`；`extraction` 保留标签和任务快照。原顶层 `summary` 仍是处理数量摘要，`extraction.summary` 是邮件内容摘要。
- 待办核心字段为 `id`、`title`、`description`、`dueAt`（北京时间 ISO 或 null）、`deadlineText`、`priority`、`status`（pending/done）、`source`（demo/email）、`createdAt`、`completedAt`。`sources` 每项含 `emailId`、`emailSubject`、`emailSender`、`emailUrl`。
- 模型 `tasks` 每项含 `title`、`description`、`dueAt`、`deadlineText`；匹配已有任务时返回 `existingTaskId`，合并来源和最新事项描述，不重置完成状态。demo/真实任务隔离；本地邮件链接查看已保存原文，不依赖服务商网页邮件链接。

## 5. 验证记录

### 同步耗时与变更邮件处理优化（2026-10-14）

- 最终集成 `npm test`：**124/124 通过**，原 98 项回归加 26 项验证；`npm run build` 和 `git diff --check`：通过。未新增依赖，继续使用现有 Node IMAP、fetch 与 JSON 文件入口；没有并行模型请求，批次仍按邮件时间处理。
- 新增合成验证覆盖：元数据和 UID 原文请求分开且不嵌套、只下载未处理邮件、全部重复不新增日志/模型请求、UIDVALIDITY 和旧前缀兼容、失败重试及连接/选箱/读取清理；官方 DeepSeek 参数与通用接口、v3 提示规则及业务输出、模糊目标不部分写入、响应正文超时；相同上下文的自动/切换暂缓、手动重试、日程/任务/模型变化恢复、邮箱隔离和服务故障照常重试。数据为专门编写的合成邮件，测试使用内存或独立 `work/` 数据目录。
- 合成下载量验证：最近 15 封均已处理、每封约 64 KiB 时，旧路径每轮下载超过 960 KiB 源数据，新路径正文下载为 0，只取 UID 和日期；混合批次仅取未处理 UID。该数字说明已处理邮件免下载的行为，不代表真实网络提速比例。
- **原失败邮件当前已成功**：诊断期间旧服务仍在自动运行，2026-10-14 14:34（北京时间）第 16 次自动重试自行成功，使用原 v2 提取规则，保存 2 项 create，模型阶段约 20.375 秒。没有手工补写其结果或清除 trace，历史失败仍保留。这次成功发生在新服务重启之前，不能记为 v3 修复后导入。
- **当前邮箱真实 IMAP 同步测量**：旧服务最近 20 封全部 duplicate、没有新模型提取的一批总耗时 42,982 ms，批量读取 42,945 ms；另一批总耗时 40,641 ms。新服务重启生效后，同一设置下两次最近 20 封全重复同步分别为 645 ms（读取 608 ms）和 1,424 ms（读取 1,392 ms）；均无错误、无新模型请求，当前失败 trace 数为 0。材料：`work/sync-performance-live-before.json`、`work/sync-performance-live-after.json`。这几批均为已有邮件去重，首次新邮件仍需下载和模型提取，不能保证固定秒数。
- **官方 DeepSeek 真实模型内存复验**：对原失败且现已保存的邮件进行一次 v3 `extractEvents`，明确关闭思考模式，HTTP 200 / `finish_reason: stop`，约 1,703 ms；服务商返回 7,138 输入 Token、100 输出 Token，`events: []` / `tasks: []`，确认已有最新安排时不重复创建。这次结果只在内存核对，不重新导入、不持久化模型结果，日历和邮件数量不变。相比旧 v2 的 20.375 秒是两次不同调用的实测，不能视为严格同请求性能基准；其他 v3 变更分支和匹配暂缓分支主要由合成测试覆盖。
- 数据保留核对：`data/settings.json` SHA-256 不变；除当前邮箱的 calendar/traces 因旧服务真实自动处理成功及新邮件更新外，其他 data JSON 哈希均相同。重启后的两次全重复同步只更新 `lastSync`；当前邮箱保留 19 项日程、7 条待办、32 封邮件和 32 条 trace，失败 0 条。新版模型内存复验未写任何 data 文件。业务数据核对材料为 `work/sync-performance-preservation.json`，没有清空或迁移用户数据。
- 当前本机 Node 服务已重启使用新版，刷新页面即可；后续更新后仍需重启相应运行服务。此次测量连接真实当前邮箱和官方 DeepSeek，没有发送回信；文档及测量材料不记录真实账号、邮件正文/主题或密钥。历史其他邮箱、SMTP 和页面合成验证范围保留在下文。

### 多邮箱隔离与冲突入历（2026-10-14）

- 最终集成 `npm test`：**98/98 通过**（约 19.7 秒）。原 91 项回归加 4 项多邮箱和 3 项冲突入历验证；新增用例覆盖已标识冲突的有效安排占用时段、同封操作后的最终日历，以及冲突调整取消原安排并关联新安排。既有冲突用例按新入历行为更新。
- 多邮箱测试运行实际 Express API，IMAP/模型/SMTP 使用合成响应，数据存于独立 `work/` 目录。覆盖旧单邮箱配置和旧日历读取不改写、同 UID/Message-ID 与同名待办按邮箱独立处理、每个邮箱的读取数量和去重、手动/取消日程及草稿保留、独立凭据和服务器、同步/SMTP 等待期间拒绝切换、过期页面请求 409、对应邮箱发送与反馈持久化。
- 审核后修复并完成 4 项多邮箱专项复验：同邮箱改服务商预设时 ID 前缀保持稳定，避免重复提取；拒绝清空已配置地址，避免新地址复用原数据；前端切换时立即清空旧状态，迟到的草稿反馈不再写入新邮箱或访问空状态。
- `npm run build`：通过（Vite 7.3.7）；`git diff --check`：通过。没有新增依赖，继续使用 React、一个 Node 本地服务和 JSON 文件；原默认邮箱的数据保留原位置，新邮箱使用独立目录，旧暂缓的冲突记录不自动补入日历。
- 页面实点使用真实 Express API 和构建前端，独立端口 3118、数据目录 `work/multi-mailbox-ui-data`，IMAP/模型/SMTP 全部为合成 mock。QQ 读取 3 封、163 读取 4 封，各新增 2 条重叠日程和 1 条待办；确认切换立即收信、再次读取去重、模型上下文按邮箱隔离、待办完成状态隔离及刷新保留。
- 页面确认冲突详情 → 日程 → 原邮件跳转、3 个候选时段和修改草稿保存；163 的采纳发送走 mock SMTP，成功后禁用重复发送，QQ 草稿保持原内容。`mailbox/email` 链接可自动切换并定位；390×844 窄屏无横向溢出，服务器字段、冲突详情和草稿均可操作；页面 console errors 为空。
- 验证材料：`work/multi-mailbox-ui/verification.json`、`transport-counts.json`、`desktop-calendar.jpg`、`desktop-agenda.jpg`、`mobile-calendar.jpg`、`mobile-settings.jpg`、`mobile-conflict-details.jpg`；临时合成服务脚本为 `work/multi-mailbox-ui-fixture.mjs`。独立 3118 测试服务已停止。
- 所有本轮有写入的验证均设置独立 `DAYLIGHT_DATA_DIR`，未手动改写或清空正式数据；`data/settings.json` 和 `data/traces.json` 哈希与开始一致。原 3000 服务的 `node server/index.js` 进程仍在运行，自动同步继续推进正式 `calendar.json` 的最近同步时间，因此日历整文件哈希发生变化。
- 本轮未主动实连真实邮箱、调用付费模型或发送真实邮件；历史 QQ 邀请提取、SMTP 连接和完整回信送达记录保留在下文。多邮箱新流程、其他服务商连接及新冲突入历流程尚需真实服务复验；合成结果不代表真实服务或模型识别效果。

### SMTP DNS 超时修复（2026-10-13）

- 用户真实点击发送返回 `DNS lookup for smtp.qq.com timed out`。本机复现 Nodemailer 自带 resolver 及 `resolve4` / `resolve6` 查询超时，而系统 `dns.lookup` 约 39 ms 成功；使用系统解析地址连接 465，约 212 ms 收到 QQ SMTP 的 `220` 欢迎响应，TLS 1.3 证书验证通过。诊断只执行 DNS 和 TLS 握手，不发送邮件。
- `sendQQReply` 直接在创建 SMTP transport 前使用系统 `dns.lookup`，连接当次解析地址，并保留 `tls.servername: 'smtp.qq.com'` 和正常证书校验。没有固定 IP、修改系统 DNS、新增依赖或配置。前端直接显示 API 错误，消除“发送失败：回复发送失败：”重复前缀。
- **真实 QQ SMTP 连接及授权码登录验证通过**：使用本机当前保存配置调用 Nodemailer `verify()`，约 503 ms 成功。未发送邮件、未读取收件箱、未调用模型；这不代表完整回信已发送或收件人已收到。设置与 trace 文件哈希、日历除 `lastSync` 外的内容哈希均保持不变。材料：`work/diagnose-smtp-dns.mjs`、`work/smtp-dns-diagnosis.json`、`work/verify-smtp-connection.mjs`、`work/smtp-connection-verification.json`，不含真实账号和密钥。
- `npm test`：**91/91 通过**。原 89 项保留，新增 2 项系统解析失败验证，覆盖不创建 SMTP 连接、API 错误脱敏/修改稿保留/再次解析发送成功；所有自动测试的 DNS 与 SMTP 均模拟。`npm run build` 和 `git diff --check` 通过。12 项合成页面检查仍通过，追加实际 DNS 错误形状的精确断言，立即失败及刷新后均仅出现一次失败前缀，页面运行错误为 0。
- 停止并重启当前 3000 Node 服务的操作被环境自动审批拦截，返回 `blocked by policy`；旧服务未停止。修复需在原启动终端手动重启后生效，现有失败草稿仍可再次发送。

### 本次草稿真实回信（2026-10-13）

- `npm test`：**89/89 通过**。保留原 80 项业务回归，新增 9 项回信验证：QQ SMTP 465/TLS 与共用授权码、Reply-To 首个有效地址及发件人/旧 sender 后备、Re 主题和原线程关联头、实际 Nodemailer MIME 编码后中文长稿完整保留、SMTP 未接受目标时不记成功。
- 实际 Express API / JSON 验证覆盖原稿及修改稿保留普通邮箱/电话/链接参数，trace 证据仍脱敏；已有 accepted 反馈仍可发送、旧修改稿兼容、只需邮箱配置、成功落盘及服务重启后不重发、并发请求与发送期间修改、失败脱敏及重试、示例/缺授权码/空稿不发送。模拟同步继续写日志时，成功和失败发送状态均保留；新读取邮件保存回复地址和线程字段。测试数据位于独立 `work/reply-test-*` 目录。
- `npm run build` 和 `git diff --check`：通过。页面合成检查 **12 项通过**：原稿与修改稿的联系方式/链接参数原样展示和发送、保存不发信、无 body 的发送请求、发送中禁用、失败刷新后重试、成功北京时间与刷新后锁定、旧已采纳记录和无模型配置、Reply-To/来信者提示、示例不发送、设置及 390px 无横向溢出。页面运行错误为 0；桌面和窄屏截图已视觉核对。使用独立静态服务及内存 API 响应，外部网络被阻断。
- 页面验证脚本、结果与截图位于 `work/verify-reply-send-ui.mjs`、`work/reply-send-ui/verification.json`、`desktop-sent.png`、`mobile-sent.png`。现有 `settings.json` 和 `traces.json` SHA-256 均保持不变；`calendar.json` 除 `lastSync` 外的内容哈希保持不变，记录见 `work/reply-data-verification.json`。未操作原 3000 服务；后端发送逻辑需重启本地 Node 服务后生效。
- 测试使用合成邮件、模拟 SMTP 与独立 `work/` 数据目录；不能作为真实 QQ SMTP 实连、最终投递或收件人已读的证据。真实发送由用户在已有草稿上点击触发，待真实邮箱验证。
- 本次声明现有 `nodemailer` 为直接依赖，保持 React + 一个 Node 服务 + 原 JSON 文件；没有新增模型调用或单独 SMTP 配置。

### 全天活动不参与冲突规则（2026-10-13）

- `allDay: true` 的活动（含跨多天）正常新建或调整，不因同日其他安排进入冲突流程；已有全天活动不阻挡定时安排，也不占用推荐时段。规则直接复用现有冲突函数，只增加全天排除判断，日志记录 `exclude_all_day: true`。
- `npm test`：**80/80 通过**。修正原来把全天视为占用的验证，新增 6 项邮件业务验证，覆盖全天邀请与定时/全天安排并存、已有全天不阻挡定时邀请、同封/同批邮件先后顺序、推荐时段忽略全天仍避开定时占用、定时转全天正常关联，以及全天转定时继续检测真实重叠。
- `git diff --check`：通过。本次只改规则、相关测试及文档，未新增演示入口、预置示例、依赖或配置；使用内存合成数据及原有独立 `work/` 测试目录，没有访问真实邮箱/模型或写入用户数据。历史已处理邮件按原去重规则保留；运行中的 Node 服务需重启后使用新规则。

### 本次日程冲突检测与回复确认（2026-10-13）

- `npm test`：**74/74 通过**。保留原 50 项业务回归，新增 7 项时间/候选验证、15 项邮件冲突业务验证、2 项实际 API/自动同步验证。原多日程及失败重试测试里的重复同时间数据改为不同时间，保留其原验证目的，重叠行为由新业务测试覆盖。
- 覆盖相邻边界、已取消/旧状态、北京时间、全天/跨天/长活动、连续忙满 14 天后继续寻找、原时长和互不重叠的 3 个候选；冲突邀请暂缓、改期排除自身/保留原安排、取消及成功调整释放时段、同封和同批顺序、待办仍正常保存、来源隔离、独立快照、去重及一次本地模型调用。
- Worker 验证实际 Express API 和自动同步处理链：冲突草稿与反馈保存、下个周期去重、模型等待期间手动新增安排参与检测并保留；超过 700 字的生成稿和修改稿完整保存、第三个候选不丢失，密钥仍脱敏。数据写入独立 `work/automatic-sync-test-*` 目录，IMAP/模型为合成响应。
- `npm run build` 和 `git diff --check`：通过。没有新增依赖、迁移、真实配置写入或额外模型调用，保持 React + 一个 Node 服务 + JSON 文件。
- 页面实点：独立端口 3114、`work/conflicts-ui-data`，无真实邮箱/模型配置。确认 2 封预置邀请只生成 1 项日程、另 1 项冲突；日历/邮件助手的持久化卡片、邮件徽标、原/拟建时间与 3 个建议、提取快照、对应日志及草稿入口。采纳、修改、拒绝和刷新保留均通过，原稿与修改稿独立，冲突邀请始终未创建。
- 390×844 窄屏视觉检查通过：完整滚动、3 个时段和草稿按钮可操作、无横向溢出、Escape 关闭与导航正常。验证记录与截图位于 `work/conflicts-ui/verification.json`、`desktop-conflict-details.jpg`、`mobile-conflict-inbox.jpg`、`mobile-conflict-details.jpg`。未发现页面业务运行错误；独立开发服务的 Vite WebSocket 24678 与已运行服务产生端口连接日志，HTTP 页面验证正常，检查时显式刷新。
- 测试没有连接真实 QQ 或付费模型，没有写入本机实际邮件/配置。设置文件 SHA-256 保持不变。原 3000 服务在本次开始前已运行，其自动同步继续更新真实 `calendar.json` 的 `lastSync`，所以整文件哈希不同；收尾两次核对除 `lastSync` 外的日历内容哈希一致，真实 `traces.json` 修改时间未变。独立 3114 测试服务已停止，原 3000 服务未操作；后端新逻辑需重启原开发服务才生效。
- 新能力为代码实现及本地合成/预置验证结果，真实 QQ 新邀请/冲突及模型时间提取仍需复验；不会把预置结果视为真实模型效果。

### 本次自动同步与日历入口（2026-10-13）
- `npm test`：**50/50 通过**。保留原 46 项回归，新增 4 项验证，覆盖配置不完整时跳过、60 秒周期、保存配置后下个周期生效、自动/手动/示例共用锁、已处理邮件不再调用模型、收信错误脱敏、收信及模型失败后下个周期重试、重试日志保留，以及新邮件自动导入。
- 新测试在 Worker 中运行实际 Express API、同步定时器、邮件解析和保存链；使用 Node 内置 mock 推进定时器、替换 IMAP 和模型响应。数据写入独立 `work/automatic-sync-test-*` 目录，不新增依赖或生产测试开关。
- `npm run build` 和 `git diff --check`：通过。自动同步直接复用现有同步处理函数和内存锁；未增加调度服务、额外配置或数据迁移。
- 页面实点检查：3110 独立服务、`work/auto-sync-ui-data` 下确认日历副标题旁的按钮和未配置时打开设置；3111 合成接口下确认按钮触发真实同步路径、同步中禁用和进度展示、结束后恢复可点击，以及后台新增日程无需手动刷新即可显示。合成接口为 `work/auto-sync-ui-fixture.mjs`，不连接 QQ 或模型。完整窄屏截图检查未完成，窄屏已补充副标题换行样式并通过构建。
- 原 `data/calendar.json` 和 `data/settings.json` 的 SHA-256 与修改前一致；未读取真实邮箱、使用真实授权码/Key 或调用付费模型。每分钟自动同步的真实新邮件联调尚待复验；历史基础邀请实连结论仍见下文。

### 本次邮件标签与待办（2026-10-13）

- `npm test`：**46/46 通过**。保留原 29 项回归，新增 17 项业务验证，覆盖六类 Tag、摘要与优先级、北京时间相对截止日与默认 18:00、明确中文时刻、纯任务邮件、多任务、同封/跨邮件去重、同标题不同截止日期、多来源链接、完成状态保留、旧输出兼容、示例隔离、整封验证与重试、独立任务快照、一次本地模型请求包含全部字段和已有任务上下文，以及延期后优先级降级、明日会议/无截止紧急事项和来源链接脱敏。日期敏感测试固定测试时钟。
- `npm run build` 和 `git diff --check`：通过。没有新增依赖；正式数据仍为 React + 一个 Node 服务 + 原有 JSON 文件。
- API 与页面验证使用端口 3106、独立 `work/mail-tasks-qa-data` 数据目录、预置和合成邮件；验证脚本为 `work/verify-mail-tasks.mjs`。覆盖旧 JSON 读取不改写文件、6 封预置邮件形成 3 条任务、报告合并两封来源、低优先级无任务、重复导入不增任务/日志、完成和撤销 JSON 持久化、原日程邀请/取消/调整继续可用、清除示例保留合成真实任务/旧邮件/手动日程。
- 最终页面检查包含日历旁独立待办栏、优先级与截止时间/原话、多个来源、邮件标签和任务快照、`/?email=` 直达及刷新保留上下文、完成后刷新与撤销、390px 窄屏操作/无横向溢出及 Escape 关闭；页面没有运行错误。验证结果与截图保存到 `work/mail-tasks-qa/`。
- 原 `data/calendar.json` 和 `data/settings.json` 的 SHA-256 与修改前一致；没有补写历史邮件 Tag、读取真实邮件、使用真实授权码/Key 或调用真实模型。分类效果、复杂截止日语义及跨邮件语义匹配尚待新邮件真实联调。

### 本次可观测日志与回复草稿（2026-10-12）

- `npm test`：**29/29 通过**。保留 20 项回归，新增 9 项日志业务验证。覆盖模型等待时 running 状态已持久化、六阶段顺序与实际工具动作、草稿不额外调用模型、已计费但解析失败后的重试保留 trace/费用、去重、无 usage/无价格保持未知、服务商错误脱敏、后续编辑/删除不改变证据快照，以及正文先脱敏再截断（跨截断边界的配置密钥不泄露部分字符）。
- 独立数据目录 `work/observability-qa-data`、端口 3104 的 API 验证通过：预置邀请及跳过均有完整阶段和草稿；取消/调整及手动日程保留；单价保存和旧请求保留单价；草稿修改反馈独立于原稿；重复示例不追加 trace；日志 JSON 持久化与 API 一致。
- 本机模拟模型费用验证：合成邮件 1,000 输入（含 200 缓存命中）/250 输出 Token，测试单价分别为 2/0.5/8 元每百万 Token，费用 **0.0037 元 = 0.37 分**。另一封无 usage 的合成通知成本未知，整体平均为 null，已计价样本平均明确为 0.37 分。不是 QQ/真实模型的费用实测。
- API 临时材料：`work/verify-observability-api.mjs`、`work/observability-api-verification.json`。自动测试和 API 验证均使用专门编写的合成邮件/预置示例、本机模型接口，不连接真实 QQ 邮箱或付费模型。
- 页面验证通过：headless Edge / Playwright 在 3104 独立服务完成 15 项检查，包含日历/助手日志位置与跳转入口、六阶段时间轴与成本、播放/暂停和前后单步、Thought/Action/Observation 折叠、新增/跳过/取消/调整、草稿采纳/修改/拒绝与切换/刷新后保留修改稿及原稿、邮件详情定位日志、跨日重试的累计时间轴排除两次运行之间的闲置间隔、历史无日志提示、三种 Token 单价、390px 无横向页面溢出及完整可操作，无页面运行错误。桌面与窄屏截图已经视觉核对。
- 动态前端验证使用明确的本地 route 模拟：点击同步后实际触发 state/traces 各 10 次请求，正确跟随正在提取的邮件（优先于较新排队邮件），日历随轮询增量变化，刷新后续接轮询；快速 POST 失败在首次轮询前也重新加载失败日志。这是前端交互验证，不代表真实 QQ 实连。
- 页面验证材料：`work/verify-observability-ui.mjs`、`work/observability-ui/verification.json`、`desktop-panel.png`、`desktop-model-call.png`、`desktop-reschedule.png`、`mobile-panel.png`。检查中发现拒绝反馈清掉修改稿的问题，已修正并完成上述复验。
- `npm run build` 与 `git diff --check`：通过。
- 原 `data/calendar.json` 和 `data/settings.json` 的 SHA-256 与本次修改前一致；没有补写旧邮件日志、改写旧配置或清空数据。本次能力的真实 QQ 收信、服务商 usage 返回及实际报价仍需用一封新邮件联调复验。

### 本次邮件结构化提取与展示（2026-10-12）

- `npm test`：**20/20 通过**。保留原 15 项回归，新增摘要与旧模型格式、多操作完整快照、后续变更/编辑/删除后快照稳定、无日程摘要与去重、两步预置示例共 5 项业务验证。模型 HTTP 测试确认同次请求读取摘要与日程。
- `npm run build`：**通过**；`git diff --check`：**通过**。
- 独立数据目录 `work/email-structure-api-data`、端口 3102 的 API 验证通过：新增/跳过邮件均保存摘要，取消保存原字段，调整保存继承后的新字段及关联，后续编辑和部分删除不会改变快照，重复变更跳过，JSON 文件保留快照，合成旧邮件与手动日程保持不变。
- 临时 API 验证材料：`work/verify-email-structure.mjs`、`work/email-structure-api-verification.json`，仅使用专门编写的合成邮件与预置示例。
- 页面验证通过：使用独立 headless Microsoft Edge / Playwright 访问 3102 测试服务，实际点击「邮件助手 → 邮件处理记录 → 邮件详情」。确认 1440px 桌面左右分栏、原文/处理结果/关联日程保留、完整结构化字段与日程跳转、取消/调整/跳过展示、历史记录回退、全天及部分删除后的快照、长原文与右侧独立滚动。390px 窄屏上下排列、完整滚动、无横向溢出，Escape 正常关闭；页面无运行错误。
- 页面验证脚本与截图：`work/verify-email-structure-ui.mjs`、`work/email-structure-ui/verification.json`、`work/email-structure-ui/desktop-reschedule.png`、`work/email-structure-ui/mobile-structure.png`。内置浏览器和 Windows computer-use 未完成实点检查后，改用独立本地浏览器测试取得上述结果；测试使用合成数据，未操作用户浏览器和真实邮箱。截图关闭动画以记录稳定画面。
- 本次未读取真实 QQ 邮箱、未调用真实模型。原 `data/calendar.json` 和 `data/settings.json` 的 SHA-256 与修改前一致。

### 本次取消/调整功能（2026-10-12）

- `npm test`：**15/15 通过**。保留原 6 项基础测试，新增取消保留记录、仅地点调整字段继承、倒序批次邀请→连续调整→取消、批内去重、多操作失败不部分修改及重试、动作解析、无效目标与时间、模式隔离、模型 HTTP 日程上下文共 9 项。
- `npm run build`：**通过**。
- 独立数据目录 `work/feature-api-data`、端口 3100 的 API 验证通过：页面 HTTP 200；3 项邀请及 1 封跳过；后续取消 1 项、调整 1 项并新建 1 项；重复通知跳过 2 封；旧新关联和 JSON 持久化正确；清除示例保留手动数据。
- API 验证脚本与结果：`work/verify-email-changes.mjs`、`work/feature-api-verification.json`。它们是临时本地验证材料，不属于业务代码。
- 页面实点已确认独立数据目录下的示例邀请导入：生成 3 项日程并保留手动安排。后续取消/调整的完整浏览器实点未完成：computer-use 工具在 Windows 无法可靠确认当前浏览器 URL，停止了 UI 操作；取消、调整、关联及持久化已通过上述 API 和自动化测试，前端已通过构建与代码复核。没有将其记录为完整页面手动验证。
- 本次未读取 QQ 邮箱、未调用真实模型；全部测试仅使用专门编写的预置邮件、内存数据或本机模拟模型。原 `data/calendar.json` 和 `data/settings.json` 保持不变，使用文件哈希核对。

### V1.0.0 历史本地测试与构建

2026-10-12，在真实联调之前已于现有 Daylight 目录执行：

- `npm test`：**6/6 通过**。
- `npm run build`：**通过**。
- 核对页面代码、QQ 读取逻辑、模型请求格式、配置保存方式及本地数据快照。

6 项测试覆盖：

1. 本地 HTTP 模型接口接收邮件、模型名称、鉴权及 JSON 输出请求，并返回日程。
2. 会议邮件导入、普通邮件跳过、重复同步不重复创建。
3. 单封模型失败保留其他成功结果，失败邮件可再次处理。
4. 一封邮件创建多项日程并保留来源关联。
5. JSON 代码块解析，无效或反向时间及错误结构提示。
6. 模型鉴权失败返回错误。

历史迁移验证检查过页面 HTTP 200、前端资源和日程新增/编辑/删除持久化；本次未重跑该临时脚本。

### 真实 QQ 邮箱 + DeepSeek 联调

2026-10-12，用户完成以下操作并确认验证成功：

1. 在本地页面保存真实 QQ 邮箱、IMAP 授权码和 DeepSeek API 配置。
2. 手动发送一封真实测试邮件到该邮箱。
3. 触发真实邮箱同步，读取邮件并通过 DeepSeek 提取日程，确认结果成功。
4. 将当前代码提交为 V1.0.0，基线提交为 `20333fd`。

V1.0.0 文档核对时的保存结果：

- 邮箱与模型配置字段完整；当前实际使用 `https://api.deepseek.com` 和 `deepseek-flash`。
- 2 封真实 QQ 邮件已有处理记录：1 封 `imported`、1 封 `skipped`。
- 已保存 1 项 `source: 'email'` 的真实邮件日程。
- Git 已有 V1.0.0 基线提交，`data/` 和 `work/` 未纳入 Git 跟踪。

当时仅更新文档并核对本地记录，没有重新同步真实邮箱或请求付费模型。基础流程的用户真实联调和本次取消/调整的本地测试分别记录，不能相互代替。

## 6. 当前边界

- 自动同步每分钟执行，只在本地 Node 服务运行且邮箱、模型配置完整时启用；页面关闭不影响服务，停止服务即停止同步。配置保存不是实连成功的证据。暂无实时收件监听，最近 N 封以外的邮件不会被扫描。
- 通过标准 IMAP/SMTP 客户端凭据接入 QQ、163、126、Gmail、Outlook、iCloud 或自定义服务器；读取 INBOX 正文和 PDF 附件，支持简历文字/OCR；暂无 OAuth、其他附件类型、ICS 邀请或其他文件夹解析。预设不代表该账号权限允许连接；真实验证覆盖当前邮箱及历史 QQ，其他账号须按各自权限实连复验。
- 每次仍有 IMAP 连接、打开 INBOX 和元数据往返；首次全新邮件仍逐封提取。已成功/跳过/冲突邮件免下载原文；未处理邮件仍获取整封源数据，包括附件字节，正文及 PDF 提取文字可进入模型用于简历识别。暂缓模型重试的匹配失败邮件也仍下载和解析原文，不能把其说成零下载。
- 已支持后续取消和调整；目标识别依赖模型和通知内容，名称相近或信息不完整时可能无法正确匹配，暂无人工选择目标的界面。取消记录保留用于追溯，重新邀请应新建安排。
- 已处理邮件按 ID 去重；待办通过模型匹配已有任务 ID，以及规范化标题+截止时间合并跨邮件重复项。不同的新邀请描述同一个活动时，仍不做活动层面的合并；非全天安排时间重叠会进入冲突草稿流程，全天活动不参与冲突。
- 成功处理、跳过或保存冲突草稿的邮件不会再次提取；换模型或删掉日程也不会重新导入该邮件。失败邮件重试仍受最近 N 封范围限制；只有确定的日程目标匹配错误在模型可见上下文未变时暂缓自动/切换模型请求，手动同步可重试，日程/任务/模型上下文变化后恢复。暂缓仍为失败，错误保留、不新增尝试、不反复弹出自动提示；网络、服务商、格式等其他故障继续自动重试。
- 官方 DeepSeek flash/v4-pro 已明确关闭思考模式；所有模型调用有 60 秒等待上限，包含响应正文。此为单次调用上限，不是整批同步上限；未处理邮件多时模型仍按邮件时间逐封调用。
- 历史记录没有内容摘要或提取快照，不自动补提取。页面用当前关联日程显示可恢复字段；旧调整的新日程已删除时只展示原字段并明确提示。新记录快照独立保留，不受关联日程编辑或删除影响。
- 单封失败明细已持久化在 trace 中，成功重试仍保留此前错误。上线前的失败和调用没有日志，无法补全当时的步骤、耗时和 Token。最近同步时间表示处理结束时间，不能单独作为全部成功的证据。
- 已支持本地草稿与反馈，以及用户采纳后通过当前邮箱 SMTP 发送真实回信；示例只保存反馈，自动同步不发信。成功状态表示 SMTP 服务接受邮件，不等于最终投递或已读；没有额外向「已发送」文件夹归档的实现。暂无提醒、重复日程规则或第三方日历同步。
- 冲突和候选只根据当前邮箱已保存的非全天有效日程及模型提取时间计算，不判断对方日历、出行缓冲或个人偏好。冲突安排也入历并占用时间，全天活动不占用冲突或候选时段。普通候选每天 09:00–18:00，包含周末；采纳发送不自动安排候选。日历标识按当前重叠展示，历史冲突邮件的对象/候选/草稿保持处理时快照，不自动补建旧暂缓记录。
- 成本为服务商实际 usage 乘以本次配置价格的估算，不读取真实账单；没有 usage 或对应单价时显示未知。改价不追溯改写历史调用。
- 设置为本机明文 JSON，`data/` 已加入 `.gitignore`；真实同步会把未处理邮件、当前有效日程和已有任务摘要发送到配置的模型接口。
- 待办来源为本地已保存的邮件正文，不提供服务商网页邮箱的深链接；暂无任务删除、编辑或邮件中的任务取消流程。完成/撤销由用户操作；标签和优先级保留处理时的结果，没有每日后台重算。
- 标签、截止日语义和重复任务的识别效果依赖模型。已处理历史邮件不自动补新字段；名称规范化仅覆盖明确相同的标题和截止时间，措辞明显不同的同一事项依赖模型返回已有任务 ID。
- QQ 邮箱和 DeepSeek `deepseek-flash` 的基础邀请提取、QQ SMTP 连接与授权码登录、完整回信送达已有历史真实验证。本次另完成当前邮箱 IMAP 去重耗时及官方 DeepSeek v3「已有最新安排不重复创建」的真实复验。没有相关原安排时直接创建或纯取消跳过、模糊目标暂缓、冲突、任务语义去重等其余分支仍以合成验证为主；其他模型及账号没有据此获得实连结论。复杂日期、全天、多日程及不同邮件格式的真实提取效果尚未逐项验证。

## 7. 下一次继续开发

1. 先读本文件和 `AGENTS.md`，了解已有入口、数据格式和用户的 demo 范围要求。
2. `20333fd`（V1.0.0）是历史基础流程的提交；新增取消/调整、标签/待办、自动同步和冲突检测仍在现有入口扩展，状态字段兼容旧数据。按用户需求继续开发，不增加本地 demo 不需要的层次。
3. 保留本机现有邮箱配置和日程数据。`data/` 不在 Git 中，重新克隆项目时仍需在页面配置邮箱和模型。
4. 需要验证新增提取行为时，发送一封新的测试邮件再同步；成功、跳过或已有冲突草稿的旧邮件会被去重。记录验证结果，不把密钥和真实邮件正文写入文档。
5. 按改动影响选择测试，更新 README 和本文件，继续保持本地 demo 的规模。
