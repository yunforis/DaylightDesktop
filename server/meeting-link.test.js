import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetingLinkParts, meetingLinkUrl } from '../shared/meeting-link.js';

test('会议正文保留中文、换行、标点与原始 URL 参数，仅已保存的会议地址可点击', () => {
  const url = 'https://meeting.example.invalid/j/fixture?from=mail&token=a%2Bb#join';
  const body = `您好，\r\n飞书会议链接：${url}。\n再次入会（${url}）\n其他说明 https://other.example.invalid/help\n<script>literal</script>`;
  const parts = meetingLinkParts(body, url);
  assert.equal(parts.map((part) => part.text).join(''), body);
  assert.deepEqual(parts.filter((part) => part.href), [{ text: url, href: url }, { text: url, href: url }]);
  assert.equal(meetingLinkUrl(url), url);
  assert.deepEqual(meetingLinkParts('正文没有链接', url), [{ text: '正文没有链接' }]);
});

test('不完整或不安全的会议地址保持纯文本，不生成可执行或含认证信息的链接', () => {
  for (const url of [undefined, null, 123, {}, '', 'javascript:alert(1)', 'data:text/html,test',
    'http://meeting.example.invalid/j/fixture', '//meeting.example.invalid/j/fixture',
    'https:meeting.example.invalid/j/fixture', 'https://', 'https://user:pass@meeting.example.invalid/j/fixture',
    'https://user@meeting.example.invalid/j/fixture', 'https://meeting.example.invalid/with space',
    'https://meeting.example.invalid/\nunsafe', ' https://meeting.example.invalid/j/fixture']) {
    const body = `会议链接：${url}`;
    assert.equal(meetingLinkUrl(url), '');
    assert.deepEqual(meetingLinkParts(body, url), [{ text: body }]);
  }
});
