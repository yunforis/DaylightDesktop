# Daylight Desktop · 邮件日历桌面应用

基于 **Tauri 2** 的本地桌面邮箱 agent：通过 IMAP 读取多个邮箱，调用 OpenAI 兼容大模型提取日程、待办、发票与招聘信息，结果保存在本机。内置 Node.js 后台，用户**无需安装 Node 或其他依赖**。

桌面端是 Daylight 的一个分发形态：业务代码与 [Daylight（Web / 云原生版）](../Daylight) 共享，桌面专有部分集中在壳层、本地会话、加密落盘与打包。

- 当前实现、验证结果与边界：[STATUS.md](STATUS.md)
- 开发约定：[AGENTS.md](AGENTS.md)
- 本文件：操作、启动、构建与验证入口

## 架构

```
Daylight（Tauri 2 桌面应用）
├─ React 前端（shadcn/ui + Tailwind）           ← 与 Web 共享
├─ Rust 壳层（src-tauri/）
│  ├─ 窗口 / 托盘 / 单实例 / 关闭到托盘 / 窗口状态记忆
│  ├─ 系统凭据库（keyring）保存数据加密密钥，无明文降级
│  └─ 启动内置 Node 后台、解析就绪端口、外部链接走系统浏览器
└─ 内置 Node 后台（src-tauri/runtime/，随安装包分发）  ← 与 Web 共享
   ├─ IMAP / SMTP / 大模型 / OCR
   ├─ 日程 / 待办 / 邮件 / 发票 / 招聘 / 小 D / 日志
   └─ 本地数据存储（默认 JSON，无需数据库）
```

**默认本地模式**：不连 PostgreSQL / Redis / RabbitMQ，只监听 `127.0.0.1`。桌面端是单用户本机应用，同步在进程内完成。

## 1. 启动与构建

需要 **Node.js 22+**（仓库含 `.nvmrc`）。本机若已把 Rust 工具链放在 `work/toolchain/`（`work/` 不进仓库），`npm run desktop:*` 会自动使用它；**在新机器上需要自行安装 Rust**（见下方「打包前置」）。

```bash
nvm use            # 切到 .nvmrc 指定的 Node
npm install
npm run desktop:dev   # 开发：Tauri 窗口 + 前端热更新 + Node 后台
```

窗口打开后直接进入 `/app` 工作区，**无需注册或登录**。

### 其他命令

| 命令 | 作用 |
| --- | --- |
| `npm run desktop:dev` | 开发模式桌面窗口（后端固定端口 14321） |
| `npm run dev` | 只在浏览器调试前端：`http://127.0.0.1:3000`（会自动转到 `/app`） |
| `npm run build` | 构建前端产物到 `dist/` |
| `npm run desktop:prepare` | 生成内置 Node 运行时到 `src-tauri/runtime/` |
| `npm run desktop:check` | Rust 壳层 `cargo check` |
| `npm run desktop:build` | 打包安装包（会先执行 build + prepare） |
| `npm test` | 与 Web 共享的业务测试（`server/*.test.js`） |
| `npm run test:desktop` | 桌面专有测试（`desktop-tests/`） |
| `node scripts/desktop-sync.mjs` | 从 Daylight 真源重新同步业务代码并重贴桌面补丁 |

### 打包前置

`npm run desktop:build` 是一条命令，但不是零前置：

- **Node.js 22+**（构建期用，安装包里另有一份内置 Node，终端用户不需要）。
- **Rust 工具链**（`rustup` + 本机目标）。本机若把工具链放在 `work/toolchain/`，`scripts/desktop.mjs` 会自动使用；否则回落到系统 `cargo`。
- **Linux** 还需要系统库：`libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf`。
- **Windows** 需要 MSVC 生成工具与 WebView2 运行时（安装包用 `downloadBootstrapper` 自动装 WebView2）。

**交叉打包**：安装包内置 Node，所以内置 Node 的架构必须等于安装包架构。用 `DAYLIGHT_TARGET_TRIPLE` 指定目标（脚本会去 nodejs.org 取对应架构的官方 Node，并用 `npm install --os/--cpu` 装对原生模块）：

```bash
DAYLIGHT_TARGET_TRIPLE=x86_64-apple-darwin npm run desktop:prepare
```

Intel Mac 的包正是这样在 Apple Silicon 上交叉构建的（`x86_64-apple-darwin`）——GitHub 已不再提供 x64 的 macOS runner。

### 打包产物

```bash
npm run desktop:build
```

产物在 `src-tauri/target/release/bundle/`：

- macOS：`macos/Daylight.app`（可直接运行）、`dmg/Daylight_0.1.0_<arch>.dmg`，以及自动更新用的 `macos/Daylight.app.tar.gz` + `.sig`
- Windows / Linux：在对应平台执行同一命令，产物在各自的 bundle 目录（含更新用的 `.sig`）

安装包内已包含 Node 二进制、后台代码、前端产物与运行时依赖，终端用户无需安装任何环境。macOS 按 arm64 / x64 分别构建，不做通用二进制。

打包自动更新产物需要签名私钥（`TAURI_SIGNING_PRIVATE_KEY`），缺失时会在「生成更新产物」这一步直接失败——这是刻意的，没有签名就不该发布更新。

若提示端口被占用，开发模式可换端口：

```bash
PORT=3001 npm run desktop:dev        # macOS / Linux
$env:PORT='3001'; npm run desktop:dev  # PowerShell
```

## 2. 桌面端专有行为

- **无登录页**：原生壳层生成一次性 token，用它打开 `/desktop/start?token=…` 换取 HttpOnly cookie，前端再用 cookie 调 `/desktop/session` 拿到本地 `owner@daylight.local` 会话。没有 Landing、注册、找回密码、法律页和管理端页面。
- **访问控制**：后台只监听 `127.0.0.1`，并要求 `Host` 为回环地址、`Origin` 与自身一致、且带壳层 cookie。缺一层分别得到 403 / 403 / 401。
- **管理端接口不可达**：`/api/admin/*` 在桌面模式统一返回 404（实现保留，仅屏蔽路由）。
- **凭据加密落盘**：`settings.json` 与 `infra.json` 用 AES-256-GCM 加密保存（密钥来自系统凭据库，经环境变量注入后台进程）。拿不到密钥时**明确报错**，不会静默降级成明文。其余业务 JSON 保持明文并使用临时文件 + rename 原子写入。
- **数据目录**：由壳层传入（macOS `~/Library/Application Support/com.daylight.desktop`，Windows `%APPDATA%\com.daylight.desktop`，Linux `~/.local/share/com.daylight.desktop`）。后台诊断日志为该目录下的 `backend.log`。
- **端口回退**：首选端口被占用时自动改用随机端口，再通过 `DAYLIGHT_READY <port>` 通知壳层导航。窗口打不开的情况不会以「静默失败」收场。
- **生命周期**：关闭窗口隐藏到托盘（托盘菜单：打开 / 数据目录 / 退出）；单实例；窗口大小位置记忆；退出时先向后台 stdin 写 `shutdown` 再等待，最多 3 秒后强杀，避免数据写一半。
- **PDF 预览**：直接复用与 Web 相同的 `src/components/pdf-preview.jsx`（`pdfjs-dist` 在页面内渲染），不依赖各平台 WebView 的内置 PDF 能力；CMap、标准字体与 wasm 解码器经 `import.meta.glob` 打进前端产物，离线可用。Office 文档在桌面端走「该附件暂无公网地址，无法内嵌 Office 预览」分支：附件地址都是相对路径，不会去请求 `view.officeapps.live.com`。
- **外部链接**：`http(s)` / `mailto` 交给系统浏览器；本机 PDF 用应用内查看器。
- **语音输入**：小 D 复用浏览器 `SpeechRecognition`，先做能力探测；不支持时提示改用键盘输入。

## 3. 功能一览

业务功能与 Web 版一致，细节见 [STATUS.md](STATUS.md)：

| 领域 | 内容 |
| --- | --- |
| 邮件 | 多邮箱 IMAP、IDLE / 轮询、去重、分类、摘要、回复草稿与真实 SMTP 回信 |
| 日历 | 日/周/月视图、手动增删改、冲突标识与候选时段、取消 / 调整追溯、ICS 导出、Google / Outlook / CalDAV 推送 |
| 待办 | 截止时间推断、优先级、来源追溯、完成与撤销 |
| 发票 | 发票邮件抽取、明细与汇总页 |
| 工作台 | 场景模板、工作台过滤与匹配、岗位/招聘/发票三套预置工作台 |
| 智能招聘 | PDF 原件、文字层 + 扫描页 OCR、结构化候选人、自然语言筛选、面试邀约审核后发送、飞书建会 |
| 小 D 助手 | 自然语言查/增/改/删日程与待办、主动邮件与会议、草稿审核、RAG 引用、语音输入 |
| 知识库 | 邮箱语料 RAG 索引与问答（本地向量存储） |
| 可观测 | 分阶段 trace、动态回放、Token 与费用估算、报告模板 |
| 后台任务页 | 本地模式下显示「当前服务未启用后台任务」，同步结果在邮件与执行记录中查看 |

## 4. 配置邮箱与模型

在应用内「设置」填写，保存到数据目录（凭据加密）：

1. **邮箱**：选择服务商预设或自定义 IMAP/SMTP，填地址与**授权码 / 应用专用密码**（不是登录密码）。QQ 邮箱需在邮箱设置里开启 IMAP/SMTP 服务。首次联调建议读取数量设为 3–5 封。
2. **模型**：填写 OpenAI 兼容的 Base URL、API Key、模型名称，且该模型需支持 `response_format: { "type": "json_object" }`。可选填人民币单价用于费用估算。

> 保存成功或页面显示「已配置」**只表示字段已保存**，不代表邮箱或模型连接成功。真实连通性需要用真实邮箱和真实模型跑一次同步才能确认。

## 5. 演示（不连真实邮箱与模型）

应用内置三组**预置提取结果**的演示，可在没有任何配置时体验完整链路，页面与日志都会明确标注为预置结果：

- 演示日程冲突与回复确认
- 演示新增、取消与调整
- 演示邮件标签与待办

预置演示不会连接真实邮箱、不会调用真实模型、不会真实发信。示例数据的清除在「设置」中完成，清除示例不会影响真实邮件与手动日程。

## 6. 测试与验证入口

```bash
npm test              # 共享业务测试（server/*.test.js）
npm run test:desktop  # 桌面专有测试（desktop-tests/）
npm run build         # 前端构建
npm run desktop:check # Rust 壳层检查
bash work/smoke.sh    # 后端冒烟（生产模式 / 无 PG / 仅回环 / 鉴权边界）
```

- **桌面专有测试**覆盖：无 PG/Redis/MQ 启动并重启读回、鉴权三层边界、会话一次性、凭据加密落盘、端口回退、补丁锚点自检、pdf.js 离线资源与自产 PDF 渲染、发布矩阵与内置 Node 架构映射一一对应、自动更新配置与原生侧流程、Windows PATH 键名大小写、前端产物文件名跨平台合法性、打包运行时（不含 `vite`）能独立启动。共 12 项，全通过。
- **共享业务测试**共 680 项：587 通过 / 58 失败 / 35 跳过，与 Web 真源**逐条用例状态完全一致**（本轮对齐引入 0 项差异）。失败项是同时启动真实 Express 服务、mock timer 的历史集成测试，不是桌面端引入。CI 中该步骤 `continue-on-error`。
- 所有写盘测试使用 `work/` 下的独立数据目录，不触碰用户数据。

## 7. 自动更新与发布

### 客户端行为

- 启动约 6 秒后**静默检查**一次更新：已是最新就什么都不做，有更新才弹原生对话框。
- 托盘菜单 →「检查更新…」可手动检查，无论结果如何都会给出反馈。
- **绝不静默安装**：弹窗里点「下载并安装」之后才会下载，下载期间窗口标题显示进度提示，装完自动重启到新版本。本地数据与配置不受影响（更新只替换程序本体）。
- 更新逻辑**全部在 Rust 壳层**（`src-tauri/src/update.rs`）。应用页由回环 HTTP 提供，不给页面调用「替换自己安装文件」这条命令的通道，页面即使被注入也够不到更新能力。
- 还没发布过任何正式版本时，更新端点返回 404，插件会把它折叠成 `ReleaseNotFound`。原生侧会把这类情况翻译成「还没有取到可用的更新信息」，而不是误报成「网络故障」；缺少当前平台安装包（`TargetNotFound`）也单独区分提示。

### 信任链

更新包用 minisign 签名，客户端用编译进去的公钥校验，校验不过就拒绝安装。

| 东西 | 位置 | 是否可公开 |
| --- | --- | --- |
| 公钥 | `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey` | 可提交 |
| 私钥 | 本机 `work/updater-key/daylight.key`（`work/` 不进仓库）+ GitHub Secret `TAURI_SIGNING_PRIVATE_KEY` | **绝不可提交** |

更新源固定为 `https://github.com/yunforis/DaylightDesktop/releases/latest/download/latest.json`（与 `package.json` 的 `repository` 一致，`desktop-tests` 会交叉校验）。它只指向**已发布的正式版本**，草稿与预发布不会推送给客户端。

丢失私钥就无法再发布可用的更新（客户端会拒绝用别的密钥签出来的包），请妥善备份 `work/updater-key/`。

### 发布六平台安装包

打标签即发布（`.github/workflows/release.yml`）：

```bash
# 1. 三处版本必须一致，否则 guard 任务会直接挡住
#    package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml
# 2. 提交后打标签并推送
git tag v0.1.0
git push origin v0.1.0
```

也可以到 Actions 页面手动运行 `release` 工作流，填一个标签（标签不存在时会在本次运行的提交上创建）。勾上 **「只产出草稿 Release」** 就只构建不公开——用于先验证六平台能不能都出包，确认后勾掉再跑一次即为正式发布（草稿里已经有全部产物与 `latest.json`，也可以直接在 Releases 页面把它发布出去）。

| 平台 | Runner | Rust target |
| --- | --- | --- |
| macOS Apple Silicon | `macos-14` | `aarch64-apple-darwin` |
| macOS Intel | `macos-14`（交叉构建） | `x86_64-apple-darwin` |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` |
| Linux ARM64 | `ubuntu-24.04-arm` | `aarch64-unknown-linux-gnu` |
| Windows x64 | `windows-latest` | `x86_64-pc-windows-msvc` |
| Windows ARM64 | `windows-11-arm` | `aarch64-pc-windows-msvc` |

`fail-fast: false`：某个平台失败不影响其余平台，Release 里就少那一个产物，已发布的版本对能装的平台照常可用。

### 需要在 GitHub 配置的 Secrets

| Secret | 是否必需 | 说明 |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | **必需** | `work/updater-key/daylight.key` 的**文件内容**。缺失时打包会在「生成更新产物」这步直接失败——这是刻意的，没有签名不该发布更新 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 可选 | 私钥口令。当前密钥未设口令，**不要填**：让它保持不存在（表达式为空串）与「无口令密钥」是匹配的，本机已实测这一组合能正常签名 |
| `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | 可选 | macOS 签名与公证。**不配也能出包**，但用户首次打开需要在「系统设置 → 隐私与安全性」里手动放行 |

工作流只在 `APPLE_CERTIFICATE` 非空时才注入签名变量（空变量会让 Tauri 打包器报错），所以没配证书时不会因此失败。

### 仓库必须保持公开

更新源 `.../releases/latest/download/latest.json` 是**匿名**地址。仓库转私有后客户端会拿到 404，自动更新整体失效。这一点不能靠客户端绕过去：把仓库的读取 token 打进安装包，等于让每个下载者都能读到整个仓库，而且 token 一过期所有客户端的更新就集体失效。

万一仓库确实是私有的，客户端不会崩——托盘菜单会明确显示「还没有取到可用的更新信息」，用户可到 Releases 页面（登录后可见）手动下载覆盖安装。

### Linux / Windows 自更新的产物要求

- **Windows**：自动更新只能安装 **NSIS**（`-setup.exe`）。`targets: "all"` 会同时产出 WiX（`.msi`），而客户端装不了 msi，所以 `release.yml` 里显式设了 `updaterJsonPreferNsis: true`，让 `latest.json` 指向 setup.exe。`.msi` 仍会随 Release 提供，供手动安装。
- **Linux**：只对 **AppImage** 生效（Tauri 替换 AppImage 文件本身）。用 `.deb` / `.rpm` 安装的版本**不会**自动更新——包管理器管着的文件不该由应用自己替换，这类用户需要下载新包重新安装。Release 里三种产物都会出。

## 8. 与 Daylight 真源对齐

桌面端与 Web 版共享 `src/`、`server/`、`shared/`、`public/`、`scripts/`。当 Web 侧前进时：

```bash
# 推荐：先导出真源「已提交的 HEAD」作为干净基线（避开真源工作区里未提交的在改代码）
git -C ../Daylight archive HEAD | tar -x -C work/web-head
DAYLIGHT_WEB_DIR="$PWD/work/web-head" node scripts/desktop-sync.mjs --check   # 先校验补丁锚点
DAYLIGHT_WEB_DIR="$PWD/work/web-head" node scripts/desktop-sync.mjs

node scripts/desktop-sync.mjs            # 默认读 ../Daylight（会读到其工作目录，含未提交改动）
DAYLIGHT_WEB_DIR=/path/to/Daylight node scripts/desktop-sync.mjs
```

脚本会：整树复制真源的共享代码 → 移除 Web 专有页面 → 逐条重贴桌面补丁（精确字符串替换，锚点找不到立刻报错）→ 校验运行时依赖白名单覆盖了 `server/` 的全部裸包导入。

**为什么推荐导出 HEAD 而不是直接读工作目录**：真源长期处于并发开发状态，工作目录里常有写了一半的文件。直接整树复制会把这些未提交改动带进桌面端，让「桌面端等于真源哪个提交」这个问题失去答案。用 `git archive HEAD` 得到的是可复现的提交快照。

`Dockerfile` 与 `docs/submission/evaluation-cases.json` 也在同步清单里，**只因为共享测试套件会读取它们**；桌面端不使用容器部署，也不参与比赛材料提交。

**桌面端自有文件不受同步影响**：`src/App.jsx`、`src/lib/desktop.js`、`server/desktop-entry.js`、`server/desktop-http.js`、`server/secure-json.js`、`src-tauri/**`、`scripts/desktop*.mjs`、`scripts/prepare-desktop.mjs`、`desktop-tests/**`。

补丁清单与理由见 `STATUS.md`，`desktop-tests` 中有锚点自检测试守护。

## 9. 已知边界

- 桌面端是**单用户本机应用**：没有多租户、没有管理后台、没有云端账号。后台只监听回环地址。
- 同一数据目录**不能**给多个后台进程同时写入（JSON + 进程内协调）。
- 本地模式不提供持久化后台任务队列；长同步在请求内完成，页面通过状态轮询与 trace 观察进度。
- 真实 IMAP / SMTP / 模型 / 飞书 / 外部日历的可用性取决于用户自己的账号与网络，需要用户自行实连验证；本轮未做真实服务实连。
- **字体**：`index.html` 仍会从 `fonts.googleapis.com` 拉取 Noto Sans SC / Sora / Space Grotesk。离线或受限网络下会回退到系统字体（macOS 为苹方），版式不会错乱，但字形与 Web 端联网时略有差异。桌面端未内置这些字体，以免安装包体积和字重授权扩散。
- **睡眠唤醒**：壳层没有监听系统唤醒事件。后台 Node 进程在唤醒后仍在运行，定时同步与空闲监听会在下一轮触发；本机未实测唤醒路径。
- **未在 Windows / Linux 实机验证**：`src-tauri/src/main.rs` 与 `scripts/prepare-desktop.mjs` 里有真实的平台分支，依赖清单也记录了全部平台的预编译包，但这仍是**代码已实现**，不是**实机跑通**。
- **平台验证已是云端实测，发布流水线还没跑过**：`.github/workflows/desktop.yml`（三平台 verify）已在 GitHub Actions 上真实运行并**三平台全绿**——`macos-14`、`ubuntu-22.04`、`windows-latest` 各 17/17 步（含 12 项桌面专有测试与 `cargo check`）。Windows 那一路先后暴露并修掉了三个真实缺陷（见 [STATUS.md](STATUS.md)），其中「资源文件名以点结尾」会直接导致 Windows 用户装不上。`.github/workflows/release.yml` 的六平台矩阵与安装包发布**一次都没运行过**，要等第一次打标签；ARM64 runner（`ubuntu-24.04-arm`、`windows-11-arm`）的可用性随账号与仓库可见性变化。
- **自动更新未做端到端验证**：本机已实测「更新产物签名能被应用内嵌公钥接受、篡改 1 字节即被拒绝」（含反向对照），但**下载 → 校验 → 替换安装文件 → 重启**这一整条链路需要发布两个真实版本才能验证，本轮未做。Linux 上还额外依赖 AppImage 形态。
- **macOS 安装包未做签名与公证**：本机与 CI 默认产出未签名包，首次打开需要手动放行。配好 `APPLE_*` Secrets 后即可自动签名公证，那时需要 Apple 开发者账号（付费）。
