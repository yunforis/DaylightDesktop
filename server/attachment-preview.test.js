import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceUrl } from '../src/lib/attachment-source.js';

test('普通邮件图片即使带有附件 ID，也使用原文件代理，保留邮箱和文件信息', () => {
  const file = { id: 'attachment-image', filename: '会议图片.png', contentType: 'image/png',
    key: 'users/fixture/mailboxes/secondary/会议图片.png', mailboxId: 'secondary',
    proxyUrl: '/api/attachments/users%2Ffixture%2Fmailboxes%2Fsecondary%2F%E4%BC%9A%E8%AE%AE%E5%9B%BE%E7%89%87.png',
    url: 'https://files.example.invalid/public-image.png' };
  const before = structuredClone(file);
  assert.equal(sourceUrl(file), file.proxyUrl);
  assert.doesNotMatch(sourceUrl(file), /recruitment/);
  assert.deepEqual(file, before);
});

test('旧邮件没有附件 ID 时，已保存的地址仍可用于预览', () => {
  const file = { filename: '旧邮件.jpg', url: '/api/attachments/fixture%2Fold.jpg' };
  assert.equal(sourceUrl(file), file.url);
  assert.doesNotMatch(sourceUrl(file), /undefined|recruitment/);
});

test('只有存储 key 的 PDF 与非简历附件不会被当作招聘附件', () => {
  for (const file of [
    { id: 'pdf', filename: '资料.pdf', contentType: 'application/pdf', key: 'fixture/会议资料.pdf' },
    { id: 'not-resume', status: 'not_resume', filename: '通知.pdf', key: 'fixture/notice.pdf' },
  ]) assert.equal(sourceUrl(file), `/api/attachments/${encodeURIComponent(file.key)}`);
});

test('已保存的招聘下载地址保留，旧 ID 格式携带来源邮箱而不依赖当前邮箱', () => {
  const stored = { id: 'resume', proxyUrl: '/api/recruitment/attachments/resume?mailbox=source', mailboxId: 'another' };
  assert.equal(sourceUrl(stored), stored.proxyUrl);
  assert.equal(sourceUrl({ id: 'legacy / 简历', mailboxId: 'secondary & 邮箱' }),
    `/api/recruitment/attachments/${encodeURIComponent('legacy / 简历')}?mailbox=${encodeURIComponent('secondary & 邮箱')}`);
  assert.equal(sourceUrl({ id: 'legacy-default' }), '/api/recruitment/attachments/legacy-default');
});

test('跳过上传的附件与缺少地址的记录不生成虚假的预览请求', () => {
  assert.equal(sourceUrl({ id: 'oversize', skipped: true, key: 'not-uploaded.png' }), '');
  assert.equal(sourceUrl({ filename: 'unknown.pdf' }), '');
  assert.equal(sourceUrl(), '');
});
