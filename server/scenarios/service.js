import { randomUUID } from 'node:crypto';
import { OFFICIAL_TEMPLATES, normalizeTemplate, exportTemplate, importTemplate } from '../../shared/scenario-templates.js';
import { findConflicts } from '../conflicts.js';
import { inferDeadline } from '../tasks.js';
import { callJsonModel } from '../model-json.js';
import { readRecruitment } from '../recruitment-store.js';
import { readSettings, readStore, saveStore } from '../store.js';
import { saveCalendarWithExternalSync } from '../external-calendar.js';
import { emailReference, readTraces } from '../traces.js';
import { readScenarioData, mutateScenarioData } from './repository.js';

export const problem = (message, status = 400) => { throw Object.assign(new Error(message),{status}); };
export function findWorkbench(data,id) {
  const workbench = data.workbenches.find(w=>w.id===id);
  if (!workbench) problem('工作台不存在',404);
  return workbench;
}
function mailboxIds(ids) {
  const owned = new Set(readSettings().mailboxes.map(m=>m.id));
  if (!Array.isArray(ids) || !ids.length || ids.some(id=>!owned.has(id))) problem('请选择属于当前用户的邮箱');
  return [...new Set(ids)];
}
export function addHistory(data, { workbenchId, itemId, kind, detail, source = null }) {
  data.history.push({ id:randomUUID(),workbenchId,itemId,kind,detail,source,at:new Date().toISOString() });
}
const name = value => {
  if (typeof value !== 'string' || !value.trim() || value.length>120) problem('名称须为 1–120 字符');
  return value.trim();
};
const workbenchFeatureIds = new Set(['invoices', 'recruitment']);
function normalizedNavigation(data) {
  const saved = data.navigation || {};
  const workbenchIds = new Set(data.workbenches.map(workbench=>workbench.id));
  const validIds = (value, allowed) => Array.isArray(value)
    ? [...new Set(value.filter(id=>typeof id==='string' && allowed.has(id)))] : [];
  return {
    hiddenFeatureIds: validIds(saved.hiddenFeatureIds, workbenchFeatureIds),
    hiddenWorkbenchIds: validIds(saved.hiddenWorkbenchIds, workbenchIds),
  };
}
export async function listScenarios() {
  const data = await readScenarioData();
  return { ...data, navigation:normalizedNavigation(data), officialTemplates:OFFICIAL_TEMPLATES, mailboxes:readSettings().mailboxes.map(m=>({id:m.id,email:m.email,label:m.label})) };
}
/** Visibility only: preserve workbenches, their data, and access through saved links. */
export async function updateScenarioNavigation(input) {
  if (!input || typeof input!=='object' || Array.isArray(input)
    || Object.keys(input).some(key=>!['hiddenFeatureIds','hiddenWorkbenchIds'].includes(key))) {
    problem('工作台显示设置格式无效');
  }
  return mutateScenarioData(data=>{
    const current = normalizedNavigation(data);
    const allowed = {
      hiddenFeatureIds: workbenchFeatureIds,
      hiddenWorkbenchIds: new Set(data.workbenches.map(workbench=>workbench.id)),
    };
    const next = { ...current };
    for (const key of Object.keys(input)) {
      const ids = input[key];
      if (!Array.isArray(ids) || ids.some(id=>typeof id!=='string' || !id.length)
        || new Set(ids).size!==ids.length) problem('隐藏列表须为不重复的编号数组');
      if (ids.some(id=>!allowed[key].has(id))) {
        problem(key==='hiddenFeatureIds' ? '功能编号无效' : '工作台编号无效，请选择属于当前用户的工作台');
      }
      next[key] = [...ids];
    }
    data.navigation = { ...data.navigation, ...next };
    return next;
  });
}
/** Apply one visibility change to the latest saved lists, including concurrent edits. */
export async function updateScenarioVisibility(input) {
  if (!input || typeof input!=='object' || Array.isArray(input)
    || Object.keys(input).length!==3
    || Object.keys(input).some(key=>!['kind','id','visible'].includes(key))
    || !['feature','workbench'].includes(input.kind)
    || typeof input.id!=='string' || !input.id.length || typeof input.visible!=='boolean') {
    problem('工作台显示操作须包含有效的 kind、id 和布尔值 visible');
  }
  return mutateScenarioData(data=>{
    const feature = input.kind==='feature';
    const key = feature ? 'hiddenFeatureIds' : 'hiddenWorkbenchIds';
    const allowed = feature ? workbenchFeatureIds : new Set(data.workbenches.map(workbench=>workbench.id));
    if (!allowed.has(input.id)) problem(feature ? '功能编号无效' : '工作台编号无效，请选择属于当前用户的工作台');
    const next = normalizedNavigation(data);
    const hidden = new Set(next[key]);
    if (input.visible) hidden.delete(input.id);
    else hidden.add(input.id);
    next[key] = [...hidden];
    data.navigation = { ...data.navigation, ...next };
    return next;
  });
}
export async function createWorkbench(input) {
  return mutateScenarioData(data=> {
    const definition = [...OFFICIAL_TEMPLATES,...data.templates].find(t=>t.id===input.templateId);
    if (!definition) problem('模板不存在',404);
    const template = normalizeTemplate(definition);
    const entry = { id:randomUUID(),name:name(input.name || template.name),template,
      mailboxIds:mailboxIds(input.mailboxIds), scope:{keywords:[],senders:[]}, archived:false,
      createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
    data.workbenches.push(entry);
    addHistory(data,{workbenchId:entry.id,kind:'workbench.created',detail:input.legacy?'承接已有招聘数据，未复制候选人、附件或邀约':'创建工作台，未自动处理历史邮件或执行外部动作'});
    return entry;
  });
}
export async function updateWorkbench(id,input) {
  return mutateScenarioData(data=>{
    const workbench=findWorkbench(data,id);
    if (input.name!==undefined) workbench.name=name(input.name);
    if (input.mailboxIds!==undefined) workbench.mailboxIds=mailboxIds(input.mailboxIds);
    if (input.scope!==undefined) {
      const parse = v=>Array.isArray(v) && v.length<=100 && v.every(x=>typeof x==='string' && x.length<=200) ? v.map(x=>x.trim()).filter(Boolean) : problem('处理范围格式无效');
      workbench.scope={keywords:parse(input.scope.keywords || []),senders:parse(input.scope.senders || [])};
    }
    if (input.template!==undefined) {
      const proposed = new Set(Array.isArray(input.template.stages) ? input.template.stages.map((stage) => stage?.id).filter(Boolean) : []);
      if (data.items.some((item) => item.workbenchId === id && !proposed.has(item.stage))) problem('仍有事项使用被删除阶段，请先移动事项');
      const template=normalizeTemplate(input.template);
      if (template.capabilities.includes('recruitment.use') !== workbench.template.capabilities.includes('recruitment.use')) problem('不能通过编辑模板变更招聘引擎');
      if (template.capabilities.includes('invoices.use') !== workbench.template.capabilities.includes('invoices.use')) problem('不能通过编辑模板变更发票助手');
      workbench.template=template;
    }
    if (input.archived!==undefined) workbench.archived=Boolean(input.archived);
    workbench.updatedAt=new Date().toISOString();
    addHistory(data,{workbenchId:id,kind:'workbench.updated',detail:'更新工作台配置，保留已有事项与来源数据'});
    return workbench;
  });
}
export async function deleteWorkbench(id) {
  return mutateScenarioData((data) => {
    const workbench = findWorkbench(data, id);
    const recruitment = Boolean(workbench.template?.capabilities?.includes('recruitment.use'));
    data.workbenches = data.workbenches.filter((row) => row.id !== id);
    for (const key of ['items', 'actions', 'materials', 'executions', 'history', 'previews']) {
      if (!Array.isArray(data[key])) continue;
      data[key] = data[key].filter((row) => row.workbenchId !== id);
    }
    if (recruitment) data.recruitmentWorkbenchDismissed = true;
    return { id, name: workbench.name, deleted: true };
  });
}
export async function deletePersonalTemplate(id) {
  if (!String(id || '').startsWith('custom-')) problem('官方模板不能删除');
  return mutateScenarioData((data) => {
    const before = data.templates.length;
    data.templates = (data.templates || []).filter((row) => row.id !== id);
    if (data.templates.length === before) problem('模板不存在', 404);
    return { id, deleted: true };
  });
}
export async function savePersonalTemplate(input) {
  const template=importTemplate(input);
  return mutateScenarioData(data=>{
    // Copies get a private ID so importing can never replace an official definition.
    const entry={...template,id:`custom-${randomUUID()}`};
    data.templates.push(entry);
    return entry;
  });
}
export async function exportWorkbenchTemplate(id) {
  const data=await readScenarioData();
  return exportTemplate(findWorkbench(data,id).template);
}

/** 自然语言创建的预留入口。只接受结构化草稿，拒绝代码、凭据和邮件。 */
export function draftTemplate(input = {}) {
  if (input.code || input.script || input.credentials || input.emails || input.attachments) {
    problem('模板草稿不能包含代码、凭据、邮件或附件');
  }
  if (typeof input.prompt === 'string' && !input.name) {
    return { status: 'reserved', message: '自然语言创建尚未接通模型。请改用名称、阶段和字段，或导入模板包。' };
  }
  const template = normalizeTemplate({
    schemaVersion: 1,
    id: 'customdraft',
    version: '0.1.0',
    name: input.name,
    subtitle: input.subtitle || input.name,
    description: input.description || input.name,
    author: '个人草稿',
    fields: input.fields,
    stages: input.stages,
    capabilities: (input.capabilities || ['mail.read', 'tasks.write']).filter((item) => item !== 'recruitment.use' && item !== 'invoices.use'),
    views: input.views || ['overview', 'board', 'items'],
    rules: input.rules || '由用户确认后再执行外部动作。读到邮件不代表已经提交。',
    keywords: input.keywords || [],
    materials: input.materials || [],
    externalSources: input.externalSources || [],
    samples: input.samples || [],
    signals: input.signals || [],
    noticeWarning: input.noticeWarning || '',
  });
  if (template.capabilities.includes('recruitment.use')) problem('招聘引擎仅可由内置官方模板启用');
  if (template.capabilities.includes('invoices.use')) problem('发票助手仅可由内置官方模板启用');
  return { status: 'draft', pack: exportTemplate({ ...template, id: 'customdraft' }) };
}

function templateFingerprint(template) {
  const next = normalizeTemplate(template);
  return JSON.stringify({
    version: next.version,
    rules: next.rules,
    signals: next.signals,
    keywords: next.keywords,
    materials: next.materials,
    noticeWarning: next.noticeWarning,
    capabilities: next.capabilities,
    stages: next.stages,
    fields: next.fields,
    samples: next.samples,
    externalSources: next.externalSources,
  });
}

export async function previewWorkbenchUpgrade(id) {
  const data = await readScenarioData();
  const workbench = findWorkbench(data, id);
  const official = OFFICIAL_TEMPLATES.find((template) => template.id === workbench.template.id);
  if (!official) return { available: false, reason: '个人模板没有官方升级' };
  const next = normalizeTemplate(official);
  const used = new Set(data.items.filter((item) => item.workbenchId === id).map((item) => item.stage));
  const blockedStages = workbench.template.stages
    .filter((stage) => !next.stages.some((item) => item.id === stage.id) && used.has(stage.id))
    .map((stage) => stage.id);
  const same = templateFingerprint(workbench.template) === templateFingerprint(next);
  const versionSame = workbench.template.version === next.version;
  const evidenceStages = next.stages
    .filter((stage) => stage.evidence && !workbench.template.stages.some((item) => item.id === stage.id && item.evidence))
    .map((stage) => stage.label);
  return {
    available: !same && blockedStages.length === 0,
    currentVersion: workbench.template.version,
    nextVersion: next.version,
    blockedStages,
    evidenceStages,
    reason: blockedStages.length ? '仍有事项使用将被删除的阶段' : same ? '已是当前官方模板' : (versionSame ? '官方识别规则有更新，事项会保留' : ''),
  };
}

export async function applyWorkbenchUpgrade(id) {
  const preview = await previewWorkbenchUpgrade(id);
  if (preview.blockedStages?.length) problem('仍有事项使用将被删除的阶段');
  if (!preview.available) problem(preview.reason || '没有可升级的官方模板');
  return mutateScenarioData((data) => {
    const workbench = findWorkbench(data, id);
    const official = OFFICIAL_TEMPLATES.find((template) => template.id === workbench.template.id);
    const before = workbench.template.version;
    workbench.template = normalizeTemplate(official);
    workbench.updatedAt = new Date().toISOString();
    addHistory(data, { workbenchId: id, kind: 'template.upgraded', detail: `模板从 ${before} 升级到 ${workbench.template.version}，事项与来源保留` });
    return workbench;
  });
}
export function itemFields(template,raw = {}) {
  const fields={};
  for(const field of template.fields) {
    const value=raw[field.key] ?? '';
    if(field.required && !String(value).trim()) problem(`请填写${field.label}`);
    if (typeof value!=='string' && typeof value!=='number') problem(`${field.label}格式无效`);
    if (String(value).length>4000) problem(`${field.label}过长`);
    if (value && field.type==='email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) problem(`${field.label}邮箱格式无效`);
    if (value && field.type==='url') {
      try { if (!['https:','http:'].includes(new URL(value).protocol)) problem('链接只支持 HTTP/HTTPS'); }
      catch { problem(`${field.label}链接无效`); }
    }
    if(value && field.type==='timezone') {
      try { new Intl.DateTimeFormat('en',{timeZone:value}).format(); }
      catch { problem('请使用有效的 IANA 时区，例如 Europe/London'); }
    }
    fields[field.key]=value;
  }
  return fields;
}
export async function createItem(workbenchId,input) {
  return mutateScenarioData(data=>{
    const workbench=findWorkbench(data,workbenchId);
    if(workbench.archived) problem('工作台已归档');
    const stage=input.stage || workbench.template.stages[0].id;
    const target=workbench.template.stages.find(s=>s.id===stage);
    if(!target) problem('阶段无效');
    const receipt=String(input.receipt || '').trim();
    if(target.evidence && !receipt) problem('进入该阶段需要回执。收到通知不能代替提交、缴费或对方确认。');
    const item={id:randomUUID(),workbenchId,title:name(input.title),stage,fields:itemFields(workbench.template,input.fields),notes:String(input.notes || '').slice(0,20000),sources:[],stageReceipt:target.evidence?receipt.slice(0,2000):'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    data.items.push(item);
    addHistory(data,{workbenchId,itemId:item.id,kind:'item.created',detail:'手工创建事项'});
    return item;
  });
}
export async function updateItem(workbenchId,itemId,input) {
  return mutateScenarioData(data=>{
    const workbench=findWorkbench(data,workbenchId);
    const item=data.items.find(i=>i.id===itemId && i.workbenchId===workbenchId);
    if(!item) problem('事项不存在',404);
    const before={title:item.title,stage:item.stage,fields:item.fields,notes:item.notes};
    if(input.title!==undefined) item.title=name(input.title);
    if(input.stage!==undefined) {
      const target=workbench.template.stages.find(s=>s.id===input.stage);
      if(!target) problem('阶段无效');
      const receipt=String(input.receipt || '').trim();
      if(input.stage!==item.stage && target.evidence && !receipt) problem('进入该阶段需要回执。收到通知不能代替提交、缴费或对方确认。');
      item.stage=input.stage;
      if(target.evidence && receipt) item.stageReceipt=receipt.slice(0,2000);
      if(item.suggestedStage===input.stage) item.suggestedStage=null;
    }
    if(input.fields!==undefined) item.fields=itemFields(workbench.template,input.fields);
    if(input.notes!==undefined) item.notes=String(input.notes).slice(0,20000);
    item.updatedAt=new Date().toISOString();
    addHistory(data,{workbenchId,itemId,kind:'item.updated',detail:{before,after:{title:item.title,stage:item.stage,fields:item.fields,notes:item.notes}}});
    return item;
  });
}

function emailHaystack(email) {
  return [email.subject, email.sender, email.summary, email.extraction?.summary, email.body]
    .filter(Boolean).join('\n').toLowerCase();
}

/** 预览可关联邮件：只读，不写日程/待办/发信。 */
export async function previewWorkbenchMail(workbenchId) {
  const data = await readScenarioData();
  const workbench = findWorkbench(data, workbenchId);
  const keywords = [...(workbench.template.keywords || []), ...(workbench.scope?.keywords || [])]
    .map((item) => String(item).toLowerCase()).filter(Boolean);
  const senders = (workbench.scope?.senders || []).map((item) => String(item).toLowerCase());
  const linked = new Set();
  for (const item of data.items) {
    if (item.workbenchId !== workbenchId) continue;
    for (const source of item.sources || []) linked.add(`${source.mailboxId}:${source.emailId}`);
  }
  const emails = [];
  for (const mailboxId of workbench.mailboxIds) {
    const store = readStore(mailboxId);
    for (const email of store.emails || []) {
      const hay = emailHaystack(email);
      const keywordHit = keywords.some((word) => hay.includes(word));
      const senderHit = senders.some((sender) => hay.includes(sender));
      const key = `${mailboxId}:${email.id}`;
      if (!keywordHit && !senderHit && !linked.has(key)) continue;
      emails.push({
        mailboxId,
        emailId: email.id,
        subject: email.subject || '',
        sender: email.sender || '',
        receivedAt: email.receivedAt || null,
        matched: keywordHit || senderHit,
        linked: linked.has(key),
      });
    }
  }
  return { emails: emails.slice(0, 100), keywords };
}

/** 确认把邮件关联到事项。同一邮件可被多个工作台引用，此处只记来源，不执行外部动作。 */
export async function linkMailSource(workbenchId, input) {
  const emailId = String(input.emailId || '');
  const mailboxId = String(input.mailboxId || '');
  if (!emailId || !mailboxId) problem('请指定邮箱与邮件');
  return mutateScenarioData((data) => {
    const workbench = findWorkbench(data, workbenchId);
    if (!workbench.mailboxIds.includes(mailboxId)) problem('该邮箱未关联到此工作台');
    const email = (readStore(mailboxId).emails || []).find((item) => item.id === emailId);
    if (!email) problem('邮件不存在', 404);
    let item = input.itemId
      ? data.items.find((entry) => entry.id === input.itemId && entry.workbenchId === workbenchId)
      : null;
    if (input.itemId && !item) problem('事项不存在', 404);
    if (!item) {
      item = {
        id: randomUUID(),
        workbenchId,
        title: name(String(email.subject || '来自邮件的事项').slice(0, 120)),
        stage: workbench.template.stages[0].id,
        fields: itemFields(workbench.template, Object.fromEntries(
          workbench.template.fields.filter((field) => field.required).map((field) => [field.key, '待补充']),
        )),
        notes: '',
        sources: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      // 必填字段无法从邮件可靠推断时，仍创建事项但字段允许空：仅当模板无 required 或已填。
      const missing = workbench.template.fields.filter((field) => field.required);
      if (missing.length) {
        for (const field of missing) item.fields[field.key] = item.fields[field.key] || '待补充';
      }
      data.items.push(item);
    }
    item.sources = item.sources || [];
    if (item.sources.some((source) => source.emailId === emailId && source.mailboxId === mailboxId)) {
      return { item, duplicate: true };
    }
    item.sources.push({
      mailboxId, emailId, subject: email.subject || '', linkedAt: new Date().toISOString(),
    });
    item.updatedAt = new Date().toISOString();
    addHistory(data, {
      workbenchId, itemId: item.id, kind: 'source.linked',
      detail: '确认关联邮件来源，未创建日程、待办或发送邮件',
      source: { mailboxId, emailId },
    });
    return { item, duplicate: false };
  });
}

/** 官网、报名系统、群通知等由用户粘贴。只记来源，不标已提交、不发信。 */
export async function recordExternalSource(workbenchId, itemId, input) {
  const note = String(input.note || '').trim();
  const channel = String(input.channel || '').trim();
  if (!note || note.length > 4000) problem('请填写外部来源原文，且不超过 4000 字符');
  if (!channel || channel.length > 40) problem('请选择外部来源');
  return mutateScenarioData((data) => {
    const workbench = findWorkbench(data, workbenchId);
    const allowed = workbench.template.externalSources || [];
    if (allowed.length && !allowed.includes(channel)) problem('请选择模板列出的外部来源');
    const item = data.items.find((entry) => entry.id === itemId && entry.workbenchId === workbenchId);
    if (!item) problem('事项不存在', 404);
    item.sources = item.sources || [];
    const externalCount = item.sources.filter((source) => source.kind === 'external').length;
    if (externalCount >= 30) problem('外部来源过多');
    const source = { kind: 'external', channel, note, linkedAt: new Date().toISOString() };
    item.sources.push(source);
    item.updatedAt = new Date().toISOString();
    addHistory(data, {
      workbenchId, itemId, kind: 'source.external',
      detail: `登记${channel}来源，未标记已提交或已发送`,
    });
    return { item, source };
  });
}

const genericNotice = { suggestedStage: null, warning: '读到邮件不代表已提交或对方已确认。外部动作需要回执，不会自动发信。', tasks: [] };

/** 把一封通知里的多个截止拆成待办。有邮件时间才推算截止；推不出就只保留原文。 */
export function extractDeadlineTasks(text, sentAt) {
  const clauses = String(text || '').split(/[，。；;\n]/).map((item) => item.trim()).filter((item) => item.length >= 2 && item.length <= 120);
  const found = [];
  for (const clause of clauses) {
    if (!/(周|星期|礼拜|今天|明天|后天|大后天|\d{1,2}\s*月|\d{4}\s*[-/年])/.test(clause)) continue;
    let dueAt = null;
    if (sentAt) {
      try { dueAt = inferDeadline(clause, sentAt); } catch { dueAt = null; }
    }
    const title = clause.replace(/^(?:请|于|麻烦)+/u, '').trim();
    if (title.length < 2) continue;
    const timedEvent = Boolean(dueAt) && !/前/.test(clause) && /(面试|面谈|报告|talk|presentation)/i.test(clause) && /\d{1,2}\s*[:：点时]/.test(clause);
    found.push({ title, dueAt, deadlineText: clause, timedEvent });
  }
  return found.slice(0, 8);
}

function haystackHas(haystack, keyword) {
  return haystack.includes(String(keyword).toLowerCase());
}

/** 按模板上的识别信号解释邮件。编号只用于找官方模板上的信号，不另写一套流程。 */
export function interpretNotice(templateOrId, text) {
  const template = typeof templateOrId === 'string'
    ? OFFICIAL_TEMPLATES.find((item) => item.id === templateOrId)
    : templateOrId;
  if (!template) return { ...genericNotice };
  const official = OFFICIAL_TEMPLATES.find((item) => item.id === template.id);
  const signals = (template.signals?.length ? template.signals : official?.signals) || [];
  const haystack = String(text || '').toLowerCase();
  const matched = signals
    .filter((signal) => (signal.keywords || []).some((keyword) => haystackHas(haystack, keyword)))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  if (!matched.length) {
    return { ...genericNotice, warning: template.noticeWarning || official?.noticeWarning || genericNotice.warning, tasks: [] };
  }
  const exclusive = matched.find((signal) => signal.exclusive);
  const stageSignal = matched.find((signal) => signal.suggestedStage);
  const tasks = [];
  const dependencyByTitle = {};
  let followUpDays = null;
  for (const signal of matched) {
    if (exclusive && signal !== exclusive && (signal.priority || 0) < (exclusive.priority || 0)) continue;
    for (const task of signal.tasks || []) if (!tasks.includes(task)) tasks.push(task);
    if (signal.followUpDays) followUpDays = signal.followUpDays;
    const needsDependency = !(signal.dependsOnKeywords || []).length
      || signal.dependsOnKeywords.some((keyword) => haystackHas(haystack, keyword));
    if (needsDependency && signal.dependsOn?.length) {
      for (const task of signal.tasks || []) {
        const current = dependencyByTitle[task] || [];
        for (const gate of signal.dependsOn) if (!current.includes(gate)) current.push(gate);
        dependencyByTitle[task] = current;
      }
    }
  }
  const dependsOn = [];
  for (const gates of Object.values(dependencyByTitle)) {
    for (const gate of gates) if (!dependsOn.includes(gate)) dependsOn.push(gate);
  }
  const dependentTitles = Object.keys(dependencyByTitle);
  const warnings = [...new Set(matched.map((signal) => signal.warning).filter(Boolean))];
  const warning = warnings.join(' ') || template.noticeWarning || official?.noticeWarning || genericNotice.warning;
  return {
    suggestedStage: stageSignal?.suggestedStage || null,
    warning,
    tasks,
    followUpDays,
    dependsOn,
    dependentTitles,
    dependencyByTitle,
    supersede: matched.some((signal) => signal.supersede),
    holdResult: matched.some((signal) => signal.holdResult),
    holdAdvance: matched.some((signal) => signal.holdAdvance),
  };
}

/** 用模板规则回放一条样例。只返回待确认动作，不写待办、日历，也不发信、不调用模型。 */
export function replayTemplateSample(template, input, receivedAt = null) {
  const text = String(input || '');
  const interpretation = interpretNotice(template, text);
  const deadlines = extractDeadlineTasks(text, receivedAt);
  const actions = [
    ...(interpretation.tasks || []).map((title) => ({ title, kind: 'task', state: 'pending' })),
    ...deadlines.map((deadline) => ({
      title: deadline.title,
      kind: deadline.timedEvent && (template.capabilities || []).includes('calendar.write') ? 'calendar' : 'task',
      state: 'pending',
      dueAt: deadline.dueAt || null,
    })),
  ];
  return { interpretation, actions, written: false, sent: false, modelCalled: false };
}

/** 回放模板里已保存的样例。收到的是模板包，不是邮件数据。 */
export function replayTemplatePack(input = {}) {
  if (input.code || input.script || input.credentials || input.emails || input.attachments) {
    problem('样例回放不能包含代码、凭据、邮件或附件');
  }
  const template = normalizeTemplate(input.template || input);
  const receivedAt = input.receivedAt ? String(input.receivedAt) : null;
  const samples = (template.samples || []).slice(0, 5).map((sample) => ({
    input: sample.input,
    expected: sample.expected,
    ...replayTemplateSample(template, sample.input, receivedAt),
  }));
  return { samples, modelCalled: false, written: false, sent: false };
}

/** 模型只能补充任务和警告。礼貌回复、未提交和作废覆盖仍以规则为准。 */
export function mergeAnalysis(template, rules, model) {
  const stages = new Set((template.stages || []).map((stage) => stage.id));
  const modelTasks = Array.isArray(model?.tasks)
    ? model.tasks.map((task) => String(task).trim()).filter((task) => task && task.length <= 120).slice(0, 8)
    : [];
  let suggestedStage = stages.has(model?.suggestedStage) ? model.suggestedStage : rules.suggestedStage;
  if (rules.holdAdvance) suggestedStage = rules.suggestedStage || null;
  if (rules.holdResult && suggestedStage === 'result') suggestedStage = rules.suggestedStage && rules.suggestedStage !== 'result' ? rules.suggestedStage : null;
  if (rules.suggestedStage && rules.suggestedStage !== 'result' && suggestedStage === 'result') {
    suggestedStage = rules.suggestedStage;
  }
  const modelWarning = typeof model?.warning === 'string' ? model.warning.trim().slice(0, 500) : '';
  return {
    suggestedStage: suggestedStage || null,
    warning: [rules.warning, modelWarning].filter(Boolean).join(' '),
    tasks: [...new Set([...(rules.tasks || []), ...modelTasks])].slice(0, 12),
    dependsOn: rules.dependsOn || [],
    dependentTitles: rules.dependentTitles || [],
    dependencyByTitle: rules.dependencyByTitle || {},
    supersede: Boolean(rules.supersede),
    followUpDays: Number.isInteger(rules.followUpDays) ? rules.followUpDays : null,
    source: model ? 'model+rules' : 'rules',
  };
}

export async function proposeItemPlan(workbenchId, itemId, options = {}) {
  const current = await readScenarioData();
  const workbench = findWorkbench(current, workbenchId);
  const item = current.items.find((entry) => entry.id === itemId && entry.workbenchId === workbenchId);
  if (!item) problem('事项不存在', 404);
  // The model runs without database locks. Reject results based on superseded inputs.
  const inputVersion = JSON.stringify({ item, template: workbench.template });
  const notes = [];
  for (const source of item.sources || []) {
    if (source.kind === 'external') {
      const note = [source.channel, source.note].filter(Boolean).join('\n');
      notes.push({ text: note, deadlines: extractDeadlineTasks(source.note, source.linkedAt || null) });
      continue;
    }
    const email = (readStore(source.mailboxId).emails || []).find((entry) => entry.id === source.emailId);
    if (email) {
      const note = [email.subject, email.body, email.summary].filter(Boolean).join('\n');
      notes.push({ text: note, deadlines: extractDeadlineTasks(note, email.receivedAt || null) });
    }
  }
  const superseding = [...notes].reverse().find((note) => interpretNotice(workbench.template, note.text).supersede);
  const activeNotes = superseding ? [superseding] : notes;
  const texts = activeNotes.map((note) => note.text);
  const deadlineTasks = activeNotes.flatMap((note) => note.deadlines);
  const rules = interpretNotice(workbench.template, texts.join('\n'));
  let model = null;
  if (options.useModel) {
    const settings = readSettings();
    const caller = options.callModel || ((nextSettings, messages) => callJsonModel(nextSettings, messages, { label: '场景工作台分析' }));
    model = await caller(settings, [
      {
        role: 'system',
        content: `只返回 JSON 对象，字段为 suggestedStage、warning、tasks。阶段只能是 ${workbench.template.stages.map((stage) => stage.id).join('、')} 之一或 null。遵守规则：${workbench.template.rules} 不得把礼貌回复当成录取，不得因为读到邮件就标记已提交或已发送。`,
      },
      { role: 'user', content: (texts.join('\n') || item.notes || item.title).slice(0, 12000) },
    ]);
  }
  const interpretation = mergeAnalysis(workbench.template, rules, model);
  return mutateScenarioData((data) => {
    const live = findWorkbench(data, workbenchId);
    const liveItem = data.items.find((entry) => entry.id === itemId && entry.workbenchId === workbenchId);
    if (!liveItem) problem('事项不存在', 404);
    if (JSON.stringify({ item: liveItem, template: live.template }) !== inputVersion) {
      problem('分析期间事项或模板已更新，请重新分析。', 409);
    }
    const stageIds = new Set(live.template.stages.map((stage) => stage.id));
    liveItem.suggestedStage = interpretation.suggestedStage && stageIds.has(interpretation.suggestedStage) && interpretation.suggestedStage !== liveItem.stage
      ? interpretation.suggestedStage
      : null;
    const mailboxId = liveItem.sources?.[0]?.mailboxId || live.mailboxIds[0];
    const created = { materials: [], actions: [] };
    if (interpretation.supersede) {
      for (const material of data.materials) {
        if (material.workbenchId !== workbenchId || material.itemId !== itemId || material.state === 'superseded') continue;
        material.state = 'superseded';
        material.updatedAt = new Date().toISOString();
        addHistory(data, {
          workbenchId, itemId, kind: 'material.superseded',
          detail: `${material.label} v${material.version} 被后续通知覆盖，原记录保留`,
          source: item.sources?.[item.sources.length - 1] || null,
        });
      }
      for (const action of data.actions) {
        if (action.workbenchId !== workbenchId || action.itemId !== itemId || action.state !== 'pending') continue;
        action.state = 'cancelled';
        addHistory(data, {
          workbenchId, itemId, kind: 'action.cancelled',
          detail: `${action.title} 因后续作废通知取消，原记录保留`,
        });
      }
    }
    for (const label of workbench.template.materials || []) {
      if (interpretation.supersede) continue;
      if (data.materials.some((row) => row.workbenchId === workbenchId && row.itemId === itemId && row.label === label && row.state !== 'superseded')) continue;
      const version = data.materials
        .filter((row) => row.workbenchId === workbenchId && row.itemId === itemId && row.label === label)
        .reduce((max, row) => Math.max(max, row.version || 1), 0) + 1;
      const material = {
        id: randomUUID(), workbenchId, itemId, label, state: 'missing', version,
        source: null, updatedAt: new Date().toISOString(),
      };
      data.materials.push(material);
      created.materials.push(material);
    }
    const notice = texts.join('\n');
    if (!interpretation.supersede && /补充|更新|新版|重新提交|revised|please send/i.test(notice)) {
      for (const label of live.template.materials || []) {
        if (!notice.includes(label)) continue;
        const active = data.materials.filter((row) => row.workbenchId === workbenchId && row.itemId === itemId && row.label === label && !['superseded', 'missing'].includes(row.state));
        if (!active.length) continue;
        for (const material of active) {
          material.state = 'superseded';
          material.updatedAt = new Date().toISOString();
          addHistory(data, {
            workbenchId, itemId, kind: 'material.superseded',
            detail: `${material.label} v${material.version} 因后续补充要求保留为旧版本`,
          });
        }
        const version = data.materials
          .filter((row) => row.workbenchId === workbenchId && row.itemId === itemId && row.label === label)
          .reduce((max, row) => Math.max(max, row.version || 1), 0) + 1;
        const material = {
          id: randomUUID(), workbenchId, itemId, label, state: 'missing', version,
          source: null, updatedAt: new Date().toISOString(),
        };
        data.materials.push(material);
        created.materials.push(material);
      }
    }
    const titles = [
      ...(interpretation.tasks || []),
      ...(interpretation.supersede ? [] : (workbench.template.materials || []).map((label) => `准备：${label}`)),
    ];
    for (const title of titles) {
      if (data.actions.some((row) => row.workbenchId === workbenchId && row.itemId === itemId && row.title === title && row.state !== 'cancelled')) continue;
      const action = {
        id: randomUUID(), workbenchId, itemId, mailboxId, title, kind: 'task',
        state: 'pending', dependsOn: [],
        dueAt: interpretation.followUpDays && title.includes('跟进')
          ? new Date(Date.now() + interpretation.followUpDays * 24 * 60 * 60 * 1000).toISOString()
          : null,
        deadlineText: '',
        createdAt: new Date().toISOString(),
      };
      data.actions.push(action);
      created.actions.push(action);
    }
    for (const deadline of deadlineTasks) {
      const startMs = deadline.dueAt ? Date.parse(deadline.dueAt) : NaN;
      const asCalendar = deadline.timedEvent && Number.isFinite(startMs) && live.template.capabilities.includes('calendar.write');
      const existing = data.actions.find((row) => row.workbenchId === workbenchId && row.itemId === itemId && row.title === deadline.title && row.state !== 'cancelled');
      if (existing) {
        if (existing.state === 'pending' && existing.kind === 'task' && deadline.dueAt) {
          if (asCalendar) {
            existing.kind = 'calendar';
            existing.dueAt = deadline.dueAt;
            existing.deadlineText = deadline.deadlineText;
            existing.schedule = {
              timeZone: 'Asia/Shanghai',
              localStart: formatInTimeZone(startMs, 'Asia/Shanghai'),
              localEnd: formatInTimeZone(startMs + 60 * 60 * 1000, 'Asia/Shanghai'),
              startOffsetMin: 480,
              endOffsetMin: 480,
              startUtc: new Date(startMs).toISOString(),
              endUtc: new Date(startMs + 60 * 60 * 1000).toISOString(),
              beijingStart: formatInTimeZone(startMs, 'Asia/Shanghai'),
              beijingEnd: formatInTimeZone(startMs + 60 * 60 * 1000, 'Asia/Shanghai'),
            };
          } else if (!existing.dueAt) {
            existing.dueAt = deadline.dueAt;
            existing.deadlineText = deadline.deadlineText || existing.deadlineText;
          }
        }
        continue;
      }
      const endMs = startMs + 60 * 60 * 1000;
      const action = {
        id: randomUUID(), workbenchId, itemId, mailboxId, title: deadline.title,
        kind: asCalendar ? 'calendar' : 'task',
        state: 'pending', dependsOn: [],
        dueAt: deadline.dueAt, deadlineText: deadline.deadlineText,
        ...(asCalendar ? { schedule: {
          timeZone: 'Asia/Shanghai',
          localStart: formatInTimeZone(startMs, 'Asia/Shanghai'),
          localEnd: formatInTimeZone(endMs, 'Asia/Shanghai'),
          startOffsetMin: 480,
          endOffsetMin: 480,
          startUtc: new Date(startMs).toISOString(),
          endUtc: new Date(endMs).toISOString(),
          beijingStart: formatInTimeZone(startMs, 'Asia/Shanghai'),
          beijingEnd: formatInTimeZone(endMs, 'Asia/Shanghai'),
        } } : {}),
        createdAt: new Date().toISOString(),
      };
      data.actions.push(action);
      created.actions.push(action);
    }
    for (const action of data.actions) {
      if (action.itemId !== itemId || action.state === 'cancelled') continue;
      let gateTitles = interpretation.dependencyByTitle?.[action.title] || [];
      if (!gateTitles.length) {
        gateTitles = Object.entries(interpretation.dependencyByTitle || {})
          .filter(([task]) => task && (action.title.includes(task) || String(action.deadlineText || '').includes(task)))
          .flatMap(([, gates]) => gates);
      }
      if (!gateTitles.length) continue;
      const gateIds = data.actions
        .filter((row) => row.itemId === itemId && gateTitles.includes(row.title) && row.state !== 'cancelled')
        .map((row) => row.id);
      if (gateIds.length) action.dependsOn = gateIds;
    }
    addHistory(data, {
      workbenchId, itemId, kind: 'plan.proposed',
      detail: { interpretation, createdCounts: { materials: created.materials.length, actions: created.actions.length } },
    });
    return { interpretation, ...created };
  });
}

function mailIdsForItem(data, itemId) {
  const item = data.items.find((entry) => entry.id === itemId);
  return (item?.sources || []).map((source) => source.emailId).filter(Boolean);
}

function rememberWorkbench(record, workbench) {
  const ids = [];
  if (record.workbenchId) ids.push(record.workbenchId);
  for (const id of record.workbenchIds || []) if (id && !ids.includes(id)) ids.push(id);
  if (workbench.id && !ids.includes(workbench.id)) ids.push(workbench.id);
  record.workbenchIds = ids;
  if (!record.workbenchName) record.workbenchName = workbench.name;
  else if (workbench.name && !String(record.workbenchName).split('、').includes(workbench.name)) record.workbenchName = `${record.workbenchName}、${workbench.name}`;
}

/** 同一封邮件、同一待办标题已经写过，就不再写第二条。没有关联邮件时不跨工作台合并。 */
function sharedTaskWrite(data, action) {
  const ids = new Set(mailIdsForItem(data, action.itemId));
  if (!ids.size) return null;
  return data.executions.find((execution) => {
    if (execution.kind !== 'task.write' || execution.actionId === action.id || !execution.taskId) return false;
    const other = data.actions.find((row) => row.id === execution.actionId);
    if (!other || other.title !== action.title) return false;
    return mailIdsForItem(data, other.itemId).some((id) => ids.has(id));
  }) || null;
}

/** 用户确认后才写入邮箱待办。同一行动只写一次。同一封邮件的相同待办也不再写第二次。 */
export async function confirmAction(workbenchId, actionId) {
  const data = await readScenarioData();
  const workbench = findWorkbench(data, workbenchId);
  if (!workbench.template.capabilities.includes('tasks.write')) problem('当前模板不能写入待办');
  const action = data.actions.find((row) => row.id === actionId && row.workbenchId === workbenchId);
  if (!action) problem('行动不存在', 404);
  if (action.state === 'cancelled') problem('该行动已因后续通知取消，不能再写入待办');
  const openTasks = openPrerequisiteTitles(data, action);
  if (openTasks.length) problem(`前置行动尚未完成：${openTasks.join('、')}`);
  const prior = data.executions.find((row) => row.actionId === actionId && row.kind === 'task.write');
  if (prior) return { action, execution: prior, duplicate: true };
  return mutateScenarioData((next) => {
    const current = next.actions.find((row) => row.id === actionId);
    if (!current) problem('行动不存在', 404);
    if (current.state === 'cancelled') problem('该行动已因后续通知取消，不能再写入待办');
    const openTasks = openPrerequisiteTitles(next, current);
    if (openTasks.length) problem(`前置行动尚未完成：${openTasks.join('、')}`);
    const again = next.executions.find((row) => row.actionId === actionId && row.kind === 'task.write');
    if (again) return { action: current, execution: again, duplicate: true };
    const mailboxId = current.mailboxId || workbench.mailboxIds[0];
    const store = readStore(mailboxId);
    store.tasks = store.tasks || [];
    if (store.tasks.some((task) => task.scenarioActionId === actionId)) {
      current.state = 'prepared';
      return { action: current, duplicate: true };
    }
    const shared = sharedTaskWrite(next, current);
    if (shared) {
      current.state = 'prepared';
      const sharedStore = readStore(shared.mailboxId);
      const sharedTask = (sharedStore.tasks || []).find((task) => task.id === shared.taskId);
      if (sharedTask) {
        rememberWorkbench(sharedTask, workbench);
        saveStore(sharedStore, shared.mailboxId);
      }
      const execution = {
        id: randomUUID(), workbenchId, actionId, kind: 'task.write', taskId: shared.taskId,
        mailboxId: shared.mailboxId, shared: true, at: new Date().toISOString(),
      };
      next.executions.push(execution);
      addHistory(next, { workbenchId, itemId: current.itemId, kind: 'action.shared', detail: '这封邮件的相同待办已写入，未再次创建' });
      return { action: current, execution, duplicate: true, shared: true };
    }
    const item = next.items.find((entry) => entry.id === current.itemId);
    const mailSources = (item?.sources || []).filter((source) => source.emailId).map((source) => ({
      emailId: source.emailId,
      emailSubject: source.subject || '',
      mailboxId: source.mailboxId,
    }));
    const externalNotes = (item?.sources || []).filter((source) => source.kind === 'external')
      .map((source) => `${source.channel}：${source.note}`).join('\n');
    const task = {
      id: randomUUID(),
      title: current.title,
      dueAt: current.dueAt || null,
      deadlineText: current.deadlineText || '',
      priority: 'normal',
      assignee: '',
      description: [`来自工作台 ${workbench.name}。尚未对外提交或发送。完成前需要在工作台登记回执。`, externalNotes].filter(Boolean).join('\n').slice(0, 2000),
      status: 'pending',
      completedAt: null,
      source: 'scenario',
      scenarioActionId: actionId,
      requiresVerification: true,
      verificationMode: 'scenario_receipt',
      workbenchId,
      workbenchIds: [workbenchId],
      workbenchName: workbench.name,
      createdAt: new Date().toISOString(),
      sources: mailSources,
    };
    store.tasks.push(task);
    saveStore(store, mailboxId);
    current.state = 'prepared';
    const execution = {
      id: randomUUID(), workbenchId, actionId, kind: 'task.write', taskId: task.id, mailboxId,
      at: new Date().toISOString(),
    };
    next.executions.push(execution);
    addHistory(next, { workbenchId, itemId: current.itemId, kind: 'action.prepared', detail: '已写入待办，尚未对外提交或发送' });
    return { action: current, execution, duplicate: false };
  });
}

/** 保存回复草稿到关联邮件，不调用发信。 */
export async function saveReplyDraft(workbenchId, itemId, input) {
  const body = String(input.body || '').trim();
  if (!body || body.length > 4000) problem('回复草稿须为 1–4000 字符');
  const current = await readScenarioData();
  const workbench = findWorkbench(current, workbenchId);
  if (!workbench.template.capabilities.includes('drafts.write')) problem('当前模板不能保存回复草稿');
  const item = current.items.find((entry) => entry.id === itemId && entry.workbenchId === workbenchId);
  if (!item) problem('事项不存在', 404);
  const sources = item.sources || [];
  const emailSource = [...sources].reverse().find((source) => source.emailId && source.mailboxId);
  const externalSource = [...sources].reverse().find((source) => source.kind === 'external');
  if (!emailSource && !externalSource) problem('请先关联邮件，或登记官网、群通知等外部来源');
  return mutateScenarioData((data) => {
    const live = data.items.find((entry) => entry.id === itemId && entry.workbenchId === workbenchId);
    if (!live) problem('事项不存在', 404);
    if (emailSource) {
      const store = readStore(emailSource.mailboxId);
      const email = (store.emails || []).find((entry) => entry.id === emailSource.emailId);
      if (!email) problem('来源邮件不存在', 404);
      email.userDraft = body;
      saveStore(store, emailSource.mailboxId);
    }
    let action = data.actions.find((row) => row.workbenchId === workbenchId && row.itemId === itemId && row.kind === 'draft' && row.state !== 'cancelled');
    if (action?.state === 'sent') problem('已登记发送的草稿不能在此覆盖');
    if (!action) {
      action = {
        id: randomUUID(), workbenchId, itemId, mailboxId: emailSource?.mailboxId || workbench.mailboxIds[0], emailId: emailSource?.emailId || null,
        title: '回复草稿', kind: 'draft', state: 'prepared', body, dependsOn: [],
        createdAt: new Date().toISOString(),
      };
      data.actions.push(action);
    } else {
      action.body = body;
      action.state = 'prepared';
      action.emailId = emailSource?.emailId || null;
    }
    data.executions.push({
      id: randomUUID(), workbenchId, actionId: action.id, kind: 'draft.write', mailboxId: emailSource?.mailboxId || null,
      at: new Date().toISOString(),
    });
    addHistory(data, {
      workbenchId, itemId, kind: 'draft.saved',
      detail: emailSource ? '已保存回复草稿到关联邮件，尚未发送' : '已保存回复草稿到工作台，没有关联邮件，尚未发送',
    });
    return { action, sent: false };
  });
}

/** 外部系统回执只能由用户提供。已提交、已发送和对方确认分开记录，这里不发信。 */
export async function recordReceipt(workbenchId, input) {
  const note = String(input.note || '').trim();
  if (!note || note.length > 2000) problem('请填写回执说明');
  const status = input.status || 'submitted';
  if (!['submitted', 'confirmed', 'sent', 'prepared'].includes(status)) problem('回执状态无效');
  return mutateScenarioData((data) => {
    const action = input.actionId
      ? data.actions.find((row) => row.id === input.actionId && row.workbenchId === workbenchId)
      : null;
    const material = input.materialId
      ? data.materials.find((row) => row.id === input.materialId && row.workbenchId === workbenchId)
      : null;
    if (!action && !material) problem('请指定行动或材料');
    if (status === 'prepared' && !material) problem('行动的已准备来自确认写入，不能用回执冒充');
    if (status === 'sent') {
      if (!action || action.kind !== 'draft' || action.state !== 'prepared') problem('只有已保存的回复草稿可以登记为已发送，系统不会代为发信');
      action.state = 'sent';
      action.receipt = note;
    } else if (action && status !== 'prepared') {
      const allowed = status === 'confirmed' ? ['prepared', 'submitted', 'sent'] : ['prepared'];
      if (action.state === 'cancelled') problem('已取消的行动不能登记回执');
      if (!allowed.includes(action.state)) problem('请先确认写入待办，再登记已提交或对方确认');
      action.state = status;
      action.receipt = note;
    }
    if (material && status !== 'sent') {
      if (material.state === 'superseded') problem('已覆盖的材料不能改状态');
      if (status === 'prepared' && material.state !== 'missing') problem('只有待准备的材料可以登记为已准备');
      if (status === 'confirmed' && !['prepared', 'submitted'].includes(material.state)) problem('材料尚未准备或提交，不能标为对方确认');
      if (status === 'submitted' && !['missing', 'prepared'].includes(material.state)) problem('当前材料状态不能登记已提交');
      material.state = status;
      material.receipt = note;
      material.updatedAt = new Date().toISOString();
    }
    if (action) {
      const execution = data.executions.find((row) => row.actionId === action.id && row.kind === 'task.write' && row.taskId);
      if (execution?.mailboxId) {
        const store = readStore(execution.mailboxId);
        const task = (store.tasks || []).find((row) => row.id === execution.taskId);
        if (task) {
          task.scenarioReceipt = { status, note, at: new Date().toISOString() };
          saveStore(store, execution.mailboxId);
        }
      }
    }
    addHistory(data, {
      workbenchId,
      itemId: action?.itemId || material?.itemId,
      kind: 'receipt.recorded',
      detail: status === 'confirmed' ? `对方确认：${note}` : status === 'sent' ? `已发送（用户登记，未代发）：${note}` : status === 'prepared' ? `已准备（尚未提交）：${note}` : `已提交：${note}`,
    });
    return { action, material };
  });
}

/** 日历里删除工作台写入的安排后写回记录，不删除工作台行动。 */
export async function syncLocalEventStatus(actionId, status) {
  if (!actionId || status !== 'removed') return null;
  return mutateScenarioData((data) => {
    const action = data.actions.find((row) => row.id === actionId);
    if (!action) return null;
    action.localEventStatus = 'removed';
    addHistory(data, {
      workbenchId: action.workbenchId,
      itemId: action.itemId,
      kind: 'event.removed',
      detail: '日历中的这场安排已删除，工作台记录保留',
    });
    return action;
  });
}
export async function syncLocalTaskStatus(actionId, status) {
  if (!actionId || !['pending', 'done'].includes(status)) return null;
  return mutateScenarioData((data) => {
    const action = data.actions.find((row) => row.id === actionId);
    if (!action) return null;
    action.localTaskStatus = status;
    addHistory(data, {
      workbenchId: action.workbenchId,
      itemId: action.itemId,
      kind: 'task.local',
      detail: status === 'done' ? '待办页已勾选完成，外部回执状态保持不变' : '待办页已改回未完成',
    });
    return action;
  });
}

export function formatInTimeZone(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type)?.value || '00';
  let hour = pick('hour');
  if (hour === '24') hour = '00';
  return `${pick('year')}-${pick('month')}-${pick('day')}T${hour}:${pick('minute')}`;
}

/** 把墙上时间还原为 UTC。夏令时回拨会得到两个时刻，春季缺口返回 missing。 */
export function resolveLocalTime(local, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(local || ''))) problem('时间须为 YYYY-MM-DDTHH:mm');
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); }
  catch { problem('请使用有效的 IANA 时区，例如 Europe/London'); }
  const [date, clock] = local.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = clock.split(':').map(Number);
  const matches = [];
  for (let offsetMin = -12 * 60; offsetMin <= 14 * 60; offsetMin += 15) {
    const utcMs = Date.UTC(year, month - 1, day, hour, minute) - offsetMin * 60 * 1000;
    if (formatInTimeZone(utcMs, timeZone) !== local) continue;
    matches.push({ utc: new Date(utcMs).toISOString(), offsetMin });
  }
  const options = [...new Map(matches.map((item) => [item.utc, item])).values()];
  if (!options.length) return { local, timeZone, missing: true, ambiguous: false, options: [] };
  return {
    local, timeZone, missing: false, ambiguous: options.length > 1, options,
    utc: options[0].utc,
    beijing: formatInTimeZone(Date.parse(options[0].utc), 'Asia/Shanghai'),
  };
}

function pickResolved(local, timeZone, offsetMin) {
  const resolved = resolveLocalTime(local, timeZone);
  if (resolved.missing) problem(`${local} 在 ${timeZone} 不存在，请改用夏令时切换后的时间`);
  if (resolved.ambiguous) {
    if (offsetMin === undefined || offsetMin === null || offsetMin === '') {
      return { ambiguous: true, resolved };
    }
    const chosen = resolved.options.find((item) => item.offsetMin === Number(offsetMin));
    if (!chosen) problem('请选择夏令时回拨中的具体时刻');
    return {
      ambiguous: false,
      resolved: { ...resolved, utc: chosen.utc, offsetMin: chosen.offsetMin, beijing: formatInTimeZone(Date.parse(chosen.utc), 'Asia/Shanghai') },
    };
  }
  return { ambiguous: false, resolved: { ...resolved, offsetMin: resolved.options[0].offsetMin } };
}

function ownedCalendarEvents() {
  const events = [];
  for (const mailbox of readSettings().mailboxes || []) {
    for (const event of readStore(mailbox.id).events || []) events.push({ ...event, mailboxId: mailbox.id });
  }
  return events;
}

/** 登记一场尚未写入日历的安排。跨时区保留原始时区、UTC 和北京时间。 */
export async function proposeSchedule(workbenchId, itemId, input) {
  const title = name(input.title || '面谈');
  const timeZone = String(input.timeZone || 'Asia/Shanghai');
  const startPick = pickResolved(input.localStart, timeZone, input.startOffsetMin);
  const endPick = pickResolved(input.localEnd, timeZone, input.endOffsetMin);
  if (startPick.ambiguous || endPick.ambiguous) {
    return { written: false, ambiguous: true, start: startPick.resolved, end: endPick.resolved };
  }
  const startMs = Date.parse(startPick.resolved.utc);
  const endMs = Date.parse(endPick.resolved.utc);
  if (!(endMs > startMs)) problem('结束时间必须晚于开始时间');
  return mutateScenarioData((data) => {
    const workbench = findWorkbench(data, workbenchId);
    if (!workbench.template.capabilities.includes('calendar.write')) problem('当前模板不能写入日历');
    const item = data.items.find((entry) => entry.id === itemId && entry.workbenchId === workbenchId);
    if (!item) problem('事项不存在', 404);
    const action = {
      id: randomUUID(), workbenchId, itemId, mailboxId: workbench.mailboxIds[0], title, kind: 'calendar',
      state: 'pending', dependsOn: [],
      reschedule: Boolean(input.reschedule),
      schedule: {
        timeZone,
        localStart: input.localStart,
        localEnd: input.localEnd,
        startOffsetMin: startPick.resolved.offsetMin,
        endOffsetMin: endPick.resolved.offsetMin,
        startUtc: startPick.resolved.utc,
        endUtc: endPick.resolved.utc,
        beijingStart: startPick.resolved.beijing,
        beijingEnd: endPick.resolved.beijing,
      },
      createdAt: new Date().toISOString(),
    };
    data.actions.push(action);
    addHistory(data, {
      workbenchId, itemId, kind: 'schedule.proposed',
      detail: `对方 ${timeZone} ${input.localStart}，北京时间 ${action.schedule.beijingStart}。尚未写入日历。`,
    });
    return { written: false, ambiguous: false, action };
  });
}

function openPrerequisiteTitles(data, action) {
  return (action?.dependsOn || []).flatMap((id) => {
    const gate = data.actions.find((row) => row.id === id);
    if (!gate || gate.itemId !== action.itemId || gate.workbenchId !== action.workbenchId) return ['前置行动缺失，请核对事项计划'];
    if (gate.state === 'cancelled') return [`${gate.title}（已取消，需重新核对）`];
    // Prepared means only that a local task/draft exists; an external receipt is still required.
    return ['confirmed', 'submitted', 'sent'].includes(gate.state) ? [] : [gate.title];
  });
}

export async function confirmSchedule(workbenchId, actionId, input = {}) {
  const data = await readScenarioData();
  const workbench = findWorkbench(data, workbenchId);
  const action = data.actions.find((row) => row.id === actionId && row.workbenchId === workbenchId && row.kind === 'calendar');
  if (!action?.schedule) problem('日程安排不存在', 404);
  if (action.state === 'cancelled') problem('该行动已因后续通知取消，不能再写入日历');
  const openSchedule = openPrerequisiteTitles(data, action);
  if (openSchedule.length) problem(`前置行动尚未完成：${openSchedule.join('、')}`);
  const prior = data.executions.find((row) => row.actionId === actionId && row.kind === 'calendar.write');
  if (prior) return { duplicate: true, execution: prior, conflicts: [] };
  const candidate = { start: action.schedule.startUtc, end: action.schedule.endUtc, allDay: false, status: 'active' };
  const owned = ownedCalendarEvents();
  const mailIds = new Set(mailIdsForItem(data, action.itemId));
  const alreadyOnCalendar = mailIds.size > 0 && owned.some((event) => mailIds.has(event.emailId) && event.start === action.schedule.startUtc && event.status !== 'cancelled');
  const conflicts = findConflicts(candidate, owned).map((event) => ({
    id: event.id, title: event.title, start: event.start, end: event.end,
    workbenchId: event.workbenchId || null, workbenchName: event.workbenchName || '', mailboxId: event.mailboxId,
  }));
  if (conflicts.length && !input.acknowledgeConflicts && !alreadyOnCalendar) {
    return { written: false, conflicts, action };
  }
  return mutateScenarioData((next) => {
    const current = next.actions.find((row) => row.id === actionId);
    if (!current?.schedule) problem('日程安排不存在', 404);
    if (current?.state === 'cancelled') problem('该行动已因后续通知取消，不能再写入日历');
    const openSchedule = openPrerequisiteTitles(next, current);
    if (openSchedule.length) problem(`前置行动尚未完成：${openSchedule.join('、')}`);
    const again = next.executions.find((row) => row.actionId === actionId && row.kind === 'calendar.write');
    if (again) return { duplicate: true, execution: again, conflicts };
    const mailboxId = current.mailboxId || workbench.mailboxIds[0];
    const store = readStore(mailboxId);
    store.events = store.events || [];
    const scheduledItem = next.items.find((entry) => entry.id === current.itemId);
    const mailSource = [...(scheduledItem?.sources || [])].reverse().find((source) => source.emailId);
    if (store.events.some((event) => event.scenarioActionId === actionId)) {
      current.state = 'prepared';
      return { duplicate: true, conflicts, action: current };
    }
    const mailIds = new Set(mailIdsForItem(next, current.itemId));
    const sharedEvent = mailIds.size
      ? (store.events || []).find((event) => mailIds.has(event.emailId) && event.start === current.schedule.startUtc && event.status !== 'cancelled')
      : null;
    if (sharedEvent) {
      current.state = 'prepared';
      rememberWorkbench(sharedEvent, workbench);
      saveCalendarWithExternalSync(store, mailboxId);
      const execution = {
        id: randomUUID(), workbenchId, actionId, kind: 'calendar.write', eventId: sharedEvent.id,
        mailboxId, shared: true, at: new Date().toISOString(),
      };
      next.executions.push(execution);
      addHistory(next, { workbenchId, itemId: current.itemId, kind: 'schedule.shared', detail: '这封邮件的相同时刻已在日历中，未再次写入' });
      return { written: false, duplicate: true, shared: true, conflicts, execution, action: current };
    }
    const previous = current.reschedule
      ? [...next.executions].reverse().find((row) => row.kind === 'calendar.write' && row.workbenchId === workbenchId && next.actions.some((action) => action.id === row.actionId && action.itemId === current.itemId))
      : null;
    const previousEvent = previous ? (store.events || []).find((event) => event.id === previous.eventId && event.status !== 'cancelled') : null;
    const event = {
      id: randomUUID(),
      title: current.title,
      start: current.schedule.startUtc,
      end: current.schedule.endUtc,
      allDay: false,
      status: 'active',
      source: 'scenario',
      scenarioActionId: actionId,
      workbenchId,
      workbenchIds: [workbenchId],
      workbenchName: workbench.name,
      timeZone: current.schedule.timeZone,
      localStart: current.schedule.localStart,
      localEnd: current.schedule.localEnd,
      beijingStart: current.schedule.beijingStart,
      beijingEnd: current.schedule.beijingEnd,
      ...(mailSource ? { emailId: mailSource.emailId, emailSubject: mailSource.subject || '', emailSender: '' } : {}),
      ...(previousEvent ? { previousEventId: previousEvent.id } : {}),
    };
    if (previousEvent) {
      previousEvent.status = 'cancelled';
      previousEvent.cancellationType = 'reschedule';
      previousEvent.replacementEventId = event.id;
    }
    store.events.push(event);
    saveCalendarWithExternalSync(store, mailboxId);
    current.state = 'prepared';
    const execution = { id: randomUUID(), workbenchId, actionId, kind: 'calendar.write', eventId: event.id, mailboxId, at: new Date().toISOString() };
    next.executions.push(execution);
    addHistory(next, {
      workbenchId, itemId: current.itemId, kind: 'schedule.prepared',
      detail: previousEvent
        ? '已改期：原安排保留为已取消，并关联新日程，尚未对外发送'
        : (current.reschedule
          ? '未找到可改期的原安排，已作为新日程写入，尚未对外发送'
          : (conflicts.length ? `已写入日历，并确认与 ${conflicts.length} 个已有安排重叠` : '已写入日历，尚未对外发送')),
    });
    return { written: true, duplicate: false, conflicts, execution, action: current };
  });
}

/** 只读复用已入库附件和知识片段。不重新 OCR，也不调用向量接口。 */
export async function inspectItemEvidence(workbenchId, itemId) {
  const data = await readScenarioData();
  const workbench = findWorkbench(data, workbenchId);
  const item = data.items.find((entry) => entry.id === itemId && entry.workbenchId === workbenchId);
  if (!item) problem('事项不存在', 404);
  const caps = new Set(workbench.template.capabilities || []);
  const attachments = [];
  const traces = [];
  if (caps.has('attachments.read')) {
    for (const source of item.sources || []) {
      if (!source.emailId || !workbench.mailboxIds.includes(source.mailboxId)) continue;
      const email = (readStore(source.mailboxId).emails || []).find((row) => row.id === source.emailId);
      if (!email) continue;
      for (const file of email.attachments || []) {
        attachments.push({
          emailId: source.emailId,
          mailboxId: source.mailboxId,
          subject: String(source.subject || email.subject || '').slice(0, 180),
          filename: String(file.filename || file.name || '附件').slice(0, 180),
          contentType: String(file.contentType || file.mimeType || '').slice(0, 80),
        });
      }
      if (caps.has('recruitment.use')) {
        for (const file of readRecruitment(source.mailboxId).attachments || []) {
          if (file.emailId !== source.emailId) continue;
          attachments.push({
            emailId: source.emailId,
            mailboxId: source.mailboxId,
            subject: String(source.subject || email.subject || '').slice(0, 180),
            filename: String(file.filename || '简历').slice(0, 180),
            contentType: String(file.contentType || '').slice(0, 80),
            candidateId: file.candidateId || null,
            source: 'recruitment',
          });
        }
      }
    }
  }
  if (caps.has('mail.read')) {
    for (const source of item.sources || []) {
      if (!source.emailId || !workbench.mailboxIds.includes(source.mailboxId)) continue;
      const email = (readStore(source.mailboxId).emails || []).find((row) => row.id === source.emailId);
      if (!email) continue;
      const ref = emailReference(email.id);
      for (const trace of readTraces(source.mailboxId)) {
        if (!trace?.trace_id || (trace.trace_id !== email.trace_id && trace.email_ref !== ref && trace.email_ref !== emailReference(`recruitment:${email.id}`))) continue;
        const tools = [];
        for (const span of trace.spans || []) {
          for (const call of span.tool_calls || []) {
            const toolName = String(call?.name || '').slice(0, 80);
            if (toolName && !tools.includes(toolName)) tools.push(toolName);
          }
        }
        traces.push({
          emailId: source.emailId,
          mailboxId: source.mailboxId,
          traceId: trace.trace_id,
          status: String(trace.status || '').slice(0, 40),
          subject: String(trace.subject || email.subject || '').slice(0, 180),
          tools: tools.slice(0, 8),
        });
      }
    }
  }
  if (caps.has('recruitment.use')) {
    const linkedEmails = new Set((item.sources || []).map((source) => source.emailId).filter(Boolean));
    for (const mailboxId of workbench.mailboxIds) {
      const record = readRecruitment(mailboxId);
      if (caps.has('attachments.read')) {
        for (const file of record.attachments || []) {
          if (!linkedEmails.has(file.emailId)) continue;
          if (attachments.some((row) => row.emailId === file.emailId && row.filename === file.filename && row.mailboxId === mailboxId)) continue;
          attachments.push({
            emailId: file.emailId,
            mailboxId,
            filename: String(file.filename || '简历').slice(0, 180),
            contentType: String(file.contentType || '').slice(0, 80),
            candidateId: file.candidateId || null,
            source: 'recruitment',
          });
        }
      }
      for (const trace of record.traces || []) {
        const emailId = [...linkedEmails].find((id) => trace.email_ref === emailReference(id) || trace.email_ref === emailReference(`recruitment:${id}`) || trace.email_id === id);
        if (!emailId || traces.some((row) => row.traceId === trace.trace_id)) continue;
        const tools = [];
        for (const span of trace.spans || []) {
          for (const call of span.tool_calls || []) {
            const toolName = String(call?.name || '').slice(0, 80);
            if (toolName && !tools.includes(toolName)) tools.push(toolName);
          }
        }
        traces.push({
          emailId,
          mailboxId,
          traceId: trace.trace_id,
          status: String(trace.status || '').slice(0, 40),
          subject: String(trace.subject || '').slice(0, 180),
          tools: tools.slice(0, 8),
          source: 'recruitment',
        });
      }
    }
  }
  let citations = [];
  let retrieval = caps.has('knowledge.search') ? 'disabled' : 'skipped';
  if (caps.has('knowledge.search')) {
    const { isRagEnabled, ragSearch } = await import('../rag/index.js');
    const settings = readSettings();
    if (isRagEnabled(settings)) {
      const query = [item.title, ...Object.values(item.fields || {})].map((value) => String(value || '').trim()).filter(Boolean).join(' ').slice(0, 500);
      const seen = new Set();
      for (const mailboxId of workbench.mailboxIds) {
        const result = await ragSearch({ mailboxId, query, settings: { ...settings, ragEmbeddings: false }, limit: 4 });
        for (const citation of result.citations || []) {
          if (!citation.chunkId || seen.has(citation.chunkId)) continue;
          seen.add(citation.chunkId);
          citations.push({
            chunkId: citation.chunkId,
            mailboxId,
            filename: String(citation.filename || '').slice(0, 180),
            page: citation.page,
            quote: String(citation.quote || '').slice(0, 280),
            score: citation.score,
          });
        }
      }
      citations = citations.sort((left, right) => right.score - left.score).slice(0, 4);
      retrieval = 'keyword';
    }
  }
  return { attachments: attachments.slice(0, 20), citations, retrieval, traces: traces.slice(0, 20) };
}
