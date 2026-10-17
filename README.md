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

需要 **Node.js 22+**（仓库含 `.nvmrc`）。Rust 工具链已内置在 `work/toolchain/`，无需单独安装。

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

### 打包产物

```bash
npm run desktop:build
```

产物在 `src-tauri/target/release/bundle/`：

- macOS：`macos/Daylight.app`（可直接运行）、`dmg/Daylight_0.1.0_<arch>.dmg`
- Windows / Linux：在对应平台执行同一命令，产物在各自的 bundle 目录

安装包内已包含 Node 二进制、后台代码、前端产物与运行时依赖，终端用户无需安装任何环境。macOS 按 arm64 / x64 分别构建（见 `.github/workflows/desktop.yml`），不做通用二进制。

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

- **桌面专有测试**覆盖：无 PG/Redis/MQ 启动并重启读回、鉴权三层边界、会话一次性、凭据加密落盘、端口回退、补丁锚点自检、pdf.js 离线资源与自产 PDF 渲染、打包运行时（不含 `vite`）能独立启动。
- **共享业务测试**共 680 项：587 通过 / 58 失败 / 35 跳过，与 Web 真源**逐条用例状态完全一致**（本轮对齐引入 0 项差异）。失败项是同时启动真实 Express 服务、mock timer 的历史集成测试，不是桌面端引入。CI 中该步骤 `continue-on-error`。
- 所有写盘测试使用 `work/` 下的独立数据目录，不触碰用户数据。

## 7. 与 Daylight 真源对齐

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

## 8. 已知边界

- 桌面端是**单用户本机应用**：没有多租户、没有管理后台、没有云端账号。后台只监听回环地址。
- 同一数据目录**不能**给多个后台进程同时写入（JSON + 进程内协调）。
- 本地模式不提供持久化后台任务队列；长同步在请求内完成，页面通过状态轮询与 trace 观察进度。
- 真实 IMAP / SMTP / 模型 / 飞书 / 外部日历的可用性取决于用户自己的账号与网络，需要用户自行实连验证；本轮未做真实服务实连。
- **字体**：`index.html` 仍会从 `fonts.googleapis.com` 拉取 Noto Sans SC / Sora / Space Grotesk。离线或受限网络下会回退到系统字体（macOS 为苹方），版式不会错乱，但字形与 Web 端联网时略有差异。桌面端未内置这些字体，以免安装包体积和字重授权扩散。
- **睡眠唤醒**：壳层没有监听系统唤醒事件。后台 Node 进程在唤醒后仍在运行，定时同步与空闲监听会在下一轮触发；本机未实测唤醒路径。
- 未在 Windows / Linux 实机验证；`.github/workflows/desktop.yml` 已配置三平台验证与四产物打包，但本机没有 GitHub remote，**Actions 未实际运行过**。
