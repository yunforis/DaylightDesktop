<div align="center">
  <img src="docs/assets/readme/banner.svg" alt="Daylight Desktop — Turn messages into next steps." width="100%" />
  <p><strong>Turn messages into next steps.</strong></p>
  <p>An email-driven Agent desktop app · Tauri 2 + bundled Node runtime · UCloud AI Hackathon · Track B / AI Application</p>
  <p><strong><a href="README.md">简体中文</a> · English</strong></p>
  <p>
    <img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&amp;logo=tauri&amp;logoColor=white" alt="Tauri 2" />
    <img src="https://img.shields.io/badge/React-19-149ECA?style=flat-square&amp;logo=react&amp;logoColor=white" alt="React 19" />
    <img src="https://img.shields.io/badge/Node.js-%E2%89%A522-43853D?style=flat-square&amp;logo=node.js&amp;logoColor=white" alt="Node.js >=22, bundled" />
    <img src="https://img.shields.io/badge/Platform-macOS_%7C_Windows_%7C_Linux-2F2F2F?style=flat-square" alt="macOS, Windows and Linux" />
    <img src="https://img.shields.io/badge/Updater-minisign_signed-F4B544?style=flat-square" alt="minisign-signed updates" />
    <img src="https://img.shields.io/badge/Agent-Human_in_the_loop-F4B544?style=flat-square" alt="Human-in-the-loop Agent" />
  </p>
  <p><a href="#overview">Overview</a> · <a href="#quickstart">Download</a> · <a href="#desktop">Desktop behavior</a> · <a href="#architecture">Architecture</a> · <a href="#update">Auto-update</a> · <a href="#development">Build</a> · <a href="#evidence">Verification</a> · <a href="#contributing">Contribute</a></p>
</div>

<details>
<summary><strong>Contents</strong></summary>

[Overview](#overview) · [Quick start](#quickstart) · [Desktop-specific behavior](#desktop) · [Capabilities](#capabilities) · [Mailboxes](#mailboxes) · [Recruitment & invoices](#workflows) · [Architecture](#architecture) · [User guide](#usage) · [Auto-update & releases](#update) · [Local development & packaging](#development) · [Syncing with upstream](#sync) · [Verification & boundaries](#evidence) · [Repository map](#structure) · [Roadmap](#roadmap) · [Contributing](#contributing)

</details>

---

<a id="overview"></a>
## ☀️ Overview

**Daylight Desktop is an email Agent desktop app you install and use immediately.** It reads your own mailboxes over IMAP, calls an OpenAI-compatible model to extract calendar events, tasks, invoices, and recruitment records, and brings mail, attachments, calendars, and tasks together so you can find notices, organize materials, track progress, and prepare replies. **Opening an email does not mean the work is done.**

- **No server to run:** the installer bundles the Node.js backend. End users install no Node runtime, no database, no Docker, and configure no servers.
- **No account system:** there is no registration, login, password reset, or admin console. The app creates a local one-time session; opening it lands you in the workspace.
- **Data stays local by default:** business data lives in the local data directory, credentials are encrypted at rest, and only the model provider you configure receives the mail context needed for analysis.
- **Shared with the Web version:** `src/`, `server/`, and `shared/` are shared with [Daylight (Web / cloud-native)](https://github.com/why121368/Daylight). The desktop fork replaces only the shell, local session, encrypted storage, and packaging.

| Common approach | With Daylight Desktop |
| --- | --- |
| Star a message and remember to revisit it | Associate notices with cases; track actions, stages, and materials separately |
| Repeatedly search the inbox | Ask about indexed mail/attachments and open the original from an answer |
| Switch between campus, personal, and work accounts | View one mailbox, a category, or all mailboxes |
| Rewrite calendar entries after changes | Retain earlier arrangements and link replacement events to their sources |
| Stand up a server, database, and account system before using AI | Install and run: the Node backend is bundled and data stays on this machine by default |
| Handle resumes and invoices as scattered attachments | Review them in dedicated recruitment/invoice pages alongside originals |

**Current delivery:** the desktop shell, a local single-user workspace, preset scenario templates, retrieval, Little D, and a complete native auto-update framework. Installers for all six targets (macOS arm64/x64, Windows x64/arm64, Linux x64/arm64) have been built in CI, and **[`v0.1.0`](https://github.com/yunforis/DaylightDesktop/releases/tag/v0.1.0) is published**: a full release round passed every stage (version guard → six-platform build → `latest.json` rewrite) and the Release holds **27 artifacts** (`.dmg` / `.app.tar.gz` / NSIS `-setup.exe` / `.msi` / `AppImage` / `.deb` / `.rpm`, each with `.sig`, plus `latest.json`). The tag points at the commit that built these artifacts (`467ddd2`), all 18 platform keys in `latest.json` are public download URLs, and the public update endpoint was verified anonymously reachable (HTTP 200 — sampling it downloads real binaries, not metadata JSON). **The app has not been launched on real Windows or Linux machines**; every unverified item is recorded in [STATUS](STATUS.md) and [Known boundaries](#evidence).

<a id="quickstart"></a>
## ⚡ Quick start

Installers are published through this repository's [Releases](https://github.com/yunforis/DaylightDesktop/releases). Download the file for your platform and open the app — **no registration, login, database, or command line**. Node binaries, backend code, frontend assets, and runtime dependencies are already inside the package.

**First use takes two steps:** [connect your inbox and model](#usage) → sync and review the extracted results. Unlike the Web version, the desktop app has no admin bootstrap, no system SMTP, no self-service registration, and no environment variables to configure.

| Platform | Artifact | Notes |
| --- | --- | --- |
| macOS Apple Silicon | `.dmg` (`_aarch64`) | Ad-hoc signed, so allow it once under System Settings → Privacy & Security; **not Developer ID signed or notarized** |
| macOS Intel | `.dmg` (`_x64`) | Cross-built on Apple Silicon (GitHub no longer provides x64 macOS runners) |
| Windows x64 / arm64 | NSIS `.exe` (`_x64-setup.exe` / `_arm64-setup.exe`), `.msi` | Auto-update uses NSIS; `.msi` is for manual installs |
| Linux x64 / arm64 | `AppImage`, `.deb`, `.rpm` | Only the AppImage supports auto-update |

Each platform also ships the signature files (`.sig`) used by the updater; `latest.json` is generated and checked by the release pipeline so that all six platforms are present. Artifact names, sizes, and platform coverage are governed by the actual contents of [Releases](https://github.com/yunforis/DaylightDesktop/releases).

> **The macOS package in `v0.1.0` reports "the app is damaged and can't be opened" on Apple Silicon**: that build carried only the linker's automatic signature and was **never signed as a bundle** (`Contents/_CodeSignature/CodeResources` missing), so macOS refuses to load it. The download is not corrupt — its size matches the release byte for byte. This is fixed on the build side (ad-hoc signing by default, plus a CI check on the artifact), and **you need a new version to get a usable macOS package**. To use `v0.1.0` in the meantime, copy it into `/Applications` and sign it once by hand:
>
> ```bash
> sudo xattr -dr com.apple.quarantine /Applications/Daylight.app
> sudo codesign --force --deep --sign - /Applications/Daylight.app
> ```
>
> Then open it normally; if it still reports an unverified developer, allow it under System Settings → Privacy & Security.

- Just want to use it: download, install, then follow the [user guide](#usage)
- Wondering how it differs from the Web version: [desktop-specific behavior](#desktop)
- Want to change code or package it yourself: [local development & packaging](#development)
- Want the implementation scope and unverified items: [verification & boundaries](#evidence)

<a id="desktop"></a>
## 🖥️ Desktop-specific behavior

The desktop app is not "the Web app in a browser window"; the local form factor brings a defined set of differences:

- **No login page:** the native shell generates a one-time token, opens `/desktop/start?token=…` to exchange it for an HttpOnly cookie, and the frontend calls `/desktop/session` for a local `owner@daylight.local` session. There is no landing page, registration, password reset, legal page, or admin UI.
- **Access control:** the backend listens on `127.0.0.1` only and requires a loopback `Host`, a same-origin `Origin`, and the shell cookie. Missing any layer yields 403 / 403 / 401.
- **Admin routes unreachable:** `/api/admin/*` returns 404 in desktop mode (the implementation is kept; only routing is disabled).
- **Credentials encrypted at rest:** `settings.json` and `infra.json` are stored with AES-256-GCM (the key comes from the system credential store and is injected into the backend process). If the key is unavailable the app **fails loudly** instead of silently falling back to plaintext. Other business JSON stays plaintext and is written atomically via a temporary file plus rename.
- **Data directory:** supplied by the shell (macOS `~/Library/Application Support/com.daylight.desktop`, Windows `%APPDATA%\com.daylight.desktop`, Linux `~/.local/share/com.daylight.desktop`). Backend diagnostics live in `backend.log` in that directory.
- **Port fallback:** if the preferred port is taken, the backend switches to a random port and signals the shell with `DAYLIGHT_READY <port>`. A window that cannot open never ends as a silent failure.
- **Lifecycle:** closing the window hides it to the tray (menu: open / data directory / quit); single instance; window size and position are remembered; on quit the shell writes `shutdown` to the backend's stdin, waits, and force-kills after at most 3 seconds to avoid partial writes.
- **PDF preview:** reuses the same `src/components/pdf-preview.jsx` as the Web version (`pdfjs-dist` renders in-page) rather than relying on each platform WebView's built-in PDF support. CMaps, standard fonts, and the wasm decoder are bundled into the frontend via `import.meta.glob` and work offline. Office documents hit the "this attachment has no public URL, so Office preview cannot be embedded" branch: attachment URLs are relative and `view.officeapps.live.com` is never called.
- **External links:** `http(s)` / `mailto` go to the system browser; local PDFs open in the in-app viewer.
- **Speech input:** Little D reuses browser `SpeechRecognition` after a capability probe; when unsupported it suggests typed input.

<a id="capabilities"></a>
## 🧩 Capabilities

Business features match the Web version; details are in [STATUS.md](STATUS.md).

### Six preset workspaces

| Scenario | Cases and workflows | Business boundary |
| --- | --- | --- |
| **Recruitment** | Candidates, resume PDF/OCR, screening, retrieval, interview invitations, communication | Sending requires review; Feishu needs separate setup and authorization |
| **Invoice assistant** | Attachment extraction, field checks, original documents, reimbursement preparation | Verify against originals; invoice extraction does not automatically change tasks/events |
| **Graduate admission** | Summer programs, pre-admission, supervisor outreach; opportunities, materials, deadlines, interviews, changes | Positive feedback is not formal admission; portal actions require receipts |
| **PhD / overseas research / RA** | Contact context, research plan versions, time zones, follow-ups | Polite interest is not a position guarantee; retain original zone, UTC, and Beijing time |
| **Campus job applications** | Company/role progress, assessments, document requests, interviews, submissions | A document request does not imply advancement; platform/SMS/chat information requires input |
| **Publications & conferences** | Revisions, coauthor prerequisites, final manuscripts, registration, presentations | Submission/payment outcomes require external evidence |

### Platform capabilities

| Module | Main features | Notes |
| --- | --- | --- |
| **Recruitment** | Candidates, resume PDF/OCR, screening, interviews | Source citations; reviewed sending; optional Feishu |
| **Invoices** | Invoice number, parties, amounts, tax, items | Check against originals; open the source attachment |
| **Mailboxes** | Provider/custom IMAP/SMTP, categories, combined views | Isolation, associations, external notices |
| **Calendar & tasks** | Month/week/day, deadlines, priorities, conflicts, changes | Sources retained; workspace filters; completion checks |
| **Cases & materials** | Stages, suggestions, material versions, prerequisites | History retained; receipts for designated stages |
| **Little D** | Mail lookup, briefings, calendar/tasks, draft replies | Speech input, meeting assistance, sending review |
| **Retrieval** | Mail/attachment/resume chunks, hybrid search, highlights | RRF, MMR, bounded embedding retries |
| **Templates** | Fields, stages, rules, materials, views, capabilities | JSON import/export, upgrades, visibility, deletion |
| **Logs & cost** | Tools, errors, duration, tokens, estimated costs | Call-time prices, known totals, pricing coverage |
| **External collaboration** | External calendars (Google / Outlook / CalDAV), private ICS, event materials | Push failures do not block local writes; errors stay on the connection record |
| **Local session** | Shell one-time token and a single-user local workspace | No multi-tenancy, no admin console, loopback only |
| **Background jobs page** | Status display | Local mode shows "background jobs are not enabled in this service"; sync results appear in mail and execution records |

<a id="mailboxes"></a>
## 📬 Separate mailboxes, optional combined views

Categorize campus, personal, and work inboxes. Calendars and tasks follow the selected view; email Q&A and Little D knowledge search use that scope to find indexed notices.

<img src="docs/assets/readme/mailbox-scopes.svg" alt="Single mailbox, same-category and all-mailbox views with their retrieval scopes" width="100%" />

| View | Useful for | Retrieval scope |
| --- | --- | --- |
| **Single mailbox** | Working in one inbox | Indexed content from the current mailbox |
| **Same category** | Campus or work inboxes together | Indexed content from mailboxes sharing the tag |
| **All mailboxes** | Finding a notice when its inbox is unclear, or reviewing schedules | Indexed content from all local mailboxes |

The desktop app is a **single-user local application**, so there is no cross-user permission problem; combined views are still a read scope and never broadcast writes. Ordinary event/draft/send operations use the selected mailbox; workspaces use their bound mailboxes. Retrieval covers indexed content, not necessarily the entire mailbox history.

<a id="workflows"></a>
## 🧑‍💼 Two main workflows: recruitment and invoices

### Recruitment: from resume to interview communication

Receive application → store attachment → extract PDF text/OCR → organize candidate profile → conversational screening → prepare invitation → review and send.

Inspect candidate details, resumes, and origins; answers can reference source pages. Scans, extraction errors, and incomplete profiles require review/retry. Feishu meetings are optional and require configuration. Existing recruitment records are reused rather than duplicated when adding workspaces.

<details>
<summary>Recruitment processing diagram</summary>

<img src="docs/assets/readme/recruitment-flow.svg" alt="Recruitment flow: attachment, original kept, PDF text/OCR, candidate profile, screening and reviewed invitation" width="100%" />

</details>

### Invoices: from attachment to field checks

Find invoice attachment → extract number/date/parties/amount/tax/items → check original → prepare reimbursement materials.

Open/download originals from the invoice page. Extracted fields do not establish tax authenticity, reimbursement, or payment. Invoice recognition alone does not create calendar events or tasks.

<details>
<summary>Invoice processing diagram</summary>

<img src="docs/assets/readme/invoice-flow.svg" alt="Invoice flow: attachment, extracted fields, amount and tax, check against the original, reimbursement materials" width="100%" />

</details>

<a id="architecture"></a>
## 🏗️ Architecture

<img src="docs/assets/readme/architecture.svg" alt="Desktop local architecture: Tauri shell, bundled Node backend, local data and external services" width="100%" />

```text
Daylight Desktop (Tauri 2 app)
├─ React frontend (shadcn/ui + Tailwind)                 ← shared with Web
├─ Rust shell (src-tauri/)
│  ├─ Window / tray / single instance / close-to-tray / window state
│  ├─ System credential store (keyring) holds the encryption key, no plaintext fallback
│  ├─ Native auto-update (download / minisign verify / replace / restart)
│  └─ Starts the bundled Node backend, resolves the ready port, opens links externally
└─ Bundled Node backend (src-tauri/runtime/, shipped in the installer)  ← shared with Web
   ├─ IMAP / SMTP / models / OCR
   ├─ Calendar / tasks / mail / invoices / recruitment / Little D / logs
   └─ Local data storage (JSON by default, no database)
```

| Component | Responsibility | Technology and state |
| --- | --- | --- |
| **Desktop window** | Tray, single instance, window state, external links, update entry point | Tauri 2 (Rust), system WebView |
| **Web frontend** | Workspaces, mail, calendar, tasks, recruitment, invoices, reviews, execution records | React 19, Vite 7, Tailwind CSS 4, shadcn/Radix, FullCalendar |
| **Local backend** | Authentication, mailbox ownership, business commits, model and tool calls | Node.js 22+, Express (bundled runtime, loopback only) |
| **Local storage** | Settings, events, tasks, mail, recruitment, invoices | JSON with temp-file + rename atomic writes; `settings.json` / `infra.json` use AES-256-GCM |
| **System credential store** | Holds the data encryption key | macOS Keychain / Windows Credential Manager / Linux Secret Service |
| **External services** | Mail, models, calendars, meetings | IMAP/SMTP, OpenAI-compatible Chat Completions, embeddings, optional Feishu |
| **Update source** | Metadata for published versions | GitHub Releases `latest.json` (anonymous URL; the repository must stay public) |

### Local mode and consistency

**The default local mode connects to no PostgreSQL / Redis / RabbitMQ and listens on `127.0.0.1` only**, with synchronization happening in-process. That means no cross-process job leases or outbox: long synchronizations complete within the request, and the UI follows progress through status polling and traces. JSON writes are atomic via temporary file plus rename, but **one data directory must not be written by multiple backend processes at once**.

Email is data, not instructions. Read, prepared, sent, submitted, and acknowledged are distinct. Workspace writes require confirmation; basic email synchronization can create events/tasks from extraction results. Actual sending uses a separate review step. Invalid model output, tool failures, and ambiguity must remain visible in state and traces.

<a id="usage"></a>
## 🧭 User guide

1. **Connect email:** add a mailbox under Settings with IMAP/TLS and the provider **authorization code / app password** (not the login password). For QQ: `imap.qq.com:993` and `smtp.qq.com:465`, with IMAP/SMTP enabled in the mailbox settings first. Start with a 3–5 message sync limit.
2. **Configure models:** enter an OpenAI-compatible Chat Completions Base URL, API key, and model supporting `response_format: { type: 'json_object' }`. Optionally set an RMB unit price for cost estimates. Vector retrieval also needs embeddings; keyword search works without them.
3. **Sync and search:** sync from the mail page, then inspect categories, summaries, extracted results, and failures; answers link back to the original message and matched passage. The recent-N-message scope is not a guarantee of complete historical scanning.
4. **Add a workspace:** choose a preset, bind a mailbox, and create cases; associate notices or paste external sources, then review materials, stage suggestions, and actions.
5. **Confirm actions:** verify deadlines, zones, targets, and conflicts before writing tasks/events. Record submitted/sent/acknowledged separately. Adding a prerequisite task alone does not unlock later actions; its required receipt must be completed.
6. **Use Little D:** query, plan, or draft replies, then check recipients/body/citations and confirm sending. Saving a draft or manually recording "sent" does not send SMTP; actual sending uses review cards.
7. **Follow changes:** later updates, cancellations, and reschedules preserve sources and history, linking old and new events; traces expose duration and cost.

> A successful save or a "configured" label **only means the fields were stored**; it does not prove the mailbox or model connection works. Real connectivity requires one sync with a real mailbox and a real model.

Templates are declarative JSON, not arbitrary executable code. Deleting a workspace preserves previously written mailbox events/tasks/recruitment data; hiding an entry also preserves data. External calendar failures and unknown outcomes follow recovery contracts. Unconnected portals, payments, and submission systems cannot be marked successful automatically.

### Demo (no real mailbox or model)

The app bundles three demos built on **preset extraction results**, so the full flow works with no configuration; the UI and logs clearly label them as preset results: an event conflict and reply confirmation, create/cancel/reschedule, and mail labels with tasks. The preset demos connect to no real mailbox, call no real model, and send no real email. Clear sample data from Settings; clearing it never affects real mail or manual events.

<a id="update"></a>
## 🔄 Auto-update & releases

<img src="docs/assets/readme/update-flow.svg" alt="Auto-update trust chain: silent check, latest.json, download, signature verification, user confirmation, replace and restart" width="100%" />

### Client behavior

- About 6 seconds after launch it **silently checks** once: if current, nothing happens; only a real update raises a native dialog.
- Tray menu → "Check for updates…" checks manually and always reports a result.
- **Never a silent install:** the download starts only after you click "Download and install", the window title shows progress, and the app restarts into the new version. Local data and configuration are untouched (an update replaces only the program).
- Update logic lives **entirely in the Rust shell** (`src-tauri/src/update.rs`). Because the app page is served over loopback HTTP, it is given no channel to invoke "replace my own installation files", so an injected page cannot reach the updater.
- When the endpoint is unreachable (no public release yet, or the network is down), the plugin collapses it into `ReleaseNotFound`. The native side translates that into "no update information available yet" instead of falsely reporting a network fault; a missing installer for the current platform (`TargetNotFound`) is distinguished separately.
- `v0.1.0` is now published: a client running `0.1.0` compares as up to date and shows no dialog (an update prompt only appears once the next version is published).

### Trust chain

Update packages are minisign-signed and verified against a public key compiled into the app; a failed check refuses installation.

| Item | Location | Public? |
| --- | --- | --- |
| Public key | `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` | Committable |
| Private key | Local `work/updater-key/daylight.key` (`work/` is not committed) + GitHub secret `TAURI_SIGNING_PRIVATE_KEY` | **Never commit** |

The update endpoint is fixed at `https://github.com/yunforis/DaylightDesktop/releases/latest/download/latest.json` (matching the `repository` field in `package.json`; `desktop-tests` cross-checks this). It only resolves to **published releases**; drafts and pre-releases are never pushed to clients.

Losing the private key means no further usable updates (clients reject packages signed by a different key), so back up `work/updater-key/`.

### Publishing six-platform installers

Tagging publishes (`.github/workflows/release.yml`):

```bash
# 1. The version must match in three places, or the guard job blocks the run:
#    package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml
# 2. Commit, tag, and push
git tag v0.1.0
git push origin v0.1.0
```

You can also run the `release` workflow manually from the Actions page with a tag (created on the run's commit if it does not exist) and optionally check **"draft release only"** to build without publishing — useful for verifying that all six platforms produce artifacts. Once the draft looks right, **publish that draft straight from the Releases page**: it already holds every artifact and `latest.json`.

> ⚠️ How `guard` behaves when the same tag is dispatched again: if the Release is **still a draft** it is reused, and `target_commitish` is updated to the current run's commit — so the tag that gets created on publish points at the commit that actually built these artifacts (`v0.1.0` nearly shipped a tag two commits off, because the draft was created by an earlier run). If the tag's Release is **already published**, the whole run is **skipped** (a no-op): published artifacts must never be swapped.

> ℹ️ Publishing a draft from the Releases page makes a second `release` run appear in Actions — that is expected: publishing creates the Git tag, and this workflow is triggered by `push: tags: v*`. That run takes the "already published → skip" path and finishes green in seconds without rebuilding or touching `latest.json`.

| Platform | Runner | Rust target |
| --- | --- | --- |
| macOS Apple Silicon | `macos-14` | `aarch64-apple-darwin` |
| macOS Intel | `macos-14` (cross-build) | `x86_64-apple-darwin` |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` |
| Linux ARM64 | `ubuntu-24.04-arm` | `aarch64-unknown-linux-gnu` |
| Windows x64 | `windows-latest` | `x86_64-pc-windows-msvc` |
| Windows ARM64 | `windows-11-arm` | `aarch64-pc-windows-msvc` |

`fail-fast: false`: one platform failing does not affect the others; the release simply misses that artifact, and published versions still work on the platforms they support.

**The release is created exactly once:** the `guard` job verifies the three versions, then idempotently creates (or reuses) a single Release and outputs `releaseId`; all six build jobs upload by that id. This avoids two draft releases for one tag (the `tauri-action` tag lookup never returns drafts). After every platform succeeds, the `finalize` job rewrites the download URLs in `latest.json` to public links (`releases/download/<tag>/<file>`) — the asset API URL requires authentication and would return JSON metadata rather than the installer to a client — and re-reads the file to confirm all six platforms are present.

### GitHub secrets

| Secret | Required | Notes |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | **Yes** | The **file contents** of `work/updater-key/daylight.key`. If missing, packaging fails at the "generate updater artifacts" step — deliberately: no signature means no update should ever be published |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Optional | Key passphrase. The current key has none, so **leave it unset**: an absent value (empty string) matches a passphrase-less key, and this combination was verified to sign locally |
| `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | Optional | macOS Developer ID signing and notarization (needs a paid Apple Developer account). **Packaging still works without them**: the signing identity falls back to ad-hoc (`APPLE_SIGNING_IDENTITY=-`), the app is installable, and users allow it once under System Settings → Privacy & Security |

The workflow injects the certificate variables only when `APPLE_CERTIFICATE` is non-empty (empty variables make the Tauri bundler fail). **Without a certificate this is not "skip signing" — it degrades to ad-hoc signing**, because Tauri with no signing identity at all does **not** produce `Contents/_CodeSignature/CodeResources` for the `.app`, and macOS then reports such a bundle as "damaged and can't be opened" on Apple Silicon — users simply cannot install it (`v0.1.0` was measured to fail exactly this way). CI therefore also verifies the freshly built `.app` (requires `_CodeSignature/CodeResources` and a passing `codesign --verify --deep --strict`). A local `npm run desktop:build` also defaults to ad-hoc signing.

### The repository must stay public

The update endpoint `.../releases/latest/download/latest.json` is **anonymous**. Making the repository private returns 404 to clients and disables auto-update entirely. This cannot be worked around on the client: embedding a repository read token in the installer would let every downloader read the whole repository, and once the token expires, updates would fail for all clients at once. If the repository is private, the client does not crash — the tray reports "no update information available yet" and users can download a new installer manually from the Releases page (visible once signed in).

### Artifact requirements for Linux / Windows self-updates

- **Windows:** auto-update can only install **NSIS** (`-setup.exe`). `targets: "all"` also produces WiX (`.msi`), which the client cannot install, so `release.yml` sets `updaterJsonPreferNsis: true` to point `latest.json` at setup.exe. The `.msi` is still published for manual installs.
- **Linux:** only **AppImage** self-updates (Tauri replaces the AppImage file itself). Versions installed via `.deb` / `.rpm` do **not** auto-update — files owned by the package manager should not be replaced by the app — so those users must download and reinstall. All three formats are published, and the bundled runtime ships glibc-only native modules.

<a id="development"></a>
## 💻 Local development & packaging

Requires **Node.js 22+** (the repo has a `.nvmrc`). If you keep a Rust toolchain under `work/toolchain/` (`work/` is not committed), `npm run desktop:*` uses it automatically; **on a new machine you must install Rust yourself**.

```bash
nvm use            # switch to the Node version in .nvmrc
npm install
npm run desktop:dev   # dev: Tauri window + frontend HMR + Node backend
```

The window opens straight into the `/app` workspace, **with no registration or login**.

### Command reference

| Command | Purpose |
| --- | --- |
| `npm run desktop:dev` | Dev desktop window (backend on fixed port 14321) |
| `npm run dev` | Browser-only frontend debugging at `http://127.0.0.1:3000` (redirects to `/app`) |
| `npm run build` | Build frontend assets into `dist/` |
| `npm run desktop:prepare` | Generate the bundled Node runtime in `src-tauri/runtime/` |
| `npm run desktop:check` | `cargo check` for the Rust shell |
| `npm run desktop:build` | Package installers (runs build + prepare first) |
| `npm test` | Shared business tests (`server/*.test.js`) |
| `npm run test:desktop` | Desktop-specific tests (`desktop-tests/`) |
| `node scripts/desktop-sync.mjs` | Re-sync business code from the Daylight source of truth and re-apply desktop patches |
| `bash work/smoke.sh` | Backend smoke test (production mode / no PG / loopback only / auth boundaries) |

### Packaging prerequisites

`npm run desktop:build` is one command but not zero-prerequisite:

- **Node.js 22+** (build time only; the installer carries its own Node copy, so end users need none).
- **Rust toolchain** (`rustup` plus the local target). `scripts/desktop.mjs` uses `work/toolchain/` when present and falls back to the system `cargo`.
- **Linux** also needs system libraries: `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf`.
- **Windows** needs MSVC build tools and the WebView2 runtime (installers use `downloadBootstrapper` to install WebView2 automatically).

**Cross-arch packaging:** since the installer bundles Node, the bundled Node architecture must match the installer architecture. Set the target with `DAYLIGHT_TARGET_TRIPLE` (the script fetches the matching official Node build from nodejs.org and installs native modules with `npm install --os/--cpu`):

```bash
DAYLIGHT_TARGET_TRIPLE=x86_64-apple-darwin npm run desktop:prepare
```

That is exactly how the Intel Mac build is cross-built on Apple Silicon (`x86_64-apple-darwin`) — GitHub no longer provides x64 macOS runners.

**The bundled runtime contains only the target platform's native modules:** `scripts/prepare-desktop.mjs` prunes other platforms' native packages using lock-file metadata and re-confirms with an independent `package.json`-based check. This came from a real CI defect: `@napi-rs/canvas` platform packages declare no `libc` field, so npm installs both the gnu and musl variants; linuxdeploy then runs `ldd` on every ELF in the AppDir, dies on the musl one, and aborts AppImage packaging (deb/rpm are unaffected). Linux now ships glibc only.

### Build outputs

```bash
# Updater artifacts must be signed; the variable takes the key file's *contents*.
# Passing a path makes the bundler base64-decode the path itself and fail.
TAURI_SIGNING_PRIVATE_KEY="$(cat work/updater-key/daylight.key)" npm run desktop:build
```

Artifacts appear under `src-tauri/target/release/bundle/`:

- macOS: `macos/Daylight.app` (runnable directly), `dmg/Daylight_0.1.0_<arch>.dmg`, plus `macos/Daylight.app.tar.gz` + `.sig` for auto-update
- Windows / Linux: run the same command on the matching platform; artifacts land in the respective bundle directories (including updater `.sig` files)

Installers already contain the Node binary, backend code, frontend assets, and runtime dependencies, so end users install nothing. macOS is built separately for arm64 and x64, without a universal binary. Producing updater artifacts requires the signing key (`TAURI_SIGNING_PRIVATE_KEY`); if it is missing, packaging fails at the "generate updater artifacts" step — deliberately, since an unsigned update must not be published.

If a port is occupied, change it in dev mode:

```bash
PORT=3001 npm run desktop:dev        # macOS / Linux
$env:PORT='3001'; npm run desktop:dev  # PowerShell
```

<a id="sync"></a>
## 🧬 Syncing with upstream

The desktop app shares `src/`, `server/`, `shared/`, `public/`, and `scripts/` with the Web version. When the Web side moves forward:

```bash
# Recommended: export the source of truth's committed HEAD as a clean baseline
git -C ../Daylight archive HEAD | tar -x -C work/web-head
DAYLIGHT_WEB_DIR="$PWD/work/web-head" node scripts/desktop-sync.mjs --check   # validate patch anchors first
DAYLIGHT_WEB_DIR="$PWD/work/web-head" node scripts/desktop-sync.mjs

node scripts/desktop-sync.mjs            # defaults to ../Daylight (reads its working tree, including uncommitted edits)
DAYLIGHT_WEB_DIR=/path/to/Daylight node scripts/desktop-sync.mjs
```

The script copies the upstream shared tree, removes Web-only pages, re-applies desktop patches one by one (exact string replacement that fails fast when an anchor is missing), and validates that the runtime dependency allowlist covers every bare import under `server/`.

**Why export HEAD instead of reading the working tree:** upstream is under continuous development and often holds half-written files. A straight tree copy would drag those uncommitted edits into the desktop repo and make "which upstream commit does this correspond to?" unanswerable. `git archive HEAD` yields a reproducible commit snapshot.

`Dockerfile` and `docs/submission/evaluation-cases.json` are in the sync list **only because the shared test suite reads them**; the desktop app does not use container deployment or submit competition materials.

**Desktop-owned files are unaffected by sync:** `src/App.jsx`, `src/lib/desktop.js`, `server/desktop-entry.js`, `server/desktop-http.js`, `server/secure-json.js`, `src-tauri/**`, `scripts/desktop*.mjs`, `scripts/prepare-desktop.mjs`, `desktop-tests/**`. The patch list and rationale live in `STATUS.md`, guarded by an anchor self-check test in `desktop-tests`.

<a id="evidence"></a>
## 📊 Verification, boundaries & delivery

These commands are the repository's verification entry points:

```bash
npm test              # shared business tests (server/*.test.js)
npm run test:desktop  # desktop-specific tests (desktop-tests/)
npm run build         # frontend build
npm run desktop:check # Rust shell check
bash work/smoke.sh    # backend smoke test (production mode / no PG / loopback only / auth boundaries)
```

- **Desktop-specific tests** cover: startup and restart without PG/Redis/MQ, the three-layer auth boundary, one-time sessions, credentials encrypted at rest, port fallback, patch-anchor self-checks, offline pdf.js assets and rendering a self-produced PDF, one-to-one mapping between the release matrix and bundled Node architectures, **whole-bundle macOS signing (an unsigned bundle is reported as "damaged" on Apple Silicon)**, updater configuration plus the native-side flow, Windows PATH key casing, cross-platform legality of frontend asset filenames, a bundled runtime containing only the target platform's native modules, `latest.json` URL rewriting with six-platform completeness, and a packaging runtime (without `vite`) starting standalone. **15 tests, all passing.**
- **Shared business tests** total **680**: 587 pass / 58 fail / 35 skipped, **identical case by case** to the Web source of truth (this round's sync introduced zero differences). The failures are legacy integration tests that start a real Express server with mocked timers, not something the desktop fork introduced; the step is `continue-on-error` in `.github/workflows/desktop.yml`.
- **CI gate:** `.github/workflows/desktop.yml` runs verify on Linux / Windows / macOS (including the 14 mandatory desktop tests and `cargo check`); all three platforms are currently green.
- Every write-based test uses an isolated data directory under `work/` and never touches user data.

### Known boundaries

- **Six-platform packaging and a real public release are verified; on-device launch is not:** installers for all six targets have been **built for real** on GitHub-hosted runners (macOS `.dmg`/`.app.tar.gz`, Windows NSIS `-setup.exe`/`.msi`, Linux `AppImage`/`.deb`/`.rpm`, each with `.sig`). Every release-pipeline defect found along the way has been fixed with tests: concurrent duplicate Release creation, `latest.json` pointing at an authenticated asset API URL, a reused draft keeping a stale `target_commitish` (so the tag did not match the artifacts), and the subtlest one — **publishing a draft creates the Git tag, which re-triggered this very workflow and rewrote the published artifacts** (it swapped the Linux assets for fresh builds and left `latest.json` mid-run with 12 keys pointing at the asset API, so clients downloaded JSON). After the fixes, a full round finished green (version guard + all six platform jobs + `latest.json` rewrite) and **`v0.1.0` was published on 2026-10-18 (Beijing time)** with the tag on the build commit `467ddd2`; all 18 `latest.json` keys are public URLs, the six required platforms are present, all 12 referenced artifacts carry a `.sig`, the public update endpoint is anonymously reachable (HTTP 200) and downloads real binaries, and the publish-triggered second workflow run was measured at 11 seconds, ending in "skipped" without touching a single artifact. However, **the app has never been launched on a real Windows or Linux machine**: `src-tauri/src/main.rs` and `scripts/prepare-desktop.mjs` contain genuine platform branches and the dependency list records prebuilt packages for every platform. This is therefore **implemented plus build- and release-verified**, not **verified on device**. Full records in [STATUS.md](STATUS.md).
- **Auto-update is not verified end to end:** locally we verified that the app's embedded public key accepts the signed updater artifact and rejects a 1-byte tamper (with a negative control), but the full **download → verify → replace installation → restart** chain needs two real published versions, which this round did not do. On Linux it additionally depends on the AppImage form.
- **macOS packages are ad-hoc signed but not Developer ID signed or notarized:** without `APPLE_*` certificates the build degrades to ad-hoc signing — which is **required**, because a bundle with no signing identity at all is reported as "damaged and can't be opened" on Apple Silicon (`v0.1.0` was measured to hit exactly that; see the download note above). Ad-hoc signing makes the app usable, but users still allow it once under System Settings → Privacy & Security. With `APPLE_*` secrets configured, signing and notarization become automatic, at which point a paid Apple Developer account is required. The new CI check on the build side **has not run on GitHub Actions yet** (the next release is the first to execute it); this round verified locally that the artifacts really are whole-bundle signed, in both the DMG and the updater archive, and that they install and launch.
- **A public release exists, but end-to-end updating is still unverified:** `v0.1.0` is published (2026-10-18 Beijing time) and the public update endpoint is anonymously reachable; the **download → verify → replace installation → restart** chain needs **two** published versions, and this round published only the first.
- **Single-user local application:** no multi-tenancy, no admin console, no cloud account. The backend listens on loopback only, and **one data directory must not be written by multiple backend processes at once** (JSON plus in-process coordination).
- **No persistent background job queue in local mode:** long synchronizations complete within the request, and the UI follows progress through status polling and traces.
- **Real services require your own connectivity check:** IMAP / SMTP / model / Feishu / external calendar availability depends on your accounts and network. This round did not verify a live mailbox or live model connection; preset demos and local mock API tests **do not** constitute real-service verification.
- **Fonts:** `index.html` still pulls Noto Sans SC / Sora / Space Grotesk from `fonts.googleapis.com`. Offline or restricted networks fall back to system fonts (PingFang on macOS); layout stays intact but glyphs differ slightly from the connected Web version. Fonts are not bundled, to avoid installer bloat and font-license spread.
- **Sleep and wake:** the shell does not listen for system wake events. The backend Node process keeps running after wake, and scheduled sync plus idle mail watches fire on the next cycle; the wake path has not been tested locally.

<a id="structure"></a>
## 📁 Repository map

```text
DaylightDesktop/
├── src/                        # Shared pages, components, workspace state
├── server/                     # Shared API and business logic
│   ├── desktop-entry.js        # Desktop backend entry (started by the bundled runtime)
│   ├── desktop-http.js         # Loopback listener, Host/Origin/session checks
│   ├── secure-json.js          # Encrypted settings and infrastructure config
│   └── index.js                # Web / browser dev entry
├── shared/                     # Shared templates and definitions
├── scripts/                    # Sync, runtime preparation, desktop dev/build scripts
├── desktop-tests/              # Desktop-specific tests (15)
├── src-tauri/                  # Rust shell, Tauri config, bundled Node runtime, bundle resources
│   ├── src/                    # main.rs, update.rs, ...
│   ├── tauri.conf.json         # Window, bundle, update endpoint and public key
│   └── runtime/                # Bundled Node + backend code (build output, not committed)
├── .github/workflows/          # desktop.yml (3-platform verify), release.yml (6-platform release)
├── docs/resume-test/           # Recruitment test fixtures
├── docs/invoice-test/          # Invoice test fixtures
├── docs/assets/readme/         # README diagrams (hand-authored SVG + generator)
├── STATUS.md                   # Implemented features, verification results, boundaries
└── AGENTS.md                   # Development conventions
```

<a id="roadmap"></a>
## 🗺️ Progress & roadmap

| Area | Current scope | Next steps |
| --- | --- | --- |
| **Install & update** | Six-platform installers built in CI; `v0.1.0` published; updater framework and trust chain implemented | Publish a second version and verify download → verify → replace → restart once |
| **On-device verification** | macOS development and packaging verified locally | Launch on real Windows / Linux machines and run the main flows |
| **Signing & notarization** | Ad-hoc signed packages install (with a manual allow on first launch) | Configure an Apple Developer account and complete macOS signing/notarization |
| **Feature parity** | Business code shared with the Web version and synced per round | Follow upstream evolution while keeping per-case test status identical |
| **Desktop experience** | Tray, single instance, window state, offline PDF, port fallback | Wake handling, offline fonts, more real-device details |
| **Data & multi-device** | Local JSON storage, encrypted credentials | Optional encrypted local backups and a migration path between machines |

This is direction, not a release-date promise or completed acceptance. The desktop app is not distributed through the Web repository's Docker image; its installers come from this repository's release pipeline.

<a id="contributing"></a>
## 🤝 Contributing

Help with bugs, documentation, representative mail formats, privacy-safe scenario templates, translations, and UI improvements. Read the [development conventions](AGENTS.md) first.

- **Questions and bugs:** [Issues](https://github.com/yunforis/DaylightDesktop/issues), with version, platform, reproduction steps, expected/actual behavior, and sanitized logs (`backend.log` and traces). Never attach authorization codes or mail bodies.
- **Code changes:** explain the problem and how you validated it. Business code changes belong in the [Daylight source of truth](https://github.com/why121368/Daylight) and reach the desktop app through `desktop-sync.mjs`; do not edit shared directories directly.
- **Templates and scenarios:** describe users, real steps, external dependencies, and required confirmations, without private mail.
- **Sensitive reports:** do not publish credentials or exploitable details in public Issues; use a private channel provided by maintainers.

## 🛡️ Data, licensing & feedback

Mail bodies, attachments, and credentials live in the local data directory (`settings.json` and `infra.json` are encrypted). **Model analysis sends relevant context to the provider you configure**, so review its data-handling terms. Do not commit `data/`, the update private key, real authorization codes, or unauthorized logs and screenshots.

The update signing key (`work/updater-key/`) and the GitHub secret are the root of trust for this distribution chain: losing the private key means no further usable updates, and leaking it lets anyone sign an update the clients would accept. Protect both.

Report issues and scenario proposals through [Issues](https://github.com/yunforis/DaylightDesktop/issues). No LICENSE file is currently provided; maintainers must clarify usage/distribution terms separately.

<div align="center">
  <br />
  <strong>Daylight Desktop · Turn messages into next steps.</strong>
  <p>Find your mail. Keep track of what comes next.</p>
</div>
