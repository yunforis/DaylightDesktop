/**
 * 新手引导步骤。
 * 启用 PostgreSQL 时权威存 app_settings.id = 'onboarding-guide'；
 * JSON（data/onboarding-guide.json）仅供无 PG 的本机演示；PG 故障不回退。
 * 字段：id / title / text / tips[] / path / selector / audience(all|hr|personal)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPostgresPool, postgresMode } from './infra/postgres.js';
import { isProductionRuntime, requireLocalRuntime } from './runtime-mode.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.DAYLIGHT_DATA_DIR || path.join(root, 'data');
const filePath = path.join(dataDir, 'onboarding-guide.json');
const PG_ID = 'onboarding-guide';

export const DEFAULT_ONBOARDING_STEPS = [
  {
    id: 'settings',
    audience: 'all',
    selector: '[data-tour="settings"]',
    path: '/app/settings',
    title: '第一步：配好邮箱与模型',
    text: '注册成功后会用你的注册邮箱预填收信地址。请到邮箱后台生成 IMAP 授权码并保存，再配置模型 API Key。保存后顶栏「同步」才可用。',
    tips: ['授权码不是网页登录密码', '模型需支持 JSON Object 输出', '可给邮箱打「工作 / 个人」标签'],
  },
  {
    id: 'sync',
    audience: 'all',
    selector: '[data-tour="sync"]',
    path: '/app',
    title: '第二步：同步最近邮件',
    text: '点顶栏「同步」拉取最近 N 封邮件。模型会识别新邀请、取消与改期，写入日历与待办；已成功处理过的邮件 ID 不会重复提取。',
    tips: ['也可 ⌘J / 配置的快捷键打开命令面板同步', '演示数据可先导入示例，不连真实邮箱'],
  },
  {
    id: 'overview',
    audience: 'all',
    selector: '[data-tour="overview-stats"]',
    path: '/app',
    title: '总览：一眼看到今天',
    text: '总览汇总今日安排、待办、冲突与已处理邮件。有冲突时点进「邮件」处理；也可从这里导入演示数据体验完整流程。',
    tips: ['数字卡片可点击跳转', '首次建议先跑一遍「导入示例邮件」'],
  },
  {
    id: 'calendar',
    audience: 'all',
    selector: '[data-tour="calendar"]',
    path: '/app/calendar',
    title: '日历：查看与新建安排',
    text: '用日 / 周 / 月视图浏览日程。月视图里悬停日期格出现 ➕，只点 ➕ 新建（不会误触整格）。取消的日程会保留并标为已取消；改期会关联新旧事件。',
    tips: ['侧栏可筛选工作 / 生活分类', '点日程可打开详情与关联邮件'],
  },
  {
    id: 'mail',
    audience: 'all',
    selector: '[data-tour="mail"]',
    path: '/app/mail',
    title: '邮件：读原文与处理结果',
    text: '按会议 / 任务 / 通知 / 求职等分类筛选。打开一封邮件可看完整元数据、模型摘要与冲突提示；需要时采纳草稿并经当前邮箱 SMTP 真实回信。',
    tips: ['冲突数量会显示在侧栏角标', '求职简历不会创建普通日程'],
  },
  {
    id: 'todos',
    audience: 'all',
    selector: '[data-tour="todos"]',
    path: '/app/todos',
    title: '待办：跟进邮件里的行动项',
    text: '邮件提取出的待办会出现在这里。勾选完成、右键快捷操作，或跳回来源邮件核对上下文。',
    tips: ['待办与当前邮箱视图隔离', '混合邮箱视图可看全部'],
  },
  {
    id: 'workbenches',
    audience: 'all',
    selector: '[data-tour="workbenches"]',
    path: '/app/workbenches',
    title: '工作台：按场景处理邮件',
    text: '在「我的工作台」使用发票助手、智能招聘和场景工作台。点击「调整工作台」显示或隐藏功能入口，也可以添加保研、申博、校招或投稿工作台。',
    tips: ['隐藏入口会保留已有数据', '同一模板可以建多个工作台', '确认关联邮件不会自动发信'],
  },
  {
    id: 'traces',
    audience: 'all',
    selector: '[data-tour="traces"]',
    path: '/app/traces',
    title: '执行日志：回放证据链',
    text: '每次同步与模型调用都会留下 trace。出了问题可在这里看决策、用量与失败原因，区分真实同步与示例导入。',
    tips: ['可按真实 / 示例筛选', '便于核对「为什么进了日历」'],
  },
  {
    id: 'assistant',
    audience: 'all',
    selector: '[data-tour="little-d"]',
    path: '/app',
    title: '小 D 与全局搜索',
    text: '右下角「小 D」可以起草邮件并在你审核后真实发送、安排飞书会议和日程、整理过去几天已保存邮件的简报，也能管理日程待办与检索简历。打开「能做什么」体验预设提示，写入类提示会先放进输入框供你核对。',
    tips: ['模型需支持工具调用；发信需当前邮箱 SMTP，建会需飞书配置', '邮件在审核卡点击确认后才发出', '支持语音转文字；可在设置里改搜索快捷键'],
  },
];

const LEGACY_WORKBENCH_DEFAULT_TEXTS = new Set([
  '从官方模板添加保研、申博、校招、投稿或智能招聘工作台。智能招聘的候选人、简历和邀约仍在对应工作台里使用，侧栏不再单独放入口。',
  '在「我的工作台」使用发票助手和场景工作台。点击「调整工作台」添加保研、申博、校招、投稿或智能招聘工作台，也可以隐藏暂时不用的功能。',
]);
const LEGACY_ASSISTANT_DEFAULT_TEXT = '右下角「小 D」打开后会列出当前能力：北京时间、日程、待办、已处理邮件和已入库简历。查询类提示可以直接试，写入类提示会先放进输入框。不能代发邮件，也不能创建飞书会议。';

function normalizeStep(raw = {}, index = 0) {
  const id = String(raw.id || `step_${index + 1}`).trim() || `step_${index + 1}`;
  const audience = ['all', 'hr', 'personal'].includes(raw.audience) ? raw.audience : 'all';
  const tips = Array.isArray(raw.tips)
    ? raw.tips.map((tip) => String(tip || '').trim()).filter(Boolean)
    : String(raw.tipsText || '')
      .split(/\n+/)
      .map((tip) => tip.trim())
      .filter(Boolean);
  const step = {
    id,
    audience,
    selector: String(raw.selector || '').trim() || '[data-tour="overview"]',
    path: String(raw.path || '').trim() || '/app',
    title: String(raw.title || '').trim() || `步骤 ${index + 1}`,
    text: String(raw.text || '').trim(),
    tips,
  };
  if (step.id === 'workbenches' && LEGACY_WORKBENCH_DEFAULT_TEXTS.has(step.text)) {
    step.text = DEFAULT_ONBOARDING_STEPS.find((item) => item.id === 'workbenches').text;
  }
  if (step.id === 'assistant' && step.text === LEGACY_ASSISTANT_DEFAULT_TEXT) {
    const current = DEFAULT_ONBOARDING_STEPS.find((item) => item.id === 'assistant');
    step.text = current.text;
    const originalTips = ['需要已配置支持工具调用的模型', '支持语音输入（浏览器权限）', '设置里可改搜索快捷键'];
    if (JSON.stringify(step.tips) === JSON.stringify(originalTips)) step.tips = [...current.tips];
  }
  const removedEntry = step.id === 'recruitment'
    || step.path === '/app/recruitment'
    || step.selector === '[data-tour="recruitment"]';
  if (!removedEntry) return step;
  if (step.id !== 'recruitment') {
    return { ...step, audience: 'all', selector: '[data-tour="workbenches"]', path: '/app/workbenches' };
  }
  return {
    id: 'workbenches',
    audience: 'all',
    selector: '[data-tour="workbenches"]',
    path: '/app/workbenches',
    title: '工作台：按场景处理邮件',
    text: '发票助手和智能招聘是并列的功能入口，可在「调整工作台」显示或隐藏。还可以从模板添加保研、申博、校招或投稿工作台。',
    tips: ['同一模板可以建多个工作台', '确认关联邮件不会自动发信'],
  };
}

function ensureFile() {
  requireLocalRuntime('File-backed onboarding guide');
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${JSON.stringify({ steps: DEFAULT_ONBOARDING_STEPS }, null, 2)}\n`);
  }
}

function normalizeGuide(raw) {
  const steps = Array.isArray(raw?.steps) ? raw.steps.map(normalizeStep) : [];
  if (!steps.length) return defaultOnboardingGuide();
  return { steps };
}

function writeJsonCache(payload) {
  ensureFile();
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readJsonCache() {
  ensureFile();
  try {
    return normalizeGuide(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return defaultOnboardingGuide();
  }
}

function pgReady() {
  if (isProductionRuntime() && !getPostgresPool()) {
    throw Object.assign(new Error('PostgreSQL onboarding guide is unavailable'), { status: 503 });
  }
  return postgresMode() === 'postgres' && Boolean(getPostgresPool());
}

async function loadFromPg() {
  const pool = getPostgresPool();
  if (!pool) return null;
  const { rows } = await pool.query(
    'select payload from app_settings where id = $1 limit 1',
    [PG_ID],
  );
  return rows[0]?.payload || null;
}

async function saveToPg(payload) {
  const pool = getPostgresPool();
  if (!pool) return false;
  await pool.query(
    `insert into app_settings (id, payload, updated_at)
     values ($1, $2::jsonb, $3)
     on conflict (id) do update
       set payload = excluded.payload, updated_at = excluded.updated_at, version = app_settings.version + 1`,
    [PG_ID, JSON.stringify(payload), new Date().toISOString()],
  );
  return true;
}

function validateSteps(list) {
  const steps = list.map(normalizeStep);
  if (!steps.length) throw Object.assign(new Error('至少保留一步引导'), { status: 400 });
  const ids = new Set();
  for (const step of steps) {
    if (ids.has(step.id)) throw Object.assign(new Error(`步骤 id 重复：${step.id}`), { status: 400 });
    ids.add(step.id);
  }
  return steps;
}

export function defaultOnboardingGuide() {
  return { steps: structuredClone(DEFAULT_ONBOARDING_STEPS) };
}

/** 同步读本地缓存（无 PG / 启动早期）；优先用 async 版。 */
export function readOnboardingGuide() {
  return readJsonCache();
}

export async function readOnboardingGuideAsync() {
  if (pgReady()) {
      const payload = await loadFromPg();
      if (payload?.steps?.length) {
        const guide = normalizeGuide(payload);
        return { ...guide, storage: 'postgres' };
      }
      // A new instance cannot import stale files or overwrite a concurrent admin edit.
      const initial = isProductionRuntime() ? defaultOnboardingGuide() : readJsonCache();
      await getPostgresPool().query(
        `insert into app_settings (id, payload, updated_at) values ($1, $2::jsonb, $3)
         on conflict (id) do nothing`,
        [PG_ID, JSON.stringify(initial), new Date().toISOString()],
      );
      return { ...normalizeGuide(await loadFromPg()), storage: 'postgres' };
  }
  return { ...readJsonCache(), storage: 'file' };
}

export async function saveOnboardingGuide(incoming = {}) {
  const list = Array.isArray(incoming.steps) ? incoming.steps : Array.isArray(incoming) ? incoming : [];
  const payload = { steps: validateSteps(list) };
  if (pgReady()) {
    await saveToPg(payload);
    return { ...payload, storage: 'postgres' };
  }
  writeJsonCache(payload);
  return { ...payload, storage: 'file' };
}

export async function resetOnboardingGuide() {
  const payload = defaultOnboardingGuide();
  if (pgReady()) {
    await saveToPg(payload);
    return { ...payload, storage: 'postgres' };
  }
  writeJsonCache(payload);
  return { ...payload, storage: 'file' };
}

// Legacy audience labels no longer restrict account capabilities.
export function filterStepsForAudience(steps) {
  return steps || [];
}
