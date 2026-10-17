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
function rawPathBody(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

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
    assert.equal(mode, 0o600, '密文文件权限必须是 0600');

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

  // PDF 预览：桌面端用自己的 pdf.js canvas 查看器（三平台一致），资源由后台就地提供。
  const desktopHttp = fs.readFileSync(path.join(ROOT, 'server', 'desktop-http.js'), 'utf8');
  assert.match(desktopHttp, /'\/desktop\/pdfjs\/'/, 'pdf.js 资源必须免 cookie 提供（worker 不保证带 cookie）');
  assert.match(desktopHttp, /express\.static\(target/, 'pdf.js 资源必须以只读静态目录提供');
  const viewer = fs.readFileSync(path.join(ROOT, 'src', 'components', 'pdf-canvas-viewer.jsx'), 'utf8');
  assert.match(viewer, /cMapUrl/, '应用自产 PDF 是 UniGB-UCS2-H 预定义 CMap，必须传 cMapUrl');
  assert.match(viewer, /standardFontDataUrl/);
  assert.match(viewer, /isEvalSupported: false/, '桌面端 CSP 无 unsafe-eval，必须关掉 eval 路径');
  assert.match(viewer, /visibilitychange/, '窗口隐藏时 pdf.js 渲染暂停，超时不能误判');
  const attachment = fs.readFileSync(path.join(ROOT, 'src', 'components', 'attachment-viewer.jsx'), 'utf8');
  assert.match(attachment, /PdfCanvasViewer/, '附件预览必须走桌面端 canvas 查看器');
});

test('PDF 预览：pdf.js 资源由后台就地提供，且应用自产 PDF 能被同一配置渲染', async () => {
  const dataDir = temporaryDataDir('pdfjs');
  const { state, ready } = startBackend({ dataDir });
  await ready;
  try {
    // 这些是公开的库资源、不含用户数据，worker 与 fetch 也不一定带 cookie，因此必须免 cookie 可取。
    const cmap = await call(state.port, '/desktop/pdfjs/cmaps/UniGB-UCS2-H.bcmap');
    assert.equal(cmap.status, 200);
    assert.ok(cmap.text.length > 10_000, '预定义 CMap 必须完整可下载');

    const worker = await call(state.port, '/desktop/pdfjs/build/pdf.worker.min.mjs');
    assert.equal(worker.status, 200);
    assert.ok(worker.text.length > 100_000, 'pdf.js worker 必须可下载');
    assert.ok(worker.text.includes('WorkerMessageHandler'));

    const standardFont = await call(state.port, '/desktop/pdfjs/standard_fonts/LiberationSans-Regular.ttf');
    assert.equal(standardFont.status, 200, '标准字体资源必须可下载');

    // 静态目录不得被用于读取包外文件（Express 会把 `..` 归一化掉，这里只要求不泄露内容）。
    const escaped = await rawPathBody(state.port, '/desktop/pdfjs/cmaps/../../package.json');
    assert.ok(!escaped.body.includes('pdfjs-dist'), `静态目录越界读取了包外文件：${escaped.body.slice(0, 60)}`);

    // 应用自己生成的简历 PDF 使用 STSong-Light + /Encoding /UniGB-UCS2-H（非嵌入中文 CID 字体），
    // 必须同时提供 cMapUrl 与 standardFontDataUrl，否则中文字形取不到。
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
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] < 100 && pixels[index + 1] < 100 && pixels[index + 2] < 100) dark += 1;
    }
    assert.ok(dark > 200, `渲染结果必须含文字像素，实际 ${dark}`);
  } finally {
    assert.equal(await stopBackend(state), 0);
  }
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
