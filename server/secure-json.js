import fs from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function encryptionKey() {
  const value = process.env.DAYLIGHT_MASTER_KEY;
  if (!value) return null;
  if (!/^[a-f\d]{64}$/i.test(value)) throw new Error('无效的桌面加密密钥');
  return Buffer.from(value, 'hex');
}
export function readSecureJson(filename) {
  const payload = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (payload?.format !== 'daylight-encrypted-v1') return payload;
  const key = encryptionKey();
  if (!key) throw new Error('请通过 Daylight 桌面应用解锁此配置');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8'));
}
export function writeSecureJson(filename, value) {
  const key = encryptionKey();
  let text = JSON.stringify(value, null, 2);
  if (key) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    text = JSON.stringify({ format: 'daylight-encrypted-v1', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  }
  const temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, text + '\n', { mode: 0o600 });
  fs.renameSync(temporary, filename);
}
