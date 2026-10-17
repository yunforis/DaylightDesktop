import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every candidate, email, PDF and transport response here is synthetic.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = fs.mkdtempSync(path.join(root, 'work', 'recruitment-test-'));
process.env.DAYLIGHT_DATA_DIR = directory;
for (const key of ['DAYLIGHT_HTTPS_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[key];
process.env.DAYLIGHT_AUTO_PROXY = '0';
fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({ postgres: { enabled: false } }));
const { readRecruitment, updateRecruitment, storeAttachment, attachmentPath, getAttachment } = await import('./recruitment-store.js');
const { ingestResume, getRecruitmentState, runRecruitmentChat, updateInterview, prepareInterviewMeeting,
  sendInterview, handleInterviewEmail, createRecruitmentTrace, isRecruitmentBusy, importRecruitmentDemo } = await import('./recruitment.js');
const { readStore, saveStore, readSettings, saveSettings } = await import('./store.js');
after(() => { /* Keep isolated test artifacts under work for inspection. */ });

let sequence = 0;
const mailbox = () => {
  const id = `fixture-${++sequence}`;
  const saved = readSettings();
  saveSettings({ ...saved, mailboxes: [...saved.mailboxes, { id, email: 'sender@example.invalid' }] });
  return id;
};
const settings = { apiKey: 'invented-recruitment-key', authorizationCode: 'invented-mail-code',
  baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic-json', tokenPriceIn: 2, tokenPriceOut: 8, tokenPriceCachedIn: 0 };
const profile = (name = '合成候选人', address = 'candidate@example.invalid', phone = '13800138000') => ({
  personal: { name, email: address, phone, currentCity: '杭州', age: null },
  education: [{ school: '合成上海学院', city: '上海', degree: '本科', graduated: true }],
  projects: [{ name: '云计算平台', description: '在 Kubernetes 上实现云计算资源调度与弹性扩容。' }], skills: ['Kubernetes', 'Go'],
});
function candidateFixture(id, emailId = `synthetic-email-${++sequence}`, input = profile()) {
  const attachment = storeAttachment(id, emailId, { filename: '../synthetic-resume.pdf', content: Buffer.from('%PDF-1.4 synthetic fixture'), contentType: 'application/pdf' }, 0);
  const candidate = ingestResume(id, { id: emailId, mode: 'qq', subject: '合成求职邮件', sender: 'Synthetic <agent@example.invalid>', senderAddress: 'agent@example.invalid' }, attachment, input);
  return { attachment, candidate };
}
function interviewFixture(id, candidate, extra = {}) {
  const interview = { id: `interview-${++sequence}`, candidateId: candidate.id, to: candidate.profile.personal.email,
    subject: '合成面试邀约', body: '您好，请参加面试。\n会议链接：https://meeting.example.invalid/join?invite=fixture',
    start: '2026-10-20T10:00:00+08:00', end: '2026-10-20T11:00:00+08:00', meetingUrl: 'https://meeting.example.invalid/join?invite=fixture',
    meetingSource: 'manual', kind: 'invite', status: 'draft', source: 'email', createdAt: new Date().toISOString(), ...extra };
  updateRecruitment(id, (data) => data.interviews.push(interview));
  return interview;
}
function mockModel(t, answers) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const answer = typeof answers === 'function' ? await answers(body, requests.length) : answers.shift();
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer), reasoning_content: 'NEVER_LOG_PRIVATE_REASONING' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return requests;
}

test('SMTP DATA结果未知持久化防重，重新读取草稿也不能再次发信', async () => {
  const id = mailbox();
  const { candidate } = candidateFixture(id);
  const interview = interviewFixture(id, candidate);
  let calls = 0;
  const sendMail = async () => { calls++; throw Object.assign(new Error('synthetic DATA timeout'), { code: 'ETIMEDOUT', command: 'DATA' }); };
  await assert.rejects(sendInterview(id, interview.id, settings, { sendMail }), /DATA timeout/);
  assert.equal(readRecruitment(id).interviews[0].status, 'unknown');
  await assert.rejects(sendInterview(id, interview.id, settings, { sendMail }), /待核对/);
  assert.equal(calls, 1);
});

test('附件使用稳定ID和本地路径，人才重试去重、新投递保留版本，邮箱互相隔离', () => {
  const id = mailbox();
  const first = candidateFixture(id, 'original-email');
  const repeated = candidateFixture(id, 'original-email');
  assert.equal(first.attachment.id, repeated.attachment.id);
  assert.equal(first.candidate.id, repeated.candidate.id);
  assert.equal(getAttachment(id, first.attachment.id).filename, 'synthetic-resume.pdf');
  assert.equal(readRecruitment(id).candidates[0].versions.length, 1);
  const second = candidateFixture(id, 'new-email', { ...profile(), skills: ['Go', 'Kubernetes', 'Rust'] });
  assert.equal(second.candidate.id, first.candidate.id);
  assert.equal(second.candidate.versions.length, 2);
  assert.deepEqual(second.candidate.profile.skills, ['Go', 'Kubernetes', 'Rust']);
  assert.equal(fs.existsSync(attachmentPath(id, first.attachment.id)), true);
  assert.equal(attachmentPath(id, '../unregistered'), null);
  assert.equal(getAttachment(mailbox(), first.attachment.id), null);
  assert.equal(getRecruitmentState(id).attachments[0].url.includes(first.attachment.id), true);
  assert.equal(readStore(id).events.length, 0);
  assert.equal(readStore(id).tasks.length, 0);
});

test('相同姓名不合并，邮箱与手机命中不同人或姓名冲突保留独立档案并提示核对', () => {
  const id = mailbox();
  const first = candidateFixture(id, 'a', profile('李同学', 'a@example.invalid', '13800000001')).candidate;
  const second = candidateFixture(id, 'b', profile('李同学', 'b@example.invalid', '13800000002')).candidate;
  assert.notEqual(first.id, second.id);
  const conflict = candidateFixture(id, 'c', profile('李同学', 'a@example.invalid', '13800000002')).candidate;
  assert.equal(conflict.contactConflict.candidateIds.length, 2);
  const differentName = candidateFixture(id, 'd', profile('张同学', 'b@example.invalid', '')).candidate;
  assert.ok(differentName.contactConflict);
  const anonymous = candidateFixture(id, 'e', profile('无联系方式同学', '', '')).candidate;
  assert.equal(anonymous.versions.length, 1);
  assert.equal(readRecruitment(id).candidates.length, 5);
});

test('对话实际执行检索工具，校验候选人ID及逐字证据，统计多次模型调用且日志不保存简历正文', async (t) => {
  const id = mailbox();
  const { candidate } = candidateFixture(id);
  const requests = mockModel(t, [
    { action: 'tool', tool: 'search_candidates', arguments: { query: '有云计算经历且上海高校毕业' } },
    { exact: [{ candidateId: candidate.id, matched: ['有云计算项目', '上海高校毕业'], missing: [], evidence: [
      { field: 'projects[0].description', quote: '在 Kubernetes 上实现云计算资源调度' },
      { field: 'education[0].city', quote: '上海' },
    ] }, { candidateId: 'invented-id', matched: ['全部符合'], evidence: [{ field: 'x', quote: '编造' }] }], partial: [] },
    { action: 'answer', content: '找到一位有云计算经历且在上海高校毕业的候选人。' },
  ]);
  const response = await runRecruitmentChat(id, '找有云计算经历且上海高校毕业的同学', settings);
  assert.equal(requests.length, 3);
  assert.equal(response.candidateResults.exact.length, 1);
  assert.equal(response.candidateResults.exact[0].displayName, candidate.profile.personal.name);
  assert.equal(response.candidateResults.exact[0].evidence.length, 2);
  assert.equal(readRecruitment(id).messages.length, 2);
  const trace = readRecruitment(id).traces[0];
  assert.equal(trace.llm_tokens_in, 300);
  assert.equal(trace.llm_tokens_out, 150);
  assert.equal(trace.known_cost_cny, 0.0018);
  const logs = JSON.stringify(trace);
  for (const secret of ['NEVER_LOG_PRIVATE_REASONING', settings.apiKey, candidate.profile.personal.email,
    candidate.profile.personal.phone, candidate.profile.projects[0].description]) assert.equal(logs.includes(secret), false);
  assert.equal(trace.spans.some((span) => span.tool_calls?.some((tool) => tool.name === 'search_candidates')), true);
});

test('来源邮件工具只读取招聘已知邮件，完整正文交模型而日志仅保留字符数', async (t) => {
  const id = mailbox();
  candidateFixture(id, 'known-source');
  saveStore({ events: [], tasks: [], emails: [{ id: 'known-source', subject: '合成投递', body: 'SOURCE_BODY_PRIVATE_SENTINEL：我希望参与云计算岗位。', senderAddress: 'candidate@example.invalid' },
    { id: 'unrelated-mail', subject: '非招聘业务', body: '不应被招聘工具读取。' }] }, id);
  const requests = mockModel(t, [
    { action: 'tool', tool: 'get_source_email', arguments: { emailId: 'unrelated-mail' } },
    { action: 'tool', tool: 'get_source_email', arguments: { emailId: 'known-source' } },
    { action: 'answer', content: '来源邮件说明希望参与云计算岗位。' },
  ]);
  await runRecruitmentChat(id, '查看该同学求职邮件说了什么', settings);
  assert.match(requests[1].messages.at(-1).content, /只能读取人才库/);
  assert.match(requests[2].messages.at(-1).content, /SOURCE_BODY_PRIVATE_SENTINEL/);
  assert.equal(JSON.stringify(readRecruitment(id).traces).includes('SOURCE_BODY_PRIVATE_SENTINEL'), false);
});

test('模型末轮失败仍保留工具已完成的候选人卡和邀约草稿卡', async (t) => {
  const id = mailbox();
  const { candidate } = candidateFixture(id);
  mockModel(t, [
    { action: 'tool', tool: 'search_candidates', arguments: { query: '云计算' } },
    { exact: [{ candidateId: candidate.id, matched: ['云计算'], evidence: [{ field: 'projects[0].name', quote: '云计算平台' }] }], partial: [] },
    { action: 'tool', tool: 'draft_interview', arguments: { candidateId: candidate.id, start: '2026-10-22T14:00:00+08:00', body: '待审核的合成邀请。' } },
    new Error('synthetic final response failed'),
  ]);
  await assert.rejects(runRecruitmentChat(id, '找云计算候选人并准备面试', settings), /final response failed/);
  const failed = readRecruitment(id).messages.at(-1);
  assert.equal(failed.error, true);
  assert.equal(failed.candidateResults.exact.length, 1);
  assert.equal(failed.interviewIds.length, 1);
  assert.equal(readStore(id).events.length, 0);
});

test('检索没有真实证据不展示编造候选人，部分满足保持missing，模型错误保留对话和失败日志', async (t) => {
  const id = mailbox();
  const { candidate } = candidateFixture(id);
  mockModel(t, [
    { action: 'tool', tool: 'search_candidates', arguments: { query: '五年工作经验' } },
    { exact: [{ candidateId: candidate.id, matched: ['五年经验'], missing: [], evidence: [{ quote: '五年工作经验' }] }],
      partial: [{ candidateId: candidate.id, matched: ['有云计算'], missing: ['工作年限未注明'], evidence: [{ quote: '云计算平台', field: 'projects[0].name' }] }] },
    { action: 'answer', content: '未找到完全满足要求的候选人。' },
  ]);
  const result = await runRecruitmentChat(id, '五年工作经验', settings);
  assert.equal(result.candidateResults.exact.length, 0);
  assert.equal(result.candidateResults.partial.length, 1);
  assert.deepEqual(result.candidateResults.partial[0].missing, ['工作年限未注明']);
  t.mock.restoreAll();
  mockModel(t, [new Error(`synthetic model error ${settings.apiKey}`)]);
  await assert.rejects(runRecruitmentChat(id, '继续筛选', settings), /synthetic model error/);
  assert.equal(readRecruitment(id).messages.at(-1).error, true);
  assert.equal(JSON.stringify(readRecruitment(id).traces).includes(settings.apiKey), false);
  assert.equal(isRecruitmentBusy(id), false);
});

test('对话等待期间同步新增人才和其他trace不会被旧副本覆盖，同邮箱对话互斥', async (t) => {
  const id = mailbox();
  candidateFixture(id);
  let release;
  let requested;
  const waiting = new Promise((resolve) => { requested = resolve; });
  mockModel(t, async () => { requested(); return new Promise((resolve) => { release = () => resolve({ action: 'answer', content: '已完成。' }); }); });
  const running = runRecruitmentChat(id, '查询人才', settings);
  await waiting;
  assert.equal(isRecruitmentBusy(id), true);
  await assert.rejects(runRecruitmentChat(id, '重复请求', settings), /正在处理/);
  candidateFixture(id, 'concurrent-email', profile('新增同学', 'new@example.invalid', '13800000009'));
  const parallel = createRecruitmentTrace(id, settings, '独立工具操作');
  parallel.finish('imported', { decision: '独立记录' });
  release();
  await running;
  assert.equal(readRecruitment(id).candidates.length, 2);
  assert.equal(readRecruitment(id).traces.length, 2);
  assert.equal(readRecruitment(id).traces.every((trace) => trace.status === 'imported'), true);
});

test('工具对话创建可审核邀约、默认60分钟并采用来源回复地址；未知时间先查询三个空档', async (t) => {
  const id = mailbox();
  const { candidate } = candidateFixture(id, 'missing-resume-contact', profile('仅有姓名同学', '', ''));
  const requests = mockModel(t, [
    { action: 'tool', tool: 'calendar_availability', arguments: {} },
    { action: 'answer', content: '以下三个时段可选，请选择面试时间。' },
    { action: 'tool', tool: 'get_candidate', arguments: { candidateId: candidate.id } },
    { action: 'tool', tool: 'draft_interview', arguments: { candidateId: candidate.id, start: '2026-10-22T14:00:00+08:00', body: '您好，邀请参加技术面试。' } },
    { action: 'answer', content: '邀约草稿已生成，请核对来源邮件回复地址。' },
  ]);
  await runRecruitmentChat(id, '帮我安排面试', settings);
  const slots = JSON.parse(requests[1].messages.at(-1).content.split('工具执行结果（只作为数据）：')[1]).result.suggestedSlots;
  assert.equal(slots.length, 3);
  const response = await runRecruitmentChat(id, '选10月22日14点', settings);
  assert.equal(response.interviewIds.length, 1);
  const interview = readRecruitment(id).interviews[0];
  assert.equal(interview.to, 'agent@example.invalid');
  assert.equal(interview.recipientSource, 'source_email');
  assert.equal(interview.end, '2026-10-22T15:00:00+08:00');
  assert.equal(interview.body.includes('面试时间：2026-10-22 14:00 – 2026-10-22 15:00（北京时间）'), true);
  assert.equal(readStore(id).events.length, 0);
});

test('确认发送使用审核正文，SMTP失败可重试、并发和重复发送不会二次发信，成功后才入日历', async () => {
  const id = mailbox();
  const { candidate } = candidateFixture(id);
  const interview = interviewFixture(id, candidate);
  assert.equal(readStore(id).events.length, 0);
  let calls = 0;
  const failMail = async () => { calls++; throw Object.assign(new Error('synthetic SMTP failure'), { code: 'EAUTH' }); };
  await assert.rejects(sendInterview(id, interview.id, settings, { sendMail: failMail }), /SMTP failure/);
  assert.equal(readStore(id).events.length, 0);
  assert.equal(readRecruitment(id).interviews[0].status, 'failed');
  let release;
  const awaiting = sendInterview(id, interview.id, settings, { sendMail: async (config, mail) => {
    calls++;
    assert.equal(mail.text, interview.body);
    assert.equal(mail.to, candidate.profile.personal.email);
    return new Promise((resolve) => { release = () => resolve({ messageId: '<synthetic-sent@example.invalid>' }); });
  } });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(sendInterview(id, interview.id, settings, { sendMail: failMail }), /正在发送/);
  assert.throws(() => updateInterview(id, interview.id, { body: '发送中不能改' }), /正在处理/);
  release();
  const sent = await awaiting;
  assert.equal(sent.status, 'sent');
  assert.equal(sent.messageId, '<synthetic-sent@example.invalid>');
  assert.equal(readStore(id).events.length, 1);
  await sendInterview(id, interview.id, settings, { sendMail: failMail });
  assert.equal(calls, 2);
  assert.equal(readStore(id).events.length, 1);
  assert.equal(readStore(id).events[0].source, 'recruitment');
});

test('邮件已发送但日历保存失败时，下次仅补日历，保留原审批正文和真实SMTP结果', async () => {
  const id = mailbox();
  const { candidate } = candidateFixture(id);
  const interview = interviewFixture(id, candidate);
  let calls = 0;
  const sendMail = async () => { calls++; return { messageId: '<sent-calendar-failure@example.invalid>' }; };
  const first = await sendInterview(id, interview.id, settings, { sendMail, saveCalendar: () => { throw new Error('synthetic disk failure'); } });
  assert.equal(first.status, 'sent');
  assert.equal(first.calendarStatus, 'failed');
  assert.equal(readStore(id).events.length, 0);
  const second = await sendInterview(id, interview.id, settings, { sendMail });
  assert.equal(second.calendarStatus, 'saved');
  assert.equal(calls, 1);
  assert.equal(readStore(id).events.length, 1);
});

test('同场面试的并行改期与取消共享发送锁，旧草稿不能覆盖已更新安排', async () => {
  const id = mailbox();
  const { candidate } = candidateFixture(id);
  const original = interviewFixture(id, candidate);
  const sent = await sendInterview(id, original.id, settings, { sendMail: async () => ({ messageId: '<original-shared@example.invalid>' }) });
  const first = interviewFixture(id, candidate, { kind: 'reschedule', previousInterviewId: sent.id,
    start: '2026-10-22T10:00:00+08:00', end: '2026-10-22T11:00:00+08:00' });
  const second = interviewFixture(id, candidate, { kind: 'reschedule', previousInterviewId: sent.id,
    start: '2026-10-23T10:00:00+08:00', end: '2026-10-23T11:00:00+08:00' });
  const cancel = interviewFixture(id, candidate, { kind: 'cancel', previousInterviewId: sent.id, meetingUrl: '', body: '审核的取消通知。' });
  let release;
  let calls = 0;
  const pending = sendInterview(id, first.id, settings, { sendMail: async () => {
    calls++;
    return new Promise((resolve) => { release = () => resolve({ messageId: '<latest-shared@example.invalid>' }); });
  } });
  await new Promise((resolve) => setImmediate(resolve));
  const mustNotSend = async () => { calls++; assert.fail('stale or concurrent draft must not call SMTP'); };
  await assert.rejects(sendInterview(id, second.id, settings, { sendMail: mustNotSend }), /原面试.*正在发送/);
  await assert.rejects(sendInterview(id, cancel.id, settings, { sendMail: mustNotSend }), /原面试.*正在发送/);
  release();
  await pending;
  await assert.rejects(sendInterview(id, second.id, settings, { sendMail: mustNotSend }), /已有更新后的安排/);
  await assert.rejects(sendInterview(id, cancel.id, settings, { sendMail: mustNotSend }), /已有更新后的安排/);
  assert.equal(calls, 1);
  assert.equal(readStore(id).events.filter((event) => event.status !== 'cancelled').length, 1);
  assert.equal(readStore(id).events.find((event) => event.status !== 'cancelled').start, first.start);
  assert.equal(isRecruitmentBusy(id), false);
});

test('原面试尚待补写日历时不可发送后续改期，真实面试不与示例日程标记冲突', async () => {
  const id = mailbox();
  const { candidate } = candidateFixture(id);
  const original = interviewFixture(id, candidate);
  saveStore({ events: [{ id: 'demo-conflict', title: '预置示例安排', start: original.start, end: original.end, source: 'demo' }], tasks: [], emails: [] }, id);
  const sent = await sendInterview(id, original.id, settings, { sendMail: async () => ({ messageId: '<pending-calendar@example.invalid>' }),
    saveCalendar: () => { throw new Error('synthetic write failure'); } });
  const followup = interviewFixture(id, candidate, { kind: 'reschedule', previousInterviewId: sent.id });
  await assert.rejects(sendInterview(id, followup.id, settings, { sendMail: async () => assert.fail('repair the original calendar first') }), /先补写日历/);
  await sendInterview(id, original.id, settings, { sendMail: async () => assert.fail('calendar repair must not resend') });
  const event = readStore(id).events.find((item) => item.source === 'recruitment');
  assert.equal(event.hasConflict, undefined);
  assert.equal(readStore(id).events.find((item) => item.id === 'demo-conflict').status, undefined);
});

test('真实会议创建更新可见草稿，重复保存不清准备状态；修改时间要求重新准备，失败可手填链接', async () => {
  const id = mailbox();
  const { candidate } = candidateFixture(id);
  const interview = interviewFixture(id, candidate, { meetingSource: null, meetingUrl: '', body: '完整邀请草稿。' });
  let creates = 0;
  const dependencies = { prepareMeeting: async () => { creates++; return { id: 'synthetic-reserve', url: 'https://vc.example.invalid/join?code=synthetic' }; } };
  const ready = await prepareInterviewMeeting(id, interview.id, settings, dependencies);
  assert.equal(ready.body.includes(ready.meetingUrl), true);
  updateInterview(id, interview.id, { start: ready.start, end: ready.end, meetingUrl: ready.meetingUrl, body: ready.body });
  await prepareInterviewMeeting(id, interview.id, settings, dependencies);
  assert.equal(creates, 1);
  const changed = updateInterview(id, interview.id, { start: '2026-10-21T10:00:00+08:00', end: '2026-10-21T11:00:00+08:00' });
  assert.equal(changed.meetingPreparedFor, null);
  assert.equal(changed.body.includes('面试时间：2026-10-21 10:00 – 2026-10-21 11:00（北京时间）'), true);
  await assert.rejects(sendInterview(id, interview.id, settings, { sendMail: async () => assert.fail('stale meeting must not send') }), /时间已变化/);
  await assert.rejects(prepareInterviewMeeting(id, interview.id, settings, { prepareMeeting: async () => { throw new Error('synthetic Feishu failure'); } }), /Feishu failure/);
  const manual = updateInterview(id, interview.id, { meetingUrl: 'https://meeting.example.invalid/manual' });
  assert.equal(manual.meetingSource, 'manual');
  assert.equal(manual.body.includes(manual.meetingUrl), true);
  assert.equal(manual.body.includes(ready.meetingUrl), false);
});

test('面试改期来信关联原线程、生成审核稿，不自动改日历；确认发送后取消旧安排并关联新安排', async (t) => {
  const id = mailbox();
  const { candidate } = candidateFixture(id);
  const original = interviewFixture(id, candidate);
  const sent = await sendInterview(id, original.id, settings, { sendMail: async () => ({ messageId: '<interview-thread@example.invalid>' }) });
  mockModel(t, [{ kind: 'reschedule', summary: '希望改到次日十点。', start: '2026-10-21T10:00:00+08:00', end: '2026-10-21T11:00:00+08:00', body: '同意调整面试时间，待HR审核。' }]);
  const email = { id: 'reply-change', subject: 'Re: 面试邀约', senderAddress: candidate.profile.personal.email,
    body: '可以改为明天10点吗？', messageId: '<candidate-change@example.invalid>', references: [sent.messageId], receivedAt: '2026-10-20T09:00:00+08:00' };
  const handled = await handleInterviewEmail(id, email, settings);
  assert.equal(handled.kind, 'reschedule');
  assert.equal(readStore(id).events.length, 1);
  assert.equal(readStore(id).events[0].status, 'active');
  const draft = readRecruitment(id).interviews.find((item) => item.id === handled.interviewIds[0]);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.suggestedSlots.length, 3);
  assert.equal(draft.conflicts.length, 0);
  assert.equal(readRecruitment(id).traces.some((trace) => trace.spans.some((span) => span.tool_calls.some((tool) => tool.name === 'calendar_availability'))), true);
  updateInterview(id, draft.id, { body: `${draft.body}\n${draft.meetingUrl}` });
  await sendInterview(id, draft.id, settings, { sendMail: async (config, mail) => {
    assert.equal(mail.inReplyTo, email.messageId);
    assert.equal(mail.references.includes(sent.messageId), true);
    return { messageId: '<new-interview@example.invalid>' };
  } });
  const events = readStore(id).events;
  assert.equal(events.length, 2);
  assert.equal(events.find((event) => event.id === sent.eventId).status, 'cancelled');
  assert.equal(events.find((event) => event.status === 'active').previousEventId, sent.eventId);
  const repeated = await handleInterviewEmail(id, email, settings);
  assert.equal(repeated.kind, 'recorded');
  assert.equal(readRecruitment(id).interviews.length, 2);
  const secondReply = { ...email, id: 'reply-again', messageId: '<candidate-second@example.invalid>', references: [sent.messageId, '<new-interview@example.invalid>'] };
  t.mock.restoreAll();
  mockModel(t, [{ kind: 'confirm', summary: '确认最新时间。' }]);
  const confirmed = await handleInterviewEmail(id, secondReply, settings);
  assert.equal(confirmed.kind, 'confirm');
  assert.deepEqual(confirmed.interviewIds, [draft.id]);
});

test('面试确认只记录结果，普通同发件人邮件不劫持；含糊面试请求拦截后交由HR核对', async (t) => {
  const id = mailbox();
  const { candidate } = candidateFixture(id);
  const original = interviewFixture(id, candidate);
  const sent = await sendInterview(id, original.id, settings, { sendMail: async () => ({ messageId: '<confirmed-thread@example.invalid>' }) });
  assert.equal(await handleInterviewEmail(id, { id: 'normal', senderAddress: original.to, subject: '项目资料', body: '普通正文' }, settings), null);
  mockModel(t, [{ kind: 'confirm', summary: '候选人确认准时参加。' }]);
  const confirmation = await handleInterviewEmail(id, { id: 'confirm', senderAddress: original.to, subject: 'Re: 邀请', body: '确认参加。', references: [sent.messageId] }, settings);
  assert.equal(confirmation.kind, 'confirm');
  assert.equal(readRecruitment(id).interviews.length, 1);
  interviewFixture(id, candidate, { status: 'sent', messageId: '<second-thread@example.invalid>' });
  const ambiguous = await handleInterviewEmail(id, { id: 'ambiguous', senderAddress: original.to, subject: '面试问题', body: '能改时间吗？' }, settings);
  assert.equal(ambiguous.kind, 'needs_review');
  assert.equal(readRecruitment(id).messages.at(-1).needsReview, true);
  assert.equal(readStore(id).events.length, 1);
});

test('候选人取消来信先生成审核草稿，发送无需会议链接，成功后才取消原日程', async (t) => {
  const id = mailbox();
  const { candidate } = candidateFixture(id);
  const original = interviewFixture(id, candidate);
  const sent = await sendInterview(id, original.id, settings, { sendMail: async () => ({ messageId: '<cancel-thread@example.invalid>' }) });
  mockModel(t, [{ kind: 'cancel', summary: '候选人申请取消。', body: '您好，已知悉取消面试。' }]);
  const reply = await handleInterviewEmail(id, { id: 'cancel-mail', subject: '取消面试', body: '申请取消。', references: [sent.messageId] }, settings);
  assert.equal(reply.kind, 'cancel');
  assert.equal(readStore(id).events[0].status, 'active');
  updateInterview(id, reply.interviewIds[0], { meetingUrl: '', body: '您好，已知悉取消面试。' });
  await sendInterview(id, reply.interviewIds[0], settings, { sendMail: async () => ({ messageId: '<cancel-sent@example.invalid>' }) });
  assert.equal(readStore(id).events.length, 1);
  assert.equal(readStore(id).events[0].status, 'cancelled');
});

test('预置示例生成真实PDF与三份档案，重复导入去重，绝不调用模型或SMTP', async (t) => {
  const id = mailbox();
  t.mock.method(globalThis, 'fetch', async () => assert.fail('preset import must not use network'));
  const demo = await importRecruitmentDemo(id);
  assert.equal(demo.added, 3);
  assert.equal(demo.candidates.length, 3);
  assert.equal(demo.candidates.every((candidate) => candidate.source === 'demo'), true);
  assert.equal(demo.attachments.every((attachment) => fs.readFileSync(attachmentPath(id, attachment.id)).subarray(0, 4).toString() === '%PDF'), true);
  assert.equal((await importRecruitmentDemo(id)).added, 0);
  assert.equal(readStore(id).events.length, 0);
  assert.equal(readStore(id).emails.length, 3);
  assert.equal(readRecruitment(id).traces[0].mode, 'demo');
  const interview = interviewFixture(id, demo.candidates[0], { source: 'demo' });
  await assert.rejects(sendInterview(id, interview.id, settings), /预置示例/);
  await assert.rejects(prepareInterviewMeeting(id, interview.id, settings), /预置示例/);
  assert.equal(readStore(id).emails.every((email) => email.attachments.length === 1 && email.candidateIds.length === 1), true);
});

test('示例邀约经显式审核后按编辑邮箱真实发送，失败可重试，成功后保留示例来源并防重复', async (t) => {
  const id = mailbox();
  t.mock.method(globalThis, 'fetch', async () => assert.fail('reviewing a preset must not call the model'));
  const { candidates } = await importRecruitmentDemo(id);
  const candidate = candidates[0];
  const interview = interviewFixture(id, candidate, { source: 'demo',
    subject: '【演示草稿·不可发送】合成面试邀约',
    meetingUrl: '12312312',
    body: '【预置演示草稿，仅供HR审核演示，不可发送真实邮件】\n您好，请参加面试。\n\n以上内容仅用于演示，不构成真实面试安排。\n\n会议号：12312312' });
  const mustNotSend = async () => assert.fail('an unreviewed preset must not reach SMTP');
  await assert.rejects(sendInterview(id, interview.id, settings, { sendMail: mustNotSend }), /预置示例|审核|确认/);
  updateInterview(id, interview.id, { to: 'reviewed-recipient@daylight-test.com' });
  await assert.rejects(sendInterview(id, interview.id, settings, { confirmDemoSend: true, sendMail: mustNotSend }), /演示|审核|保存|核对/);
  const reviewed = updateInterview(id, interview.id, { confirmDemoSend: true });
  assert.equal(reviewed.subject, '合成面试邀约');
  assert.doesNotMatch(reviewed.body, /预置演示|不可发送|仅用于演示/);
  assert.match(reviewed.body, /您好，请参加面试。/);
  assert.match(reviewed.body, /会议号：12312312/);
  assert.equal(reviewed.source, 'demo', '审核不把示例资料伪装为真实来源');
  updateInterview(id, interview.id, { to: candidate.profile.personal.email });
  await assert.rejects(sendInterview(id, interview.id, settings, { confirmDemoSend: true, sendMail: mustNotSend }), /邮箱|地址|收件人|占位/);
  updateInterview(id, interview.id, { to: reviewed.to });
  let attempts = 0;
  await assert.rejects(sendInterview(id, interview.id, settings, { confirmDemoSend: true, sendMail: async () => {
    attempts++;
    throw Object.assign(new Error('synthetic SMTP temporarily unavailable'), { code: 'ECONNREFUSED' });
  } }), /SMTP temporarily unavailable/);
  const failed = readRecruitment(id).interviews.find((item) => item.id === interview.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.source, 'demo');
  assert.equal(readStore(id).events.length, 0);
  await assert.rejects(sendInterview(id, interview.id, settings, { sendMail: mustNotSend }), /预置示例|审核|确认/);
  const sent = await sendInterview(id, interview.id, settings, { confirmDemoSend: true, sendMail: async (config, mail) => {
    attempts++;
    assert.equal(mail.to, reviewed.to);
    assert.equal(mail.subject, reviewed.subject);
    assert.equal(mail.text, reviewed.body);
    return { messageId: '<reviewed-demo@example.invalid>' };
  } });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.source, 'manual');
  assert.equal(sent.originalSource, 'demo');
  assert.equal(readRecruitment(id).candidates.find((item) => item.id === candidate.id).source, 'demo');
  assert.equal(readStore(id).events.length, 1);
  assert.equal(readStore(id).events[0].source, 'recruitment');
  await sendInterview(id, interview.id, settings, { sendMail: mustNotSend });
  assert.equal(attempts, 2);
  assert.equal(readStore(id).events.length, 1);
});

test('手工邀约的会议资料可留空，未创建线上会议也可审核发送', async () => {
  const id = mailbox();
  const { candidate } = candidateFixture(id);
  const original = interviewFixture(id, candidate, { meetingUrl: '', meetingSource: null, body: '您好，邀请您参加面试，地点另行通知。' });
  const sent = await sendInterview(id, original.id, settings, { sendMail: async (config, mail) => {
    assert.equal(mail.text, original.body);
    return { messageId: '<without-meeting@example.invalid>' };
  } });
  assert.equal(sent.status, 'sent');
  assert.equal(readStore(id).events[0].location, '');
});

test('示例人才的实发邀约按真实来信生成可发送改期稿，继承实发来源及编辑后的邮箱', async (t) => {
  const id = mailbox();
  const { candidates } = await importRecruitmentDemo(id);
  const candidate = candidates[0];
  const original = interviewFixture(id, candidate, { source: 'demo', to: 'reviewed-recipient@daylight-test.com' });
  const sent = await sendInterview(id, original.id, settings, { confirmDemoSend: true,
    sendMail: async () => ({ messageId: '<reviewed-demo-thread@example.invalid>' }) });
  mockModel(t, [
    { action: 'tool', tool: 'draft_interview', arguments: { candidateId: candidate.id, kind: 'reschedule', previousInterviewId: sent.id,
      start: '2026-10-21T10:00:00+08:00', body: '您好，请核对调整后的面试时间。' } },
    { action: 'answer', content: '已准备改期草稿。' },
  ]);
  const proposed = await runRecruitmentChat(id, '为已发送的面试准备次日改期草稿', settings);
  const proposedDraft = readRecruitment(id).interviews.find((item) => item.id === proposed.interviewIds[0]);
  assert.equal(proposedDraft.to, original.to, '未指定收件人时沿用实发邮箱，不回退到示例简历占位邮箱');
  assert.equal(proposedDraft.source, 'manual');
  assert.equal(proposedDraft.originalSource, 'demo');
  t.mock.restoreAll();
  mockModel(t, [{ kind: 'reschedule', summary: '合成回信申请调整面试时间。', start: '2026-10-21T10:00:00+08:00',
    end: '2026-10-21T11:00:00+08:00', body: '您好，确认新的面试时间。' }]);
  const email = { id: 'real-reply-to-demo-invite', senderAddress: original.to, subject: 'Re: Interview',
    body: 'Please move the interview to tomorrow.', messageId: '<reply-to-reviewed-demo@example.invalid>', references: [sent.messageId] };
  const reply = await handleInterviewEmail(id, email, settings);
  assert.equal(reply.kind, 'reschedule');
  const draft = readRecruitment(id).interviews.find((item) => item.id === reply.interviewIds[0]);
  assert.equal(draft.source, 'manual');
  assert.equal(draft.to, original.to);
  assert.equal(draft.previousInterviewId, sent.id);
  assert.equal(readStore(id).events[0].status, 'active', '收到来信后继续等待HR审核');
  const changed = await sendInterview(id, draft.id, settings, { sendMail: async (config, mail) => {
    assert.equal(mail.to, original.to);
    assert.equal(mail.inReplyTo, email.messageId);
    assert.ok(mail.references.includes(sent.messageId));
    return { messageId: '<reviewed-demo-rescheduled@example.invalid>' };
  } });
  assert.equal(changed.status, 'sent');
  const events = readStore(id).events;
  assert.equal(events.find((item) => item.id === sent.eventId).status, 'cancelled');
  assert.equal(events.find((item) => item.id === changed.eventId).previousEventId, sent.eventId);
});
