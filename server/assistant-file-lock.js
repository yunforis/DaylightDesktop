import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Publish complete lock metadata atomically, so a crash cannot leave an ownerless visible lock. */
export function publishAssistantFileLock(file, owner) {
  const temporary = `${file}.${randomUUID()}.owner`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
    fs.linkSync(temporary, file); // Fails with EEXIST when another process owns the lock.
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
