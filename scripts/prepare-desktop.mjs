import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'src-tauri/runtime');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('请使用 Node 22+ 构建');
await fs.mkdir(runtime, { recursive: true });

// server 与 shared 是后台代码的运行时依赖（server/* 通过 ../shared/* 引用共享模板），
// dist 是前端产物（Vite 已把 public/ 打进 dist）。漏掉 shared 会让安装版直接启动失败。
for (const folder of ['server', 'dist', 'shared']) {
  await fs.rm(path.join(runtime, folder), { recursive: true, force: true });
  await fs.cp(path.join(root, folder), path.join(runtime, folder), { recursive: true, filter: source => !source.endsWith('.test.js') && !source.endsWith('.DS_Store') });
}

// 打进安装包的文件名必须是 Windows 也认的名字。
//
// Windows 不允许文件名以点或空格结尾（也不允许 CON/PRN/AUX/NUL/COM1..9/LPT1..9 这些保留名），
// 而这里是在 macOS / Linux 上构建的——本地一切正常，用户在 Windows 上才会装出一个资源缺失的包。
// Vite 的默认资源命名就踩过这个坑：`LICENSE_JBIG2` 这类没有扩展名的文件会被命名成
// `LICENSE_JBIG2-C_izpuvI.`（`vite.config.js` 里已经修掉），Tauri 打包时报
// `resource path ... doesn't exist`。这个检查便宜，就放在复制之后、打包之前。
{
  const illegal = [];
  const walk = async dir => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
      if (/[ .]$/.test(entry.name) || /[<>:"|?*]/.test(entry.name) || reserved.test(entry.name)) {
        illegal.push(path.relative(runtime, full).split(path.sep).join('/'));
      }
    }
  };
  await walk(runtime);
  if (illegal.length) {
    throw new Error(`以下文件名在 Windows 上非法（不能以点/空格结尾、不能含 <>:"|?*、不能用保留设备名）：\n${illegal.slice(0, 20).map(n => `  ${n}`).join('\n')}${illegal.length > 20 ? `\n  …共 ${illegal.length} 个` : ''}`);
  }
}

/**
 * 打包目标。默认等于本机（开发用）；交叉打包时由 `DAYLIGHT_TARGET_TRIPLE` 指定 Rust target triple，
 * 因为我们把 Node 二进制一起打进安装包——**内置 Node 的架构必须和安装包架构一致**，
 * 否则 Intel Mac 上装出来的应用会带着一个 arm64 的 Node，启动即失败。
 *
 * macOS 的 Intel 版本必须在 Apple Silicon runner 上交叉构建（GitHub 已不再提供 x64 的 macOS runner），
 * 所以这里是必需的，不是可选优化。同理 `npm install --os/--cpu` 也是必需的：原生模块
 * （`@napi-rs/canvas`）的预编译包是按平台可选项安装的，不指定就会装成本机架构。
 */
const TRIPLES = {
  'aarch64-apple-darwin': { os: 'darwin', cpu: 'arm64', dist: 'darwin-arm64', ext: 'tar.gz' },
  'x86_64-apple-darwin': { os: 'darwin', cpu: 'x64', dist: 'darwin-x64', ext: 'tar.gz' },
  'aarch64-pc-windows-msvc': { os: 'win32', cpu: 'arm64', dist: 'win-arm64', ext: 'zip' },
  'x86_64-pc-windows-msvc': { os: 'win32', cpu: 'x64', dist: 'win-x64', ext: 'zip' },
  'aarch64-unknown-linux-gnu': { os: 'linux', cpu: 'arm64', dist: 'linux-arm64', ext: 'tar.gz' },
  'x86_64-unknown-linux-gnu': { os: 'linux', cpu: 'x64', dist: 'linux-x64', ext: 'tar.gz' },
};

const triple = (process.env.DAYLIGHT_TARGET_TRIPLE || '').trim();
const targetOs = triple ? TRIPLES[triple]?.os : process.platform;
const targetCpu = triple ? TRIPLES[triple]?.cpu : process.arch;
if (triple && !TRIPLES[triple]) {
  throw new Error(`未知的构建目标 ${triple}；支持：${Object.keys(TRIPLES).join('、')}`);
}
const cross = Boolean(triple) && (TRIPLES[triple].os !== process.platform || TRIPLES[triple].cpu !== process.arch);

const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const names = ['@aws-sdk/client-s3', '@napi-rs/canvas', 'amqplib', 'bcryptjs', 'cookie-parser', 'express', 'imapflow', 'ioredis', 'jsonwebtoken', 'mailparser', 'nodemailer', 'pdfjs-dist', 'pg', 'sql.js', 'svg-captcha', 'tesseract.js', 'undici'];
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const dependencies = Object.fromEntries(names.map(name => [name, lock.packages[`node_modules/${name}`].version]));
await fs.writeFile(path.join(runtime, 'package.json'), JSON.stringify({ name: 'daylight-desktop-runtime', version: pkg.version, private: true, type: 'module', dependencies }, null, 2));
const savedLock = path.join(root, 'desktop-runtime-lock.json');
try { await fs.copyFile(savedLock, path.join(runtime, 'package-lock.json')); } catch {}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmArgs = ['install', '--omit=dev', '--no-audit', '--no-fund'];
if (cross) npmArgs.push(`--os=${targetOs}`, `--cpu=${targetCpu}`);
// 切换目标架构时必须清掉 node_modules：npm 不会自动卸载「上一轮为该架构装的原生模块」，
// 上一次为 arm64 装的 @napi-rs/canvas-darwin-arm64 会留在包里，既占体积也让人误判产物架构。
const previous = await fs.readFile(path.join(runtime, 'build-info.json'), 'utf8').then(JSON.parse).catch(() => null);
if (previous && (previous.platform !== targetOs || previous.arch !== targetCpu)) {
  console.log(`目标架构由 ${previous.platform}/${previous.arch} 变为 ${targetOs}/${targetCpu}，重建运行时依赖`);
  await fs.rm(path.join(runtime, 'node_modules'), { recursive: true, force: true });
}
const result = spawnSync(npm, npmArgs, { cwd: runtime, stdio: 'inherit', shell: process.platform === 'win32' });
if (result.status) process.exit(result.status);
await fs.copyFile(path.join(runtime, 'package-lock.json'), savedLock);

/**
 * 取目标平台的内置 Node 二进制。交叉打包时从 nodejs.org 下载官方发行版，不用本机这一份。
 * 下载有重试与本地缓存：CI 出网偶发超时不该让整次发布失败，重复构建也不该反复拉同一个文件。
 */
const binaryName = targetOs === 'win32' ? 'node.exe' : 'node';
async function prepareNode() {
  const dest = path.join(runtime, binaryName);
  if (!cross) {
    await fs.copyFile(process.execPath, dest);
    if (process.platform !== 'win32') await fs.chmod(dest, 0o755);
    return `本机 Node（${process.platform}/${process.arch}）`;
  }
  const spec = TRIPLES[triple];
  const base = `node-${process.version}-${spec.dist}`;
  const url = `https://nodejs.org/dist/${process.version}/${base}.${spec.ext}`;
  const cacheDir = path.join(root, 'work/node-dist-cache');
  const cached = path.join(cacheDir, `${base}.${spec.ext}`);
  const archive = path.join(runtime, `.node-download.${spec.ext}`);
  const extractDir = path.join(runtime, '.node-extract');

  let haveArchive = await fs.access(cached).then(() => true).catch(() => false);
  if (haveArchive) {
    console.log(`交叉打包：使用缓存的 ${base}.${spec.ext}`);
  } else {
    console.log(`交叉打包：下载目标平台 Node ${process.version}（${spec.dist}）`);
    let lastError;
    for (let attempt = 1; attempt <= 3 && !haveArchive; attempt += 1) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(cached, bytes);
        haveArchive = true;
      } catch (error) {
        lastError = error;
        console.log(`  第 ${attempt}/3 次失败：${error.message ?? error}`);
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
      }
    }
    if (!haveArchive) {
      throw new Error(`下载 ${url} 失败（${lastError?.message ?? lastError}）。请检查网络后重试；若本机 Node ${process.version} 不是官方发行版，请改用官方版本。`);
    }
  }
  await fs.copyFile(cached, archive);
  await fs.rm(extractDir, { recursive: true, force: true });
  await fs.mkdir(extractDir, { recursive: true });
  // macOS / Linux 用系统 tar；Windows 优先用自带的 bsdtar（能解压 zip），失败再退回 PowerShell。
  const tarArgs = spec.ext === 'zip' ? ['-xf', archive, '-C', extractDir] : ['-xzf', archive, '-C', extractDir];
  let extracted = spawnSync('tar', tarArgs, { stdio: 'inherit' });
  if (extracted.status !== 0 && spec.ext === 'zip') {
    extracted = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${extractDir}' -Force`], { stdio: 'inherit' });
  }
  if (extracted.status !== 0) throw new Error(`解压 ${base}.${spec.ext} 失败`);
  const inner = path.join(extractDir, base, targetOs === 'win32' ? 'node.exe' : path.join('bin', 'node'));
  await fs.copyFile(inner, dest);
  if (targetOs !== 'win32') await fs.chmod(dest, 0o755);
  await fs.rm(archive, { force: true });
  await fs.rm(extractDir, { recursive: true, force: true });
  return `官方 Node ${process.version}（${spec.dist}）`;
}

const nodeSource = await prepareNode();
await fs.writeFile(path.join(runtime, 'build-info.json'), JSON.stringify({
  version: pkg.version,
  node: process.version,
  platform: targetOs,
  arch: targetCpu,
  targetTriple: triple || null,
  nodeSource,
  builtAt: new Date().toISOString(),
  builtOn: `${process.platform}/${process.arch}`,
}, null, 2));
console.log(`已准备 ${targetOs}/${targetCpu} 内置 Node 与完整后台（不含私人数据）：${nodeSource}`);
