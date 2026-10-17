// This entry is launched by the native shell, never by the existing Web project.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
if (!process.env.DAYLIGHT_DATA_DIR || !/^[a-f\d]{64}$/i.test(process.env.DAYLIGHT_MASTER_KEY || '') || !process.env.DAYLIGHT_DESKTOP_TOKEN) {
  throw new Error('缺少桌面启动凭据；请使用 npm run desktop:dev 或安装版启动。');
}
process.umask(0o077);
fs.mkdirSync(process.env.DAYLIGHT_DATA_DIR, { recursive: true });
process.env.DAYLIGHT_DESKTOP = '1';
process.env.DAYLIGHT_JWT_SECRET = createHash('sha256').update(process.env.DAYLIGHT_MASTER_KEY + ':jwt').digest('hex');
// The pipe closes even when the shell crashes. Never leave a mail-sync process orphaned.
process.stdin.setEncoding('utf8');
process.stdin.on('data', value => { if (value.includes('shutdown')) process.exit(0); });
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
await import('./index.js');
