#!/usr/bin/env node
/**
 * [桌面端对齐工具] 把 Daylight（Web/云原生真源）的共享代码同步到 DaylightDesktop，
 * 并重贴桌面端专有补丁。
 *
 * 为什么需要它：桌面端是 Daylight 的一个分发形态，两侧代码会双向分叉。与其逐文件手工
 * merge，不如「重新基线 + 重贴补丁」——本脚本把这件事变成一条可重复、可校验的命令。
 *
 * 用法：
 *   node scripts/desktop-sync.mjs                  # 从 ../Daylight 同步
 *   DAYLIGHT_WEB_DIR=/path/to/Daylight node scripts/desktop-sync.mjs
 *   node scripts/desktop-sync.mjs --check          # 只检查补丁锚点，不写文件
 *
 * 它只读真源、只写本仓库。任何补丁锚点找不到都会立即报错，绝不静默跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.resolve(process.env.DAYLIGHT_WEB_DIR || path.join(root, '..', 'Daylight'));
const CHECK_ONLY = process.argv.includes('--check');

if (!fs.existsSync(path.join(WEB, 'server', 'index.js'))) {
  throw new Error(`找不到 Web 真源：${WEB}（用 DAYLIGHT_WEB_DIR 指定）`);
}

/** 桌面端自有文件：同步时绝不覆盖。 */
const OWNED = new Set([
  'src/App.jsx',            // 去登录化 / 去管理端的桌面路由
  'src/lib/desktop.js',     // 壳层链接处理 + /desktop/session 会话引导
]);

/** Web 有、桌面端明确不要的文件（去登录化与去管理端）。 */
const REMOVE = [
  'src/pages/admin-page.jsx', 'src/pages/admin-login-page.jsx', 'src/pages/landing-page.jsx',
  'src/pages/login-page.jsx', 'src/pages/register-page.jsx', 'src/pages/forgot-password-page.jsx',
  'src/pages/reset-password-page.jsx', 'src/pages/legal-page.jsx', 'src/pages/auth-shell.jsx',
  'src/components/admin-shell.jsx', 'src/components/admin-command-palette.jsx', 'src/components/admin-little-d.jsx',
];

const COPY_DIRS = ['src', 'server', 'shared', 'public', 'scripts'];
// 测试与验证素材（合成数据，非真实邮件正文）
const COPY_FILES = ['index.html', 'docs/resume-test', 'docs/invoice-test'];

let applied = 0;
const skipped = [];

function copyTree(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      if (entry === '.DS_Store' || entry === 'node_modules') continue;
      copyTree(path.join(from, entry), path.join(to, entry));
    }
    return;
  }
  const rel = path.relative(root, to).split(path.sep).join('/');
  if (OWNED.has(rel)) { skipped.push(rel); return; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  applied += 1;
}

/** 精确字符串替换；找不到锚点直接抛错，避免「同步成功但补丁没贴上」的静默失败。 */
function patch(rel, label, oldText, newText) {
  const file = path.join(root, rel);
  let content = fs.readFileSync(file, 'utf8');
  if (newText && content.includes(newText) && !content.includes(oldText)) return; // 已贴过
  if (!content.includes(oldText)) {
    throw new Error(`补丁锚点未找到：${rel} → ${label}\n（Web 真源可能已改动，请检查后更新本脚本）`);
  }
  content = content.replace(oldText, newText);
  if (!CHECK_ONLY) fs.writeFileSync(file, content);
  applied += 1;
}

function removeIfExists(rel) {
  const file = path.join(root, rel);
  if (fs.existsSync(file)) { if (!CHECK_ONLY) fs.rmSync(file); applied += 1; }
}

// ---------------------------------------------------------------- 1. 同步共享代码
if (!CHECK_ONLY) for (const dir of COPY_DIRS) copyTree(path.join(WEB, dir), path.join(root, dir));
if (!CHECK_ONLY) for (const file of COPY_FILES) copyTree(path.join(WEB, file), path.join(root, file));
for (const rel of REMOVE) removeIfExists(rel);

// ---------------------------------------------------------------- 2. 重贴桌面端补丁

// 2.1 前端：启动时换取本地会话 token
patch('src/main.jsx', '桌面会话引导',
  `import App from './App.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(<App />);`,
  `import App from './App.jsx';
import './index.css';
import { bootstrapDesktopSession } from './lib/desktop';

// [desktop patch] 先向原生壳层换取本地会话 token，再挂载 App；失败由 RequireAuth 渲染可重试错误页。
await bootstrapDesktopSession();

ReactDOM.createRoot(document.getElementById('root')).render(<App />);`);

// 2.2 前端：命令面板移除管理端入口
patch('src/components/command-palette.jsx', '命令面板去管理端条目',
  `    if (isAdmin) {
      nav.push({ id: 'go-admin', label: '前往管理后台', path: '/admin', icon: Shield, keywords: 'admin 用户' });
    }
`, '');
patch('src/components/command-palette.jsx', '命令面板去 Shield 图标导入',
  'Search, Settings2, Shield, SlidersHorizontal', 'Search, Settings2, SlidersHorizontal');

// 2.3 后端：index.js
patch('server/index.js', 'vite 动态导入 + 桌面 HTTP 层导入',
  `import { createServer as createViteServer } from 'vite';
`,
  `// [desktop patch] 原生壳层的桌面会话引导；vite 改为按需动态导入（见文件末尾）。
import { mountDesktopHttp } from './desktop-http.js';
`);

patch('server/index.js', '挂载桌面 HTTP 层 + 屏蔽管理端接口',
  `const app = express();
app.use('/api', mobileCors());`,
  `const app = express();
// [desktop patch] 必须在任何业务中间件之前挂载：校验回环地址 / Origin / 壳层一次性 token。
mountDesktopHttp(app);
// [desktop patch] 桌面端是单用户本地应用，不提供管理端接口（保留代码，仅屏蔽路由）。
if (process.env.DAYLIGHT_DESKTOP === '1') app.use('/api/admin', (req, res) => res.status(404).json({ error: '接口不存在。' }));
app.use('/api', mobileCors());`);

patch('server/index.js', '桌面监听与就绪信号',
  `} else {
  const vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { port: Number(process.env.DAYLIGHT_HMR_PORT || (Number(process.env.PORT || 3000) + 10000)) } }, appType: 'spa' });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || (productionRuntime ? '0.0.0.0' : '127.0.0.1');
const server = app.listen(port, host, () => { health.started(); console.log(\`Daylight is ready on port \${port}\`); });
if (productionRuntime) installShutdown({ health, server });`,
  `} else {
  // [desktop patch] 动态导入：安装版运行时不含 vite。
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { port: Number(process.env.DAYLIGHT_HMR_PORT || (Number(process.env.PORT || 3000) + 10000)) } }, appType: 'spa' });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT || 3000);
// [desktop patch] 桌面端只监听回环地址，不接受外部网卡。
const host = process.env.DAYLIGHT_DESKTOP === '1' ? '127.0.0.1' : (process.env.HOST || (productionRuntime ? '0.0.0.0' : '127.0.0.1'));
const server = app.listen(port, host);
server.on('listening', () => {
  health.started();
  const actualPort = server.address().port;
  // [desktop patch] 原生壳层解析这一行拿到实际端口后再导航。
  if (process.env.DAYLIGHT_DESKTOP === '1') console.log(\`DAYLIGHT_READY \${actualPort}\`);
  else console.log(\`Daylight is ready on port \${actualPort}\`);
});
server.on('error', (error) => {
  // [desktop patch] 端口被占用时回退随机端口，避免用户机器上直接打不开。
  if (error.code === 'EADDRINUSE' && process.env.DAYLIGHT_DESKTOP === '1') server.listen(0, '127.0.0.1');
  else { console.error(error); process.exit(1); }
});
if (productionRuntime) installShutdown({ health, server });`);

// 2.4 后端：本地单用户会话
patch('server/auth.js', '本地 owner 会话',
  `export async function adminDeleteUser(userId, actorId) {
  if (userId === actorId) {
    throw Object.assign(new Error('不能删除当前登录的管理员账号'), { status: 400 });
  }
  await revokeAllUserSessions(userId);
  await deleteUser(userId);
  return { ok: true };
}`,
  `export async function adminDeleteUser(userId, actorId) {
  if (userId === actorId) {
    throw Object.assign(new Error('不能删除当前登录的管理员账号'), { status: 400 });
  }
  await revokeAllUserSessions(userId);
  await deleteUser(userId);
  return { ok: true };
}

// [desktop patch] 本地 owner 仅在原生壳层一次性 HTTP 引导之后可得，不开放云端注册/登录。
export async function issueDesktopAuth() {
  if (process.env.DAYLIGHT_DESKTOP !== '1') throw new Error('桌面会话不可用');
  const email = 'owner@daylight.local';
  let user = await findUserByEmail(email);
  if (!user) {
    await adminCreateUser({ email, username: '本地工作空间', password: randomBytes(32).toString('hex'), role: 'admin' });
    user = await findUserByEmail(email);
  }
  return issueAuth(user, { userAgent: 'Daylight Desktop', ip: '127.0.0.1' });
}`);

// 2.5 后端：凭据落盘加密
patch('server/store.js', 'settings 加密落盘 - 导入',
  `import { normalizeInvitationPreferences } from './invitations-preferences.js';
import fs from 'node:fs';`,
  `import { normalizeInvitationPreferences } from './invitations-preferences.js';
import { readSecureJson, writeSecureJson } from './secure-json.js';
import fs from 'node:fs';`);

patch('server/store.js', 'settings 加密落盘 - 读写',
  `function read(name, initial, targetDirectory = directory) {
  const filename = path.join(targetDirectory, \`\${name}.json\`);
  if (!fs.existsSync(filename)) write(name, initial, targetDirectory);
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function write(name, data, targetDirectory = directory) {
  fs.mkdirSync(targetDirectory, { recursive: true });
  fs.writeFileSync(path.join(targetDirectory, \`\${name}.json\`), JSON.stringify(data, null, 2));
}`,
  `function read(name, initial, targetDirectory = directory) {
  const filename = path.join(targetDirectory, \`\${name}.json\`);
  if (!fs.existsSync(filename)) write(name, initial, targetDirectory);
  // [desktop patch] settings 含邮箱授权码与模型 API Key，落盘加密；其余 JSON 保持明文。
  return name === 'settings' ? readSecureJson(filename) : JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function write(name, data, targetDirectory = directory) {
  fs.mkdirSync(targetDirectory, { recursive: true });
  const filename = path.join(targetDirectory, \`\${name}.json\`);
  if (name === 'settings') { writeSecureJson(filename, data); return; }
  // [desktop patch] 非 settings 走临时文件 + rename，避免崩溃时留下半截 JSON。
  fs.writeFileSync(\`\${filename}.tmp\`, JSON.stringify(data, null, 2));
  fs.renameSync(\`\${filename}.tmp\`, filename);
}`);

// 2.6 后端：基础设施配置（本地默认 + 加密落盘）
patch('server/infra/config.js', 'infra 配置加密与本地默认 - 导入',
  `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProductionRuntime, requireLocalRuntime } from '../runtime-mode.js';`,
  `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecureJson, writeSecureJson } from '../secure-json.js';
import { isProductionRuntime, requireLocalRuntime } from '../runtime-mode.js';

// [desktop patch] 桌面端是单用户本地应用：默认不连共享 PG/MQ，配置落盘加密。
const DESKTOP = process.env.DAYLIGHT_DESKTOP === '1';`);

patch('server/infra/config.js', 'PG 默认关闭',
  `const DEFAULTS = {
  postgres: {
    enabled: true,`,
  `const DEFAULTS = {
  postgres: {
    enabled: !DESKTOP,`);

patch('server/infra/config.js', 'MQ 默认关闭',
  `  mq: {
    enabled: true,`,
  `  mq: {
    enabled: !DESKTOP,`);

patch('server/infra/config.js', '本地演示登录',
  `    requireAuth: process.env.DAYLIGHT_REQUIRE_AUTH === '0' ? false : true,
    allowLocalDemoLogin: true,`,
  `    requireAuth: process.env.DAYLIGHT_REQUIRE_AUTH === '0' || process.env.DAYLIGHT_DISABLE_AUTH === '1' ? false : true,
    allowLocalDemoLogin: !DESKTOP,`);

patch('server/infra/config.js', 'infra 加密读取',
  `  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));`,
  `  const raw = readSecureJson(configPath);`);

patch('server/infra/config.js', 'infra 加密写入',
  `  fs.writeFileSync(configPath, \`\${JSON.stringify(merged, null, 2)}\\n\`);`,
  `  writeSecureJson(configPath, merged);`);

// 2.7 打包：运行时依赖白名单必须覆盖 server/ 的全部裸包导入
const serverBareImports = new Set();
{
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(target); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(target, 'utf8');
      for (const match of text.matchAll(/^import\s[^;]*?from\s+'([^.][^']*)'/gm)) {
        if (!match[1].startsWith('node:')) serverBareImports.add(match[1].split('/').slice(0, match[1].startsWith('@') ? 2 : 1).join('/'));
      }
    }
  };
  walk(path.join(root, 'server'));
}
serverBareImports.delete('vite');
const preparePath = path.join(root, 'scripts/prepare-desktop.mjs');
const prepareText = fs.readFileSync(preparePath, 'utf8');
const whitelist = JSON.parse((prepareText.match(/const names = (\[[^\]]*\]);/) || [])[1].replace(/'/g, '"'));
const missingDeps = [...serverBareImports].filter((dep) => !whitelist.includes(dep));
if (missingDeps.length) {
  throw new Error(`prepare-desktop.mjs 运行时白名单缺少依赖：${missingDeps.join(', ')}（安装版会启动失败）`);
}

console.log(`✅ 同步完成：写入/更新 ${applied} 个文件，保留桌面自有 ${skipped.join(', ') || '（无）'}`);
console.log(`   移除 Web 专有文件 ${REMOVE.length} 项；补丁锚点全部命中；运行时依赖白名单覆盖 ${serverBareImports.size} 个裸包导入。`);
if (CHECK_ONLY) console.log('   （--check 模式：未写入任何文件）');
