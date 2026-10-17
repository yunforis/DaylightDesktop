# README 说明图

本目录存放 [README.md](../../../README.md) 与 [README_EN.md](../../../README_EN.md) 里引用的说明图。

## 这些图是什么

**手绘 SVG**，由 [`generate-svg.mjs`](generate-svg.mjs) 生成——不是截图，也不是 AI 生成的位图。

选 SVG 而不是 PNG 的原因：

- **矢量**：在任何缩放和 Retina 屏上都清晰，不会像 Web 版那批 PNG 一样单张 1.2 MB 起步。
- **体积小**：六张图合计约 60 KB。
- **可离线渲染**：不依赖网络字体或外部资源，GitHub 用 `<img>` 直接渲染（脚本被禁用，正好安全）。
- **文本可搜索、可复制**：图里的文字是真文本，`⌘F` 能搜到。
- **双语文档共用一份**：图内标注统一用**英文技术词**，中文与英文 README 引用同一批文件，不会出现「改一张图要改两份」。这一点与 Web 版说明图的做法一致（它的架构图标注也是纯英文）。

设计与 Web 版说明图同一套语言：暖白底（`#FAF7F2`）、深蓝（`#1B3A5C`）、琥珀点缀（`#F5B84A`）、圆角卡片、细描边。深浅色模式下都保持同样的观感（图片自带底色）。

## 文件清单

| 文件 | 尺寸 | 用在 README 的哪一节 |
| --- | --- | --- |
| `banner.svg` | 1800×600 | 页首横幅（标题 + 一句话定位 + 三个卖点标签 + 应用窗口示意） |
| `architecture.svg` | 1720×1080 | 系统架构：Tauri 壳层 / 内置 Node 后台 / 本地数据 / 外部服务 / 更新源与图例 |
| `update-flow.svg` | 1720×640 | 自动更新与发布：检查 → `latest.json` → 下载 → 签名校验 → 用户确认后替换 |
| `mailbox-scopes.svg` | 1720×614 | 多邮箱：单邮箱 / 同类混合 / 全部混合三种视图的检索范围 |
| `recruitment-flow.svg` | 1720×454 | 招聘与发票 → 招聘处理流程 |
| `invoice-flow.svg` | 1720×424 | 招聘与发票 → 发票处理流程 |

## 怎么改

```bash
# 重新生成全部 SVG（改的是 generate-svg.mjs 里的文字与坐标）
node docs/assets/readme/generate-svg.mjs

# 本地看一眼：起个静态服务，浏览器打开 _preview 之类的页面即可
python3 -m http.server 8971 --bind 127.0.0.1
```

生成脚本里的 `t()` 是文本、`r()` 是圆角矩形、`chip()` 是标签、`poly()` 是折线箭头、`stepCard()` / `flow()` / `rowX()` 是流程卡片与居中排版，改文字后**务必重新渲染检查有没有溢出**——SVG 不会自动换行，长文本会直接顶出卡片（这正是本轮修过的问题）。

改完记得顺手确认：

```bash
for f in docs/assets/readme/*.svg; do xmllint --noout "$f" || echo "FAIL $f"; done
```

## 关于「应用页面展示」

本仓库的 README **有意不放界面截图**：

- 截图会绑定当时的界面状态，改一次 UI 就要重截一轮，很快就与代码脱节；
- 截图里很容易带进真实邮件正文、邮箱地址、候选人姓名——这类隐私信息不该进仓库；
- 界面能做的事，README 的功能表与流程图已经说清楚了。

如果后续确实要加，建议放占位符而不是随手截：

```html
<p align="center">
  <img src="docs/assets/readme/screenshot-mail.png" alt="邮件工作区" width="48%" />
  <img src="docs/assets/readme/screenshot-calendar.png" alt="日历与待办" width="48%" />
</p>
```

### 截图拍摄要求（供后续补图时对照）

- 分辨率不低于 2560×1600（2× 缩放），窗口宽度固定 1440 pt，不显示系统桌面与其它应用窗口；
- 只展示**合成数据**：用预置示例导入的日程与邮件，或自建的测试邮箱；不出现真实姓名、真实公司、真实邮箱地址、真实招聘/发票内容；
- 浅色主题、中文界面各一张（英文界面可选）；
- 文件命名 `screenshot-<页面>.png`，放进本目录，同时更新上面那张清单表。

### 生成用的 prompt（想要 AI 配图或重绘时可直接用）

横幅主视觉（把 `banner.svg` 换成更有质感的位图插画时）：

> A wide 3:1 hero banner illustration for a desktop email-agent app called "Daylight". Warm off-white background (#FAF7F2). Left side: a minimal flat logo of an amber sun rising over two navy leaves, the wordmark "Daylight" in a bold geometric sans-serif in deep navy (#1B3A5C), and the tagline "Turn messages into next steps.". Right side: a friendly flat illustration of a desktop app window with traffic-light dots, showing two incoming email cards on the left connected by a subtle arrow to a task checklist and a small calendar grid on the right. Palette strictly limited to warm off-white, deep navy, amber (#F5B84A), soft blue-grey (#EDF2F7). Flat vector style, generous white space, no gradients, no photorealism, no text other than the wordmark and tagline, no watermark.

界面截图风格参考图（不是真实截图，只作为视觉方向）：

> A clean product screenshot mockup of a desktop email-agent workspace: left sidebar with mailbox categories, center list of email cards, right panel showing a calendar and a task list. Modern minimal SaaS UI, generous spacing, warm off-white background, deep navy text, amber accent buttons, rounded cards with hairline borders, no real personal data — use obviously synthetic placeholder senders like "campus-notice@example.com". 2x resolution, 1440pt window.

技术示意图（想把手绘 SVG 换成渲染出来的位图时）：

> A precise technical architecture diagram for a local desktop app, flat vector style, warm off-white background, rounded cards with hairline borders, deep navy text and amber accents, English labels only, thin arrows with a legend explaining solid = in-process/loopback, dashed = outbound network, dash-dot = anonymous HTTPS. Two regions: a dashed "single app boundary, 127.0.0.1 only" box containing the desktop window (Tauri shell + React webview), a bundled Node backend and a local data directory; below it, outbound cards for IMAP, SMTP, LLM, calendars and an optional meeting service, plus an update-source card fed by GitHub Releases `latest.json`. No photorealism, no logos, text must be legible when scaled down.
