/**
 * 桌面端专有行为测试。
 *
 * 与 Web 共享的业务测试（`npm test` → server/*.test.js）分开：这里只覆盖「桌面端交付形态」
 * 才存在的问题——无 PG/Redis/MQ 的启动、本地会话与鉴权边界、凭据落盘加密、端口回退、
 * 优雅关闭、打包运行时不含 vite 也能启动，以及补丁锚点自检。
 *
 * 运行：npm run test:desktop
 * 所有写入都在 work/ 下的临时目录，不触碰用户数据目录。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORK = path.join(ROOT, 'work');
const RUNTIME = path.join(ROOT, 'src-tauri', 'runtime');
fs.mkdirSync(WORK, { recursive: true });

const children = new Set();
after(() => {
  for (const child of children) {
    if (child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
    }
  }
});

function temporaryDataDir(label) {
  return fs.mkdtempSync(path.join(WORK, `desktop-test-${label}-`));
}

function startBackend({
  dataDir,
  token = randomBytes(32).toString('hex'),
  masterKey = randomBytes(32).toString('hex'),
  port = 0,
  extraEnv = {},
  cwd = ROOT,
  nodeBin = process.execPath,
  args = ['server/desktop-entry.js', '--production'],
}) {
  const child = spawn(nodeBin, args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DAYLIGHT_DATA_DIR: dataDir,
      DAYLIGHT_DESKTOP: '1',
      DAYLIGHT_DESKTOP_TOKEN: token,
      DAYLIGHT_MASTER_KEY: masterKey,
      PORT: String(port),
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  const state = { child, port: 0, log: '', dataDir, token, masterKey };
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`后台启动超时：\n${state.log}`)), 60_000);
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      state.log += chunk;
      buffer += chunk;
      const match = buffer.match(/DAYLIGHT_READY (\d+)/);
      if (match) {
        clearTimeout(timer);
        state.port = Number(match[1]);
        resolve(state);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { state.log += chunk; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`后台提前退出 code=${code}：\n${state.log}`));
    });
  });
  return { state, ready };
}

async function stopBackend(state) {
  if (state.child.exitCode !== null) return state.child.exitCode;
  const exited = new Promise((resolve) => state.child.once('exit', (code) => resolve(code ?? -1)));
  state.child.stdin.end('shutdown\n');
  const code = await exited;
  children.delete(state.child);
  return code;
}

/** 原始路径请求（不经 URL 归一化），用于校验回环 Host 限制。 */
function rawRequest(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

/** 按原始路径请求（不做 URL 归一化），用于校验静态目录的越权防护。 */

async function call(port, pathname, { method = 'GET', cookie, bearer, origin, body, headers = {} } = {}) {
  const merged = { ...headers };
  if (cookie) merged.cookie = cookie;
  if (bearer) merged.authorization = `Bearer ${bearer}`;
  if (origin) merged.origin = origin;
  const init = { method, headers: merged, redirect: 'manual' };
  if (body !== undefined) {
    merged['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: response.status, json, text, location: response.headers.get('location') };
}

/** 模拟原生壳层：一次性 token 换 cookie，再用 cookie 换业务 JWT。 */
async function bootstrapRaw(port, token) {
  const start = await fetch(`http://127.0.0.1:${port}/desktop/start?token=${token}`, { redirect: 'manual' });
  const cookie = start.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const session = await call(port, '/desktop/session', { cookie });
  return { start, cookie, session, jwt: session.json?.token };
}

test('无 PostgreSQL / Redis / RabbitMQ 也能启动，并完成「同步 → 落盘加密 → 重启读回」闭环', async () => {
  const dataDir = temporaryDataDir('boot');
  const repoDataBefore = fs.existsSync(path.join(ROOT, 'data'))
    ? fs.statSync(path.join(ROOT, 'data')).mtimeMs
    : null;
  const { state, ready } = startBackend({ dataDir });
  await ready;
  assert.ok(state.port > 0, '必须报告实际监听端口');
  assert.match(state.log, /DAYLIGHT_READY \d+/);

  const { cookie, jwt } = await bootstrapRaw(state.port, state.token);
  assert.ok(jwt, '必须签发本地 owner 会话');

  const initial = await call(state.port, '/api/state', { cookie, bearer: jwt });
  assert.equal(initial.status, 200);

  const synced = await call(state.port, '/api/sync/demo', { method: 'POST', cookie, bearer: jwt });
  assert.equal(synced.status, 200);
  assert.ok(synced.json.added >= 1, `示例导入应产生日程：${synced.text}`);

  const afterSync = await call(state.port, '/api/state', { cookie, bearer: jwt });
  assert.ok(afterSync.json.events.length >= 1, '同步后应有日程');

  const saved = await call(state.port, '/api/settings', {
    method: 'PUT',
    cookie,
    bearer: jwt,
    body: { model: 'desktop-test-model', apiKey: 'sk-DESKTOP-SECRET-KEY' },
  });
  assert.equal(saved.status, 200, saved.text);

  const rawSettings = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');
  assert.match(rawSettings, /daylight-encrypted-v1/, 'settings 必须密文落盘');
  assert.ok(!rawSettings.includes('sk-DESKTOP-SECRET-KEY'), '模型 Key 不得以明文出现在磁盘');

  const stateAfter = await call(state.port, '/api/state', { cookie, bearer: jwt });
  assert.equal(stateAfter.json.settings.model, 'desktop-test-model');

  assert.equal(await stopBackend(state), 0, 'shutdown 后应正常退出');

  // 用同一个数据目录重新启动：验证真实的重启读回（不耦合具体文件布局）。
  const restarted = startBackend({ dataDir, token: state.token, masterKey: state.masterKey });
  await restarted.ready;
  const revivedSession = await bootstrapRaw(restarted.state.port, restarted.state.token);
  const revived = await call(restarted.state.port, '/api/state', {
    cookie: revivedSession.cookie,
    bearer: revivedSession.jwt,
  });
  assert.equal(revived.status, 200, revived.text);
  assert.ok(revived.json.events.length >= 1, '重启后日程必须仍然存在');
  assert.equal(revived.json.settings.model, 'desktop-test-model', '重启后设置必须仍然存在');
  assert.equal(await stopBackend(restarted.state), 0);

  if (repoDataBefore !== null) {
    assert.equal(fs.statSync(path.join(ROOT, 'data')).mtimeMs, repoDataBefore, '不得写入仓库 data/ 目录');
  }
});

test('鉴权边界：回环 Host + 壳层 cookie + Bearer 三层缺一不可', async () => {
  const dataDir = temporaryDataDir('auth');
  const { state, ready } = startBackend({ dataDir });
  await ready;
  const { cookie, jwt } = await bootstrapRaw(state.port, state.token);

  assert.equal((await call(state.port, '/api/state')).status, 403, '没有壳层 cookie 必须 403');
  assert.equal((await call(state.port, '/api/state', { cookie })).status, 401, '有 cookie 无 Bearer 必须 401');
  assert.equal((await call(state.port, '/api/state', { cookie, bearer: jwt })).status, 200);
  assert.equal(
    (await call(state.port, '/api/state', { cookie, bearer: jwt, origin: 'https://evil.example' })).status,
    403,
    '跨源必须 403',
  );
  assert.equal(
    await rawRequest(state.port, '/api/state', { host: 'evil.example:1234' }),
    403,
    'Host 不是 127.0.0.1 必须 403',
  );

  // 去管理端：管理接口在桌面模式下不可达（保留代码，仅屏蔽路由）。
  assert.equal((await call(state.port, '/api/admin/overview', { cookie, bearer: jwt })).status, 404);
  assert.equal((await call(state.port, '/api/admin/users', { cookie, bearer: jwt })).status, 404);
  // 未知接口返回 404 JSON，不能是 500。
  const missing = await call(state.port, '/api/nope', { cookie, bearer: jwt });
  assert.equal(missing.status, 404);
  assert.ok(missing.json?.error, '未知接口应返回 JSON 错误');

  assert.equal(await stopBackend(state), 0);
});

test('桌面会话引导是一次性的：token 重放被拒绝', async () => {
  const dataDir = temporaryDataDir('session');
  const { state, ready } = startBackend({ dataDir });
  await ready;

  const first = await bootstrapRaw(state.port, state.token);
  assert.equal(first.start.status, 302);
  assert.equal(first.start.headers.get('location'), '/app');
  assert.match(first.cookie, /^daylight-desktop=/);
  assert.equal(first.session.json.desktop, true);
  assert.ok(first.jwt, '必须签发本地 owner 会话');

  const replay = await call(state.port, `/desktop/start?token=${state.token}`);
  assert.equal(replay.status, 403, '已引导过的 token 不能再次使用');

  const wrong = await call(state.port, '/desktop/start?token=deadbeef');
  assert.equal(wrong.status, 403);

  assert.equal(await stopBackend(state), 0);
});

test('凭据加密落盘可无损读回，密文不含明文子串', async () => {
  const dataDir = temporaryDataDir('secure');
  const masterKey = randomBytes(32).toString('hex');
  const previousDir = process.env.DAYLIGHT_DATA_DIR;
  const previousKey = process.env.DAYLIGHT_MASTER_KEY;
  process.env.DAYLIGHT_DATA_DIR = dataDir;
  process.env.DAYLIGHT_MASTER_KEY = masterKey;
  try {
    const { readSecureJson, writeSecureJson } = await import('../server/secure-json.js');
    const file = path.join(dataDir, 'settings.json');
    const payload = { apiKey: 'sk-ROUNDTRIP-键', mailboxes: [{ id: 'm1', authorizationCode: 'IMAP-AUTH-CODE' }] };
    writeSecureJson(file, payload);

    const raw = fs.readFileSync(file, 'utf8');
    assert.match(raw, /daylight-encrypted-v1/);
    assert.ok(!raw.includes('IMAP-AUTH-CODE'));
    assert.ok(!raw.includes('sk-ROUNDTRIP-键'));
    assert.deepEqual(readSecureJson(file), payload);

    const mode = fs.statSync(file).mode & 0o777;
    if (process.platform === 'win32') {
      // Windows 没有 POSIX 权限位：Node 对普通文件恒报 0o666，`{ mode: 0o600 }` 会被忽略
      // （实测 CI：expected 384 / actual 438）。这一侧的保护来自两处，都无法用 fs.stat 断言：
      // 主密钥存进 Windows 凭据管理器（内容加密）与 %APPDATA% 目录继承的 ACL。
      // 这里不假装能验证 ACL，只把「Windows 上这行断言没有意义」钉住，避免以后又被当成回归。
      assert.equal(mode, 0o666, 'Windows 上没有 POSIX 权限位，Node 恒报 0o666');
    } else {
      assert.equal(mode, 0o600, '密文文件权限必须是 0600');
    }

    // 没有主密钥时必须明确失败，绝不静默降级为明文。
    delete process.env.DAYLIGHT_MASTER_KEY;
    assert.throws(() => readSecureJson(file), /桌面应用解锁/);
  } finally {
    if (previousDir === undefined) delete process.env.DAYLIGHT_DATA_DIR; else process.env.DAYLIGHT_DATA_DIR = previousDir;
    if (previousKey === undefined) delete process.env.DAYLIGHT_MASTER_KEY; else process.env.DAYLIGHT_MASTER_KEY = previousKey;
  }
});

test('首选端口被占用时回退到随机端口，功能不受影响', async () => {
  const occupant = http.createServer((_req, res) => res.end('occupied'));
  await new Promise((resolve) => occupant.listen(0, '127.0.0.1', resolve));
  const busyPort = occupant.address().port;

  const dataDir = temporaryDataDir('port');
  const { state, ready } = startBackend({ dataDir, port: busyPort });
  try {
    await ready;
    assert.notEqual(state.port, busyPort, '必须回退到其他端口而不是直接打不开');
    const { cookie, jwt } = await bootstrapRaw(state.port, state.token);
    assert.equal((await call(state.port, '/api/state', { cookie, bearer: jwt })).status, 200);
    assert.equal(await stopBackend(state), 0);
  } finally {
    await new Promise((resolve) => occupant.close(resolve));
  }
});

test('补丁锚点自检：重新基线时桌面补丁不能被静默丢弃', () => {
  const index = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert.match(index, /mountDesktopHttp\(app\)/);
  assert.match(index, /import \{ mountDesktopHttp \} from '\.\/desktop-http\.js'/);
  assert.match(index, /DAYLIGHT_READY/);
  assert.match(index, /await import\('vite'\)/, 'vite 必须是动态导入');
  assert.ok(!/^import .*from 'vite'/m.test(index), 'vite 不得被静态导入（安装版运行时没有 vite）');
  assert.match(index, /app\.use\('\/api\/admin'/, '桌面模式必须屏蔽管理端路由');
  assert.match(index, /EADDRINUSE/);

  const auth = fs.readFileSync(path.join(ROOT, 'server', 'auth.js'), 'utf8');
  assert.match(auth, /export async function issueDesktopAuth/);
  assert.match(auth, /DAYLIGHT_DESKTOP !== '1'/);

  const store = fs.readFileSync(path.join(ROOT, 'server', 'store.js'), 'utf8');
  assert.match(store, /readSecureJson/);
  assert.match(store, /writeSecureJson/);

  const infra = fs.readFileSync(path.join(ROOT, 'server', 'infra', 'config.js'), 'utf8');
  assert.match(infra, /const DESKTOP = process\.env\.DAYLIGHT_DESKTOP === '1'/);
  assert.match(infra, /enabled: !DESKTOP/);

  // 去登录化：桌面端不应再存在 Landing/登录/管理端页面。
  for (const gone of ['src/pages/landing-page.jsx', 'src/pages/login-page.jsx', 'src/pages/admin-page.jsx', 'src/components/admin-shell.jsx']) {
    assert.ok(!fs.existsSync(path.join(ROOT, gone)), `${gone} 不应存在于桌面端`);
  }
  const app = fs.readFileSync(path.join(ROOT, 'src', 'App.jsx'), 'utf8');
  assert.match(app, /<Navigate to="\/app" replace \/>/, '根路径必须直接进工作区');
  assert.ok(!/RequireAdmin/.test(app), '桌面端不应有管理端路由守卫');

  // PDF 预览复用上游的 pdf.js canvas 查看器（专为「宿主没有内置 PDF 查看器」而写），
  // 桌面端不再维护自己的实现；离线可用依赖打包进产物的 CMap / 标准字体 / wasm。
  // 壳层加载页受 tauri.conf.json 的 CSP 约束；应用页由回环 HTTP 提供，
  // 安全边界是 Host/Origin/cookie 校验（见 desktop-http.js），这里只做两条防御性检查。
  const csp = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')).app.security.csp;
  assert.match(csp, /worker-src[^;]*(?:'self'|blob:)/, 'pdf.js 使用同源 module worker');
  assert.match(csp, /connect-src[^;]*data:/, '小体积 CMap 会被内联成 data: URL，连接源需放行');
  assert.ok(!/unsafe-eval/.test(csp), 'CSP 不应放开 unsafe-eval');
});

test('PDF 预览：离线资源随包分发，且应用自产 PDF 能渲染出中文', async (t) => {
  // 上游查看器用 import.meta.glob 把 pdfjs 的 CMap/标准字体/wasm 打进产物（小文件会被内联成 data: URL）。
  if (!fs.existsSync(path.join(ROOT, 'dist', 'assets'))) {
    t.diagnostic('尚未执行 npm run build，跳过产物检查');
  } else {
    const assets = fs.readdirSync(path.join(ROOT, 'dist', 'assets'));
    assert.ok(assets.some((name) => name.startsWith('UniGB-UCS2-H') && name.endsWith('.bcmap')), '中文 CMap 必须随包分发');
    assert.ok(assets.some((name) => name.endsWith('.wasm')), 'pdf.js 的 wasm 解码器必须随包分发');
    assert.ok(assets.some((name) => name.startsWith('pdf.worker.min')), 'pdf.js worker 必须随包分发');
    assert.ok(assets.some((name) => name.startsWith('pdf-preview') && name.endsWith('.js')), 'PDF 预览组件必须打进产物');
  }

  const preview = fs.readFileSync(path.join(ROOT, 'src', 'components', 'pdf-preview.jsx'), 'utf8');
  assert.match(preview, /isEvalSupported: false/, '桌面端 CSP 无 unsafe-eval，必须关掉 eval 路径');
  assert.match(preview, /useWorkerFetch: false/, '资源由主线程取回后交给 worker，避免 worker 直连受限');
  assert.match(preview, /BinaryDataFactory/, '离线部署必须自带 CMap/字体/wasm 的取数实现');

  // 应用自己生成的简历 PDF 使用 STSong-Light + /Encoding /UniGB-UCS2-H（非嵌入中文 CID 字体），
  // 必须同时提供 cMapUrl 与 standardFontDataUrl，否则中文字形取不到、页面渲染不出来。
  const { demoResumePdf } = await import('../server/pdf.js');
  const bytes = await demoResumePdf({
    personal: { name: '周雨桐', email: 'candidate@example.invalid', currentCity: '上海' },
    intent: { positions: ['软件开发工程师'], cities: ['上海'] },
    skills: ['React', 'Node.js'],
  });
  assert.ok(bytes.length > 1_000, '演示简历 PDF 必须生成成功');

  const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: `${pdfRoot}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${pdfRoot}/standard_fonts/`,
    wasmUrl: `${pdfRoot}/wasm/`,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  assert.equal(doc.numPages, 1);

  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const flat = content.items.map((item) => item.str || '').join('');
  assert.ok(flat.includes('周雨桐'), `中文必须能正确解码，实际文本：${flat.slice(0, 40)}`);

  const viewport = page.getViewport({ scale: 1 });
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
  // A4 缩放 1 时画布只有 595×842，正文是深灰而非纯黑，因此按「非白像素」计数。
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let inked = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] < 240 || pixels[index + 1] < 240 || pixels[index + 2] < 240) inked += 1;
  }
  assert.ok(inked > 5_000, `页面必须真的画出内容（含中文字形），实际非白像素 ${inked}`);
});

/**
 * 发布矩阵与内置 Node 架构映射必须一一对应。
 *
 * 这条测试守的是一个很难在本地发现、但在真机上必炸的错误：安装包架构与内置 Node 架构不一致。
 * 我们把 Node 二进制打进安装包，所以「矩阵里新增/改名一个目标」必须同时在
 * prepare-desktop.mjs 的 TRIPLES 里有对应项，否则打包脚本会静默退回「复制本机 Node」，
 * 产出一个架构错配的包。
 */
test('发布矩阵与内置 Node 架构映射一一对应', () => {
  const release = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const rows = [...release.matchAll(/\{\s*name:\s*([\w-]+),\s*os:\s*([\w.-]+),\s*target:\s*([\w-]+)\s*\}/g)]
    .map((match) => ({ name: match[1], os: match[2], target: match[3] }));
  assert.equal(rows.length, 6, '发布矩阵应覆盖 macOS arm64/x64、Linux x64/arm64、Windows x64/arm64 六个目标');

  const prepare = fs.readFileSync(path.join(ROOT, 'scripts', 'prepare-desktop.mjs'), 'utf8');
  const mapping = new Map(
    [...prepare.matchAll(/'([\w-]+)':\s*\{\s*os:\s*'(\w+)',\s*cpu:\s*'(\w+)',\s*dist:\s*'([\w-]+)',\s*ext:\s*'([\w.]+)'\s*\}/g)]
      .map((match) => [match[1], { os: match[2], cpu: match[3], dist: match[4], ext: match[5] }]),
  );

  for (const row of rows) {
    const spec = mapping.get(row.target);
    assert.ok(spec, `prepare-desktop.mjs 缺少目标 ${row.target} 的映射；缺了会打包出架构错配的安装包`);
    const expectedCpu = row.name.endsWith('-arm64') ? 'arm64' : 'x64';
    assert.equal(spec.cpu, expectedCpu, `${row.name} 的架构与 ${row.target} 的映射不一致`);
    // Node 官方发行版把 Windows 叫 win、macOS 叫 darwin；这个名字错了会下载到不存在的文件。
    const nodeOs = { darwin: 'darwin', win32: 'win', linux: 'linux' }[spec.os];
    assert.ok(nodeOs, `未知的目标系统 ${spec.os}`);
    assert.equal(spec.dist, `${nodeOs}-${spec.cpu}`, `${row.target} 的 Node 发行版名不对`);
    assert.equal(spec.ext, spec.os === 'win32' ? 'zip' : 'tar.gz', 'Windows 用 zip，其余用 tar.gz');
  }

  // 交叉构建至少要覆盖 Intel Mac：GitHub 已无 x64 macOS runner，只能在 Apple Silicon 上交叉打包。
  const macX64 = rows.find((row) => row.name === 'macos-x64');
  assert.ok(macX64, '发布矩阵必须包含 Intel Mac 产物');
  assert.equal(macX64.target, 'x86_64-apple-darwin');
  assert.ok(['macos-14', 'macos-15'].includes(macX64.os), 'Intel Mac 需在 Apple Silicon runner 上交叉构建');

  for (const required of ['tauri-apps/tauri-action@v1', 'uploadUpdaterJson: true', 'updaterJsonPreferNsis: true', 'TAURI_SIGNING_PRIVATE_KEY', 'DAYLIGHT_TARGET_TRIPLE']) {
    assert.ok(release.includes(required), `release.yml 缺少 ${required}`);
  }
  // Windows 的自动更新只能装 NSIS；不显式选 NSIS 就会把装不上的 .msi 写进 latest.json。
  assert.ok(!release.includes('tauri-apps/tauri-action@v0'), '请使用当前的 tauri-action v1');
});

test('自动更新：签名公钥、发布源与原生侧流程都已接好', () => {
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.equal(conf.bundle.createUpdaterArtifacts, true, '必须生成更新产物与签名，否则客户端无法自动更新');

  const updater = conf.plugins?.updater;
  assert.ok(updater, 'tauri.conf.json 必须配置 plugins.updater');
  // 公钥可以公开；对应的私钥只能存在于本机与 GitHub Secrets（TAURI_SIGNING_PRIVATE_KEY）。
  assert.match(
    Buffer.from(updater.pubkey, 'base64').toString('utf8'),
    /minisign public key/,
    'pubkey 必须是 tauri signer 生成的 minisign 公钥',
  );
  assert.equal(updater.endpoints.length, 1);
  const repositoryField = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).repository;
  const repository = typeof repositoryField === 'string' ? repositoryField : repositoryField?.url ?? '';
  assert.ok(repository, 'package.json 需要 repository 字段，用来和更新源交叉校验');
  assert.ok(
    updater.endpoints[0].startsWith(repository.replace(/\.git$/, '')),
    `更新源 ${updater.endpoints[0]} 必须指向本仓库的发布页`,
  );
  assert.match(updater.endpoints[0], /^https:\/\//, '更新源必须是 HTTPS');
  assert.match(updater.endpoints[0], /releases\/latest\/download\/latest\.json$/, '更新源必须是正式版发布页的 latest.json');

  const cargo = fs.readFileSync(path.join(ROOT, 'src-tauri', 'Cargo.toml'), 'utf8');
  assert.match(cargo, /^tauri-plugin-updater = /m);
  assert.match(cargo, /^tauri-plugin-dialog = /m);

  const mainRs = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'main.rs'), 'utf8');
  assert.match(mainRs, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/, '必须注册更新插件');
  assert.match(mainRs, /tauri_plugin_dialog::init\(\)/, '确认对话框需要 dialog 插件');
  assert.match(mainRs, /update::check_in_background/, '启动后要自动检查一次更新');
  assert.match(mainRs, /"update" => update::check_now/, '托盘菜单要有手动检查入口');

  // 更新能力刻意只做在原生侧：应用页由回环 HTTP 提供，不给页面调用更新命令的通道。
  const updateRs = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'update.rs'), 'utf8');
  assert.match(updateRs, /download_and_install/, '确认后要能下载并安装');
  assert.match(updateRs, /OkCancelCustom/, '必须先弹出确认对话框');
  assert.match(updateRs, /app\.restart\(\)/, '安装完成后要重启到新版本');
  assert.ok(!/install\(\s*\)\s*\.await\s*;\s*$/m.test(updateRs), '不得在未确认的情况下直接安装');
  // 还没发布过正式版本时端点返回 404，插件把它折叠成 ReleaseNotFound；最新版本缺当前平台
  // 安装包时是 TargetNotFound。两者都不是故障，不能提示成「检查更新失败」。
  assert.match(updateRs, /ReleaseNotFound/, '404（还没发布过版本）不能被当成检查失败');
  assert.match(updateRs, /TargetNotFound/, '缺少当前平台安装包不能被当成检查失败');

  // 发布流水线必须真的带上签名私钥来构建，否则更新产物签不出来。
  const release = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.ok(release.includes('TAURI_SIGNING_PRIVATE_KEY'), '发布流水线必须使用更新签名私钥');
});

test('打包运行时（src-tauri/runtime）不含 vite，且能独立启动后台', async (t) => {
  if (!fs.existsSync(path.join(RUNTIME, 'server', 'desktop-entry.js'))) {
    t.skip('尚未执行 npm run desktop:prepare，跳过打包运行时验证');
    return;
  }
  assert.ok(!fs.existsSync(path.join(RUNTIME, 'node_modules', 'vite')), '打包运行时不应包含 vite');
  assert.ok(fs.existsSync(path.join(RUNTIME, 'dist', 'index.html')), '打包运行时必须包含前端产物');
  for (const required of ['express', 'imapflow', 'pdfjs-dist', 'undici', 'tesseract.js']) {
    assert.ok(fs.existsSync(path.join(RUNTIME, 'node_modules', required)), `打包运行时缺少 ${required}`);
  }

  const dataDir = temporaryDataDir('runtime');
  const nodeBin = path.join(RUNTIME, process.platform === 'win32' ? 'node.exe' : 'node');
  const { state, ready } = startBackend({ dataDir, cwd: RUNTIME, nodeBin });
  await ready;
  try {
    const { cookie, jwt } = await bootstrapRaw(state.port, state.token);
    const snapshot = await call(state.port, '/api/state', { cookie, bearer: jwt });
    assert.equal(snapshot.status, 200);
    const page = await call(state.port, '/app', { cookie });
    assert.equal(page.status, 200, '打包运行时必须能返回前端页面');
    assert.match(page.text, /<div id="root"/);
    assert.equal(await stopBackend(state), 0);
  } catch (error) {
    await stopBackend(state);
    throw error;
  }
});
