import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const env = { ...process.env };
const localCargo = path.join(root, 'work/toolchain/cargo');
if (fs.existsSync(path.join(localCargo, 'bin'))) {
  env.CARGO_HOME = localCargo;
  env.RUSTUP_HOME = path.join(root, 'work/toolchain/rustup');
  env.PATH = `${localCargo}/bin${path.delimiter}${env.PATH}`;
}
if (Number(process.versions.node.split('.')[0]) < 22) {
  const candidates = path.join(os.homedir(), '.nvm/versions/node');
  const found = fs.existsSync(candidates) && fs.readdirSync(candidates).filter(v => Number(v.slice(1).split('.')[0]) >= 22).sort().reverse()[0];
  if (!found) throw new Error('开发需要 Node.js 22+。请安装后重试；安装版不需要 Node。');
  const node = path.join(candidates, found, 'bin/node');
  const child = spawn(node, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...env, PATH: `${path.dirname(node)}${path.delimiter}${env.PATH}` } });
  child.on('exit', code => process.exit(code ?? 1));
} else {
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH}`;
  env.DAYLIGHT_NODE = process.execPath;
  const action = process.argv[2] || 'dev';
  if (action === 'check') {
    const check = spawnSync('cargo', ['check', '--manifest-path', 'src-tauri/Cargo.toml'], { stdio: 'inherit', env });
    process.exit(check.status ?? 1);
  }
  if (!['dev', 'build'].includes(action)) throw new Error(`未知命令 ${action}`);
  const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  const child = spawn(process.execPath, [cli, action, ...(action === 'dev' ? ['--config', 'src-tauri/tauri.dev.conf.json'] : []), ...process.argv.slice(3)], { stdio: 'inherit', env });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', code => process.exit(code ?? 0));
}
