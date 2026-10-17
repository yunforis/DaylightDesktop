import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
// PATH 必须按键名不敏感的方式读写。
//
// Windows 上这个变量的键名是 `Path`，而这里的 `env` 是从 `process.env` 展开出来的**普通对象**
// （大小写敏感）：写 `env.PATH = ...` 改不到已有的 `Path`，只会新增一个键，于是交给子进程的
// 环境块里出现两个大小写不同的 PATH，由操作系统挑一个用。CI（windows-latest）实测就是挑到了
// 后来新增的那个不含 cargo 的值，`spawnSync('cargo')` 直接找不到可执行文件——退出码 1、
// 全程没有任何输出。这类失败在日志里几乎无迹可寻，所以在这里一次性修掉并加了解释。
const env = { ...process.env };
const PATH_KEY = Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH';
const prependPath = directory => {
  env[PATH_KEY] = `${directory}${path.delimiter}${env[PATH_KEY] ?? ''}`;
};
const localCargo = path.join(root, 'work/toolchain/cargo');
if (fs.existsSync(path.join(localCargo, 'bin'))) {
  env.CARGO_HOME = localCargo;
  env.RUSTUP_HOME = path.join(root, 'work/toolchain/rustup');
  prependPath(path.join(localCargo, 'bin'));
}
if (Number(process.versions.node.split('.')[0]) < 22) {
  const candidates = path.join(os.homedir(), '.nvm/versions/node');
  const found = fs.existsSync(candidates) && fs.readdirSync(candidates).filter(v => Number(v.slice(1).split('.')[0]) >= 22).sort().reverse()[0];
  if (!found) throw new Error('开发需要 Node.js 22+。请安装后重试；安装版不需要 Node。');
  const node = path.join(candidates, found, 'bin/node');
  prependPath(path.dirname(node));
  const child = spawn(node, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env });
  child.on('exit', code => process.exit(code ?? 1));
} else {
  prependPath(path.dirname(process.execPath));
  env.DAYLIGHT_NODE = process.execPath;
  const action = process.argv[2] || 'dev';
  if (action === 'check') {
    const check = spawnSync('cargo', ['check', '--manifest-path', 'src-tauri/Cargo.toml'], { stdio: 'inherit', env });
    // 不用 `check.status ?? 1` 直接收场：cargo 压根没启动时（ENOENT）只有一个退出码，
    // 没有任何线索——windows-latest 上就是这么静默失败过一次。把 error 明确打出来。
    if (check.error) throw new Error(`无法执行 cargo：${check.error.message}`);
    process.exit(check.status ?? 1);
  }
  if (!['dev', 'build'].includes(action)) throw new Error(`未知命令 ${action}`);
  const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  const child = spawn(process.execPath, [cli, action, ...(action === 'dev' ? ['--config', 'src-tauri/tauri.dev.conf.json'] : []), ...process.argv.slice(3)], { stdio: 'inherit', env });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', code => process.exit(code ?? 0));
}
