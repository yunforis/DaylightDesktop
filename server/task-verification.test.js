import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTaskCompletable } from './tasks.js';
import { createTraceRecorder, emailReference } from './traces.js';

const sourceEmail = { id: 'synthetic-source-email-1', subject: 'Synthetic reply request' };
const task = {
  id: 'synthetic-task',
  title: '回复确认',
  requiresVerification: true,
  verification: { mode: 'reply_sent', status: 'pending' },
  sources: [{ emailId: sourceEmail.id }],
};

function replyTrace(email, status) {
  const recorder = createTraceRecorder();
  const context = recorder.beginEmail(email, 'qq');
  context.update({ reply_delivery: { status } });
  return context.trace;
}

test('待办完成核验识别真实日志中的邮箱 ID 哈希及成功发送状态', () => {
  const trace = replyTrace(sourceEmail, 'sent');
  assert.equal(trace.email_ref, emailReference(sourceEmail.id));
  assert.equal(trace.email_id, undefined);
  assert.equal(trace.emailId, undefined);
  const result = assertTaskCompletable(task, { emails: [sourceEmail], traces: [trace] });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'reply_sent');
  assert.ok(Number.isFinite(Date.parse(result.verifiedAt)));
});

test('其他邮件已发送或关联邮件发送失败，均不能通过待办完成核验', () => {
  const unrelated = replyTrace({ id: 'synthetic-other-email', subject: 'Other request' }, 'sent');
  const failed = replyTrace(sourceEmail, 'failed');
  assert.throws(
    () => assertTaskCompletable(task, { emails: [sourceEmail], traces: [unrelated, failed] }),
    /已发送回复/,
  );
});

test('待办完成核验兼容旧日志的精确原始邮件 ID', () => {
  for (const field of ['email_id', 'emailId', 'email_ref']) {
    const result = assertTaskCompletable(task, {
      traces: [{ [field]: sourceEmail.id, reply_delivery: { status: 'sent' } }],
    });
    assert.equal(result.ok, true, field);
  }
});

test('待办完成核验不接受包含邮件 ID 或哈希的其他日志引用', () => {
  for (const reference of [`${sourceEmail.id}-other`, `prefix-${sourceEmail.id}`, `${emailReference(sourceEmail.id)}-other`]) {
    assert.throws(
      () => assertTaskCompletable(task, { traces: [{ email_ref: reference, reply_delivery: { status: 'sent' } }] }),
      /已发送回复/,
    );
  }
});
