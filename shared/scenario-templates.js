/** Declarative contract shared by API and UI. No instance data or executable code. */
export const TEMPLATE_SCHEMA_VERSION = 1;
export const TEMPLATE_CAPABILITIES = Object.freeze([
  'mail.read', 'attachments.read', 'knowledge.search', 'tasks.write',
  'calendar.write', 'drafts.write', 'mail.send', 'recruitment.use', 'invoices.use',
]);
export const ACTION_STATES = Object.freeze(['pending', 'prepared', 'sent', 'submitted', 'confirmed', 'cancelled']);
export const MATERIAL_STATES = Object.freeze(['missing', 'prepared', 'submitted', 'confirmed', 'superseded']);
const field = (key, label, type = 'text', required = false) => ({ key, label, type, required });
const stages = (labels) => labels.map(([id, label, evidence]) => ({ id, label, ...(evidence ? { evidence: true } : {}) }));
const base = {
  schemaVersion: 1, version: '1.0.0', author: 'Daylight',
  views: ['overview', 'board', 'items', 'actions', 'materials', 'mail'],
  capabilities: ['mail.read', 'attachments.read', 'knowledge.search', 'tasks.write', 'calendar.write', 'drafts.write', 'mail.send'],
};
const definitions = [
  {
    id: 'recruitment', name: '智能招聘', subtitle: '候选人筛选与面试协同',
    description: '完整复用现有人才库、OCR/RAG、邀约审核、发信与会议能力。',
    fields: [field('position','招聘岗位'),field('department','部门'),field('owner','负责人')],
    stages: stages([['received','收到简历'],['screening','筛选中'],['interview','面试中'],['decision','结果待审核',true],['closed','已结束']]),
    rules: '使用已有招聘引擎与候选人资料；邀约须审核后发送。保留简历版本、来源引用、会话、会议和改期记录，不因添加工作台复制候选人或发信。',
    capabilities: [...base.capabilities, 'recruitment.use'],
    keywords: ['简历','应聘','求职','resume','CV'], materials: ['简历','作品集'], externalSources: ['手工补充'],
    samples: [{ input: '附件为我的求职简历。', expected: '关联招聘候选人处理流程，不自动发送邀约。' }],
    noticeWarning: '招聘邀约仍走原审核流程，不在此自动发送',
    catalog: 'official',
    signals: [
      { keywords: ['简历','resume','cv','应聘','求职'], suggestedStage: 'screening', tasks: ['在招聘引擎中筛选候选人'], warning: '招聘邀约仍走原审核流程，不在此自动发送', priority: 10 },
    ],
  },
  {
    id: 'invoices', name: '发票助手', subtitle: '附件发票提取、核对与报销准备',
    description: '复用现有发票提取与字段复制。识别结果需对照原件，不据此自动改日程或待办。',
    fields: [field('seller', '销售方'), field('buyer', '购买方'), field('amount', '价税合计'), field('currency', '币种')],
    stages: stages([['received', '待提取'], ['review', '待核对'], ['ready', '可报销', true], ['closed', '已结束']]),
    rules: '发票邮件只生成待核对事项。提取字段需对照原件，未确认前不得标记已报销，也不写入日历。',
    capabilities: [...base.capabilities, 'invoices.use'],
    keywords: ['发票', '报销', '增值税', 'invoice'],
    materials: ['发票原件', '报销单'],
    externalSources: ['报销系统', '手工补充'],
    samples: [{ input: '附件为增值税电子发票，请报销。', expected: '待核对，不写入日历，也不标成已报销。' }],
    noticeWarning: '提取结果需对照原件，读到邮件不代表已报销',
    catalog: 'official',
    signals: [
      { keywords: ['发票', '报销', '增值税', 'invoice'], suggestedStage: 'review', tasks: ['核对发票字段并准备报销'], warning: '提取结果需对照原件，不自动改日程或待办', priority: 10 },
    ],
  },
  {
    id: 'graduate-admission', name: '保研申请', subtitle: '夏令营、预推免与导师联系',
    catalog: 'community',
    description: '按申请机会汇总多校要求，追踪材料、限时确认、面试和后续变更。',
    fields: [field('institution', '学校', 'text', true), field('department', '学院'), field('program', '项目/批次'), field('supervisor', '导师'), field('contact', '联系邮箱', 'email'), field('portal', '报名入口', 'url')],
    stages: stages([['preparing','准备中'],['applied','已申请',true],['confirmation','待确认'],['interview','面试阶段'],['result','结果待核对',true],['closed','已结束']]),
    rules: '分别提取回复截止、材料截止与活动时间。后续通知明确覆盖旧要求时提出更新或撤销，引用前后邮件。优秀营员、导师欢迎报考和正式录取不是同一状态。',
    keywords: ['夏令营','预推免','推免','参营','保研','导师'],
    materials: ['申请表','成绩单','个人简历','科研证明'],
    externalSources: ['官网','报名系统','群通知'],
    samples: [{ input: '请周二12点前确认参营，周三前补成绩单，周五14点面试。', expected: '三个独立动作；日期须结合邮件日期，确认未发送前保持待处理。' }],
    noticeWarning: '官网与群通知需手工补充，邮箱不覆盖全部流程',
    signals: [
      { keywords: ['优秀营员','欢迎报考','建议报考'], warning: '优秀营员或欢迎报考不是正式录取', tasks: ['核对是否为正式录取'], holdResult: true, priority: 12 },
      { keywords: ['撤销','取消原','无需再','作废'], warning: '后续通知将覆盖旧要求，保留来源，不删除历史', tasks: ['核对被覆盖的旧要求'], supersede: true, priority: 15 },
      { keywords: ['面试'], suggestedStage: 'interview', priority: 10 },
      { keywords: ['确认'], suggestedStage: 'confirmation', priority: 5 },
    ],
  },
  {
    id: 'research-applications', name: '申博与 RA 联系', subtitle: '海外研究项目、导师沟通与面谈',
    catalog: 'community',
    description: '管理长期联系、研究计划版本、跨时区面谈及跟进事项。',
    fields: [field('institution','机构','text',true),field('supervisor','导师'),field('program','项目'),field('research','研究方向'),field('funding','资助状态'),field('contact','联系邮箱','email'),field('timeZone','对方时区','timezone')],
    stages: stages([['preparing','待联系'],['contacted','已联系'],['discussion','交流中'],['applying','申请中',true],['result','正式结果待核对',true],['closed','已结束']]),
    rules: '保留原始时区和时间，缺少时区或遇到夏令时歧义时要求确认。愿意交流、索要材料或名额未定不能标记为接收/录取。保留各轮联系人上下文与研究计划版本。',
    keywords: ['PhD','DPhil','RA','research proposal','supervisor','博士','研究助理'],
    materials: ['CV','研究计划','成绩单','写作样本'], externalSources: ['项目官网','申请系统','个人补充'],
    samples: [{ input: 'Happy to discuss your proposal. Funding is not confirmed yet.', expected: '交流中；资助未确认，不标记录取。' }],
    signals: [
      { keywords: ['录取','offer of admission','admitted','unconditional offer'], suggestedStage: 'result', warning: '正式结果仍需人工核对原文后再改阶段', priority: 30, exclusive: true },
      { keywords: ['funding is not','名额未定','not confirmed','seats are not'], suggestedStage: 'discussion', warning: '名额未定不能标记录取', tasks: ['记录名额未定并跟进'], followUpDays: 7, priority: 15 },
      { keywords: ['请补充','补充材料','please send','additional materials'], suggestedStage: 'discussion', warning: '对方索要材料不等于进入正式结果', tasks: ['准备补充材料'], priority: 12 },
      { keywords: ['happy to','willing to discuss','愿意交流','欢迎进一步'], suggestedStage: 'discussion', warning: '愿意交流不等于录取', tasks: ['整理下一轮材料或跟进'], followUpDays: 7, priority: 10 },
    ],
  },
  {
    id: 'job-applications', name: '校招求职', subtitle: '岗位申请、测评、笔试与面试',
    catalog: 'community',
    description: '按公司和岗位维护进度，防止漏测评、漏材料与面试冲突。',
    fields: [field('company','公司','text',true),field('position','岗位','text',true),field('channel','申请渠道'),field('contact','招聘联系人','email'),field('portal','申请入口','url')],
    stages: stages([['preparing','待投递'],['applied','已投递',true],['assessment','测评/笔试'],['interview','面试中'],['result','结果待核对',true],['closed','已结束']]),
    rules: '区分测评截止与笔试/面试开始。补材料不代表进入下一轮。已读不代表测评完成，平台提交需用户提供回执或确认。改期保留历史关联。',
    keywords: ['校招','笔试','测评','面试','岗位','应聘','offer'], materials: ['简历','成绩单','作品集'], externalSources: ['招聘平台','短信','微信'],
    samples: [{ input: '请周三前完成测评，面试另行通知。', expected: '创建测评待办，不编造面试日程。' }],
    noticeWarning: '平台、短信或微信提交状态需用户回执，读到邮件不代表已提交',
    signals: [
      { keywords: ['补材料','补充材料','补充简历','补充成绩'], warning: '补材料不代表进入下一轮', tasks: ['补充材料'], holdAdvance: true, priority: 11 },
      { keywords: ['测评','笔试'], suggestedStage: 'assessment', tasks: ['完成测评或笔试'], priority: 10 },
      { keywords: ['改期','reschedule'], tasks: ['核对改期并检查冲突'], warning: '改期需确认后才写入日历，原安排保留', priority: 8 },
      { keywords: ['面试'], suggestedStage: 'interview', priority: 5 },
    ],
  },
  {
    id: 'research-publications', name: '科研投稿与参会', subtitle: '稿件修订、终稿与会议安排',
    catalog: 'community',
    description: '围绕稿件或会议管理依赖任务、共同作者协作和材料版本。',
    fields: [field('venue','期刊/会议','text',true),field('manuscript','稿件名称'),field('submissionId','稿件编号'),field('authors','共同作者'),field('contact','联系邮箱','email'),field('portal','投稿入口','url')],
    stages: stages([['preparing','准备中'],['submitted','已投稿',true],['review','审稿中'],['revision','修订中'],['final','终稿/注册',true],['presentation','报告/参会'],['closed','已结束']]),
    rules: '分别提取修订、共同作者确认、终稿、注册缴费及报告安排。行动可依赖其他行动完成；未取得提交/缴费证据不自动完成。保留各版本和编辑部后续变更。',
    keywords: ['投稿','修订','终稿','参会','camera-ready','revision','reviewer','conference'], materials: ['稿件','回复审稿意见','终稿','报告材料','注册回执'], externalSources: ['投稿系统','会议官网','作者补充'],
    samples: [{ input: '请所有作者确认后，于周五前提交终稿。', expected: '作者确认是终稿提交的前置行动，收到邮件不等于提交完成。' }],
    noticeWarning: '未取得提交或缴费回执前不得标记已提交',
    signals: [
      { keywords: ['终稿','camera-ready'], suggestedStage: 'final', tasks: ['提交终稿'], dependsOnKeywords: ['共同作者','所有作者','co-author','coauthor'], dependsOn: ['共同作者确认'], priority: 10 },
      { keywords: ['共同作者','所有作者','co-author','coauthor'], tasks: ['共同作者确认'], priority: 8 },
      { keywords: ['注册','缴费','registration'], tasks: ['完成注册或缴费'], warning: '未取得缴费回执前不得标记已提交', priority: 7 },
      { keywords: ['报告时间','talk','presentation'], suggestedStage: 'presentation', tasks: ['核对报告时间'], priority: 6 },
      { keywords: ['修订','revision'], suggestedStage: 'revision', priority: 5 },
    ],
  },
];
export const OFFICIAL_TEMPLATES = definitions.map(def => ({ ...base, ...def }));
export const OFFICIAL_CATALOG_IDS = Object.freeze(['recruitment', 'invoices']);
export const COMMUNITY_CATALOG_IDS = Object.freeze([
  'graduate-admission', 'research-applications', 'job-applications', 'research-publications',
]);
export function templateCatalog(template) {
  if (!template?.id) return 'community';
  if (String(template.id).startsWith('custom-')) return 'personal';
  if (OFFICIAL_CATALOG_IDS.includes(template.id) || template.catalog === 'official') return 'official';
  return 'community';
}
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const text = (value, label, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label}不能为空且不得超过 ${max} 字符`);
  return value.trim();
};
const key = (value, label) => {
  const result = text(value, label, 64);
  if (!/^[a-z][a-zA-Z0-9_-]*$/.test(result) || ['__proto__','constructor','prototype'].includes(result)) fail(`${label}格式无效`);
  return result;
};
const list = (value, label, max = 50) => {
  if (!Array.isArray(value) || value.length > max) fail(`${label}必须为最多 ${max} 项的列表`);
  return value;
};
const unique = (values, label) => {
  if (new Set(values).size !== values.length) fail(`${label}不能重复`);
  return values;
};

/** Explicit allowlist strips emails, credentials, instance records and unknown fields. */
export function normalizeTemplate(input) {
  if (!input || input.schemaVersion !== TEMPLATE_SCHEMA_VERSION) fail('不支持的模板格式版本');
  const fields = list(input.fields, '字段').map(f => ({ key: key(f?.key,'字段标识'), label: text(f?.label,'字段名称',60), type: f?.type || 'text', required: Boolean(f?.required) }));
  if (fields.some(f => !['text','email','url','number','date','timezone'].includes(f.type))) fail('不支持的字段类型');
  unique(fields.map(f => f.key),'字段标识');
  const stageList = list(input.stages,'阶段').map(s => ({ id:key(s?.id,'阶段标识'),label:text(s?.label,'阶段名称',60), ...(s?.evidence ? { evidence: true } : {}) }));
  if (!stageList.length) fail('至少需要一个阶段');
  unique(stageList.map(s => s.id),'阶段');
  const capabilities = unique(list(input.capabilities,'能力').map(c => text(c,'能力',60)),'能力');
  if (capabilities.some(c => !TEMPLATE_CAPABILITIES.includes(c))) fail('模板包含不支持的能力');
  const views = unique(list(input.views,'视图').map(v => text(v,'视图',30)),'视图');
  if (views.some(v => !base.views.includes(v))) fail('不支持的视图');
  return {
    schemaVersion: TEMPLATE_SCHEMA_VERSION, id:key(input.id,'模板标识'),
    version:text(input.version,'版本',30), name:text(input.name,'模板名称',60),
    subtitle:text(input.subtitle || input.name,'副标题'), description:text(input.description,'描述',1000),
    author:text(input.author || '个人模板','作者',100), fields, stages:stageList, capabilities, views,
    rules:text(input.rules,'处理规则',8000),
    keywords:list(input.keywords || [],'关键词').map(v=>text(v,'关键词',100)),
    materials:list(input.materials || [],'材料').map(v=>text(v,'材料',100)),
    externalSources:list(input.externalSources || [],'外部来源').map(v=>text(v,'外部来源',100)),
    samples:list(input.samples || [],'验证样例',20).map(s=>({ input:text(s?.input,'样例输入',4000), expected:text(s?.expected,'预期结果',4000) })),
    noticeWarning: input.noticeWarning ? text(input.noticeWarning,'默认提示',500) : '',
    signals: normalizeSignals(input.signals, stageList.map(stage => stage.id)),
  };
}

function normalizeSignals(value, stageIds) {
  const signals = list(value || [], '识别信号', 20);
  return signals.map((signal) => {
    const keywords = list(signal?.keywords, '信号关键词', 30).map((item) => text(item, '信号关键词', 80));
    if (keywords.some((item) => item.length < 2)) fail('信号关键词至少 2 个字符');
    const suggestedStage = signal?.suggestedStage ? key(signal.suggestedStage, '信号阶段') : null;
    if (suggestedStage && !stageIds.includes(suggestedStage)) fail('信号阶段不在模板阶段中');
    const tasks = list(signal?.tasks || [], '信号任务', 8).map((item) => text(item, '信号任务', 120));
    const dependsOn = list(signal?.dependsOn || [], '信号依赖', 8).map((item) => text(item, '信号依赖', 120));
    const dependsOnKeywords = list(signal?.dependsOnKeywords || [], '依赖关键词', 20).map((item) => text(item, '依赖关键词', 80));
    const followUpDays = signal?.followUpDays == null ? null : Number(signal.followUpDays);
    if (followUpDays != null && (!Number.isInteger(followUpDays) || followUpDays < 1 || followUpDays > 365)) fail('跟进天数须为 1–365');
    return {
      keywords, suggestedStage, tasks, dependsOn, dependsOnKeywords,
      warning: signal?.warning ? text(signal.warning, '信号提示', 500) : '',
      supersede: Boolean(signal?.supersede),
      exclusive: Boolean(signal?.exclusive),
      holdResult: Boolean(signal?.holdResult),
      holdAdvance: Boolean(signal?.holdAdvance),
      priority: Number.isInteger(signal?.priority) ? signal.priority : 0,
      followUpDays,
    };
  });
}

export function exportTemplate(template) {
  return { format: 'daylight-scenario-template', schemaVersion: 1, template: normalizeTemplate(template) };
}
export function importTemplate(pack) {
  if (pack?.format !== 'daylight-scenario-template' || pack.schemaVersion !== 1) fail('不是受支持的 Daylight 场景模板包');
  const template = normalizeTemplate(pack.template);
  // Imported packages may never impersonate the built-in recruitment adapter.
  if (template.capabilities.includes('recruitment.use')) fail('招聘引擎仅可由内置官方模板启用');
  if (template.capabilities.includes('invoices.use')) fail('发票助手仅可由内置官方模板启用');
  return template;
}
