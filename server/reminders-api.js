/**
 * 提醒规则解析接口：把一句自然语言解析成手机端能直接执行的提醒规则。
 *
 * 边界刻意划得很窄，因为提醒规则本身存在设备侧（iOS 本地通知），服务端不保存任何规则：
 * - 无状态：只做「文本 → 结构化规则」，不读也不写业务数据；
 * - 不建日程、不建待办、不发信：这里只解析意图，是否保存由用户在手机上确认；
 * - 复用已配置的模型（callJsonModel，JSON 模式 + 一次格式修正），模型产出的字段一律
 *   过一遍 shared/reminder-rules.js 的归一化，越界值截断而不是报错。
 */
import { Router } from 'express';
import { callJsonModel } from './model-json.js';
import { getRequestContext } from './request-context.js';
import { readSettings } from './store.js';
import {
  DEFAULT_WINDOW, MAX_RULES, REMINDER_TARGETS, describeRule, formatBeijingDate, normalizeRule,
} from '../shared/reminder-rules.js';

export const reminderRouter = Router();
reminderRouter.use((req, res, next) => (req.user ? next() : res.status(401).json({ error: '请先登录' })));
const route = (fn) => async (req, res, next) => { try { res.json(await fn(req)); } catch (error) { next(error); } };

const MAX_TEXT = 500;

const SYSTEM_PROMPT = [
  '你要把用户的一句话，翻译成 Daylight 的「提醒规则」。',
  '规则作用在手机端：规则命中某个有截止时间的条目后，会在截止前的若干个时间点发系统通知。',
  '',
  '只输出 JSON：{"rules":[...],"reply":"给用户看的一句话中文说明"}。',
  '每条规则的字段：',
  '- name: 2-6 个字的规则名，概括这件事（例如「作业」「报名」「会议」）。',
  `- targets: 数组，取值只能是 ${REMINDER_TARGETS.map((target) => target.id).join(' / ')}。`,
  '  event=日程开始时间；task=待办截止时间；action=工作台里的行动（报名、材料提交等）截止；',
  '  mail=邮件里识别到、还没变成待办的截止时间。',
  '  用户说「会议/日程/面试」时用 event；说「待办/作业/任务」时用 task；',
  '  说「报名/材料/提交/申请」时用 action 和 task、mail 一起兜底；不确定就四项都给。',
  '- keywords: 字符串数组，标题/摘要里的关键词，用来限定提醒对象（例如 ["作业"]、["报名","夏令营"]）。',
  '  用户表达「所有/全部/任意」时给空数组 []，表示该类目全部都要提醒。关键词要短（1-6 个字），不要写成整句话。',
  '- excludeKeywords: 字符串数组，命中就跳过（例如 ["已取消"]）。通常给 []。',
  '- matchAll: 关键词是否必须全部命中，默认 false。',
  '- offsets: 数组，每项是 {"value":数字,"unit":"minute"|"hour"|"day"}，表示在截止时间之前多久提醒；',
  '  可以有多项（例如 [{"value":3,"unit":"day"},{"value":1,"unit":"day"},{"value":4,"unit":"hour"}]）。',
  '  用户说「提前 3 天、1 天、4 小时」就原样给三项。用户没提提前量时给 [{"value":1,"unit":"day"}]。',
  '  注意 offsets 是相对截止时间的提前量，不要换算成具体日期，也不要输出绝对时间。',
  '- window: 允许提醒的时间段 {"start":"08:00","end":"22:00"}，落在段外会顺延到当天该段的开始。',
  '  用户没提就省略（客户端用默认 ' + `${DEFAULT_WINDOW.start}-${DEFAULT_WINDOW.end}` + '）。用户说「不要半夜提醒」「只在工作时间」时可给 09:00-21:00 这类值。必须 start 早于 end。',
  '- overdue: {"enabled":true|false,"everyDays":1-7}，过期后是否每隔几天再提醒一次；用户没提就给 {"enabled":false}。',
  '',
  '用户一句话里描述了几件事，就返回几条规则（最多 3 条）。不要合并不同性质的提醒。',
  '不要编造用户没提到的关键词；不要把提醒规则写成邮件或待办。reply 用一句中文说明你配置了什么。',
].join('\n');

function buildMessages({ text, existing, now }) {
  const lines = [
    `今天是北京时间 ${formatBeijingDate(now, { time: true })}。`,
    existing.length ? `用户已有的规则名（避免重复建议）：${existing.join('、')}。` : '用户目前还没有提醒规则。',
    `用户说：${text}`,
  ];
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

function normalizeParsed(result) {
  const source = Array.isArray(result?.rules) ? result.rules : (Array.isArray(result) ? result : []);
  const rules = source.slice(0, MAX_RULES).map((rule) => normalizeRule(rule));
  const reply = String(result?.reply || result?.notes || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return { rules, reply };
}

export async function parseReminderText({ text, existing = [], now = Date.now() } = {}) {
  const settings = readSettings();
  if (!settings.baseUrl || !settings.apiKey || !settings.model) {
    const error = new Error('还未配置模型接口与 API Key，先在设置里连上模型才能用一句话设置提醒。');
    error.status = 409;
    throw error;
  }
  const result = await callJsonModel(settings, buildMessages({ text, existing, now }), {
    context: getRequestContext(),
    label: '解析提醒规则',
    timeoutMs: 60_000,
  });
  const parsed = normalizeParsed(result);
  if (!parsed.rules.length) {
    const error = new Error('没能从这句话里读出提醒条件，换一种说法再试一次（例如「作业提前 3 天、1 天、4 小时提醒我」）。');
    error.status = 502;
    throw error;
  }
  return parsed;
}

reminderRouter.post('/parse', route(async (req) => {
  const text = String(req.body?.text || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    const error = new Error('请先描述你的提醒偏好。');
    error.status = 400;
    throw error;
  }
  if (text.length > MAX_TEXT) {
    const error = new Error(`描述太长了，请控制在 ${MAX_TEXT} 字以内。`);
    error.status = 400;
    throw error;
  }
  const existing = (Array.isArray(req.body?.existing) ? req.body.existing : [])
    .map((name) => String(name || '').trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 20);
  const parsed = await parseReminderText({ text, existing });
  // 顺带回一句人话，客户端可以直接展示，也便于用户核对解析结果。
  return {
    rules: parsed.rules,
    reply: parsed.reply || `已准备好 ${parsed.rules.length} 条提醒规则，确认后保存在手机上。`,
    summary: parsed.rules.map((rule) => `${rule.name}：${describeRule(rule)}`),
  };
}));
