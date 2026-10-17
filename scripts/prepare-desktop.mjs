import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'src-tauri/runtime');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('请使用 Node 22+ 构建');
await fs.mkdir(runtime, { recursive: true });
for (const folder of ['server', 'dist']) {
  await fs.rm(path.join(runtime, folder), { recursive: true, force: true });
  await fs.cp(path.join(root, folder), path.join(runtime, folder), { recursive: true, filter: source => !source.endsWith('.test.js') && !source.endsWith('.DS_Store') });
}
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const names = ['@aws-sdk/client-s3', '@napi-rs/canvas', 'amqplib', 'bcryptjs', 'cookie-parser', 'express', 'imapflow', 'ioredis', 'jsonwebtoken', 'mailparser', 'nodemailer', 'pdfjs-dist', 'pg', 'sql.js', 'svg-captcha', 'tesseract.js', 'undici'];
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const dependencies = Object.fromEntries(names.map(name => [name, lock.packages[`node_modules/${name}`].version]));
await fs.writeFile(path.join(runtime, 'package.json'), JSON.stringify({ name: 'daylight-desktop-runtime', version: pkg.version, private: true, type: 'module', dependencies }, null, 2));
const savedLock = path.join(root, 'desktop-runtime-lock.json');
try { await fs.copyFile(savedLock, path.join(runtime, 'package-lock.json')); } catch {}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: runtime, stdio: 'inherit', shell: process.platform === 'win32' });
if (result.status) process.exit(result.status);
await fs.copyFile(path.join(runtime, 'package-lock.json'), savedLock);
const binary = path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node');
await fs.copyFile(process.execPath, binary);
if (process.platform !== 'win32') await fs.chmod(binary, 0o755);
await fs.writeFile(path.join(runtime, 'build-info.json'), JSON.stringify({ version: pkg.version, node: process.version, platform: process.platform, arch: process.arch, builtAt: new Date().toISOString() }, null, 2));
console.log(`已准备 ${process.platform}/${process.arch} 内置 Node 与完整后台（不含私人数据）`);
