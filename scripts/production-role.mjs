/** Windows production launcher: import a role and bridge a verified stop file to SIGTERM. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  role: { type: 'string' },
  'launch-id': { type: 'string' },
  'control-path': { type: 'string' },
} });
const entries = { api: '../server/index.js', worker: '../server/worker.js', scheduler: '../server/scheduler.js' };
const role = values.role;
const launchId = values['launch-id'];
const controlPath = values['control-path'];
if (!Object.hasOwn(entries, role) || !/^[a-f0-9-]{36}$/.test(launchId || '') || !path.isAbsolute(controlPath || '')) {
  throw new Error('Invalid production role launcher arguments');
}
if (process.env.DAYLIGHT_RUNTIME !== 'production' || process.env.NODE_ENV !== 'production') {
  throw new Error('The role launcher requires DAYLIGHT_RUNTIME=production and NODE_ENV=production');
}

// Windows cannot deliver POSIX SIGTERM through Stop-Process. Emit it inside the
// application process so installShutdown can drain jobs and close shared clients.
let stopping = false;
const timer = setInterval(() => {
  if (stopping) return;
  let request;
  try { request = JSON.parse(fs.readFileSync(controlPath, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code !== 'ENOENT') console.error('Production stop request could not be read; leaving the role running');
    return;
  }
  if (request.launchId !== launchId) return;
  stopping = true;
  clearInterval(timer);
  try { fs.unlinkSync(controlPath); } catch { /* The request can be cleaned up on the next start. */ }
  console.log(`Production ${role} is draining`);
  if (!process.emit('SIGTERM')) process.exit(0);
}, 500);
timer.unref();

// Keep the existing role entry points and their production runtime checks intact.
const entryUrl = new URL(entries[role], import.meta.url);
process.argv[1] = fileURLToPath(entryUrl);
if (role === 'api') process.argv.push('--production');
await import(entryUrl.href);
