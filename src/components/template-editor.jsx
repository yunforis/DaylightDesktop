import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { WorkbenchSelect } from '@/components/scenario-studio';
import { request } from '@/lib/api';
export const PAGE_BLOCKS = [
  ['board', '事项看板'],
  ['mail', '邮件与外部来源'],
  ['materials', '材料清单'],
  ['actions', '行动、草稿与安排'],
];
export const EDITABLE_CAPABILITIES = [
  ['mail.read', '读取邮件'],
  ['attachments.read', '读取附件'],
  ['knowledge.search', '检索知识库'],
  ['tasks.write', '写入待办'],
  ['calendar.write', '写入日历'],
  ['drafts.write', '保存回复草稿'],
  ['mail.send', '申请发信（仍需人工确认）'],
];

function Field({ label, children }) {
  return <label className="grid gap-2 text-sm"><span className="font-medium">{label}</span>{children}</label>;
}
function splitList(value) {
  return String(value || '').split(/[,，]/).map((item) => item.trim()).filter(Boolean);
}
function joinList(value) {
  return (value || []).join('，');
}
function writeFirstSample(template, partial) {
  const samples = Array.isArray(template.samples) ? [...template.samples] : [];
  samples[0] = { ...(samples[0] || { input: '', expected: '' }), ...partial };
  return samples;
}

export function prepareTemplate(template) {
  return {
    ...template,
    description: template.description || template.name,
    subtitle: template.subtitle || template.name,
    signals: (template.signals || []).filter((signal) => (signal.keywords || []).length).map((signal) => ({
      ...signal,
      suggestedStage: signal.suggestedStage || null,
      followUpDays: signal.followUpDays || null,
    })),
    samples: (template.samples || []).filter((sample) => sample.input && sample.expected),
  };
}

export function emptyTemplate() {
  return {
    schemaVersion: 1,
    id: 'customdraft',
    version: '0.1.0',
    name: '',
    subtitle: '',
    description: '',
    author: '个人模板',
    fields: [{ key: 'subject', label: '主题', type: 'text', required: true }],
    stages: [{ id: 'open', label: '进行中' }, { id: 'closed', label: '已结束' }],
    capabilities: ['mail.read', 'tasks.write', 'drafts.write'],
    views: PAGE_BLOCKS.map(([id]) => id),
    rules: '由用户确认后再执行外部动作。读到邮件不代表已经提交或对方已确认。',
    keywords: [],
    materials: [],
    externalSources: [],
    samples: [{ input: '', expected: '' }],
    signals: [],
    noticeWarning: '读到邮件不代表已提交或对方已确认',
  };
}

export default function TemplateEditor({ template, onChange }) {
  const [replay, setReplay] = useState(null);
  const patch = (partial) => onChange({ ...template, ...partial });
  const stages = template.stages || [];
  const setSignal = (index, partial) => {
    const signals = template.signals.map((signal, position) => (position === index ? { ...signal, ...partial } : signal));
    patch({ signals });
  };
  return <div className="space-y-4">
    <div className="grid gap-3 md:grid-cols-2">
      <Field label="模板名称"><Input value={template.name} onChange={(event) => patch({ name: event.target.value, subtitle: template.subtitle || event.target.value })} /></Field>
      <Field label="一句话说明"><Input value={template.subtitle || ''} onChange={(event) => patch({ subtitle: event.target.value })} /></Field>
    </div>
    <Field label="这个工作台做什么"><Textarea value={template.description || ''} onChange={(event) => patch({ description: event.target.value })} /></Field>
    <Field label="处理提示词"><Textarea className="min-h-24" value={template.rules || ''} onChange={(event) => patch({ rules: event.target.value })} placeholder="告诉模型如何提取字段、如何区分阶段。不能据此自动发信。" /></Field>
    <Field label="未命中时的提示"><Input value={template.noticeWarning || ''} onChange={(event) => patch({ noticeWarning: event.target.value })} /></Field>
    <div className="grid gap-3 md:grid-cols-3">
      <Field label="邮件关键词"><Input value={joinList(template.keywords)} onChange={(event) => patch({ keywords: splitList(event.target.value) })} placeholder="发票，报销" /></Field>
      <Field label="材料清单"><Input value={joinList(template.materials)} onChange={(event) => patch({ materials: splitList(event.target.value) })} placeholder="发票，付款回单" /></Field>
      <Field label="外部来源"><Input value={joinList(template.externalSources)} onChange={(event) => patch({ externalSources: splitList(event.target.value) })} placeholder="财务系统，微信" /></Field>
    </div>
    <section className="space-y-2">
      <div className="flex items-center justify-between"><p className="text-sm font-medium">字段</p><Button type="button" size="sm" variant="outline" onClick={() => patch({ fields: [...template.fields, { key: `field${template.fields.length + 1}`, label: '新字段', type: 'text', required: false }] })}>添加字段</Button></div>
      {template.fields.map((field, index) => <div key={`${field.key}-${index}`} className="grid gap-2 md:grid-cols-[1fr_1fr_8rem_auto_auto]">
        <Input aria-label="字段标识" value={field.key} onChange={(event) => patch({ fields: template.fields.map((item, position) => position === index ? { ...item, key: event.target.value } : item) })} />
        <Input aria-label="字段名称" value={field.label} onChange={(event) => patch({ fields: template.fields.map((item, position) => position === index ? { ...item, label: event.target.value } : item) })} />
        <WorkbenchSelect aria-label="字段类型" value={field.type} onValueChange={(type) => patch({ fields: template.fields.map((item, position) => position === index ? { ...item, type } : item) })} options={['text', 'email', 'url', 'number', 'date', 'timezone'].map((type) => ({ value: type, label: type }))} />
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={Boolean(field.required)} onCheckedChange={(checked) => patch({ fields: template.fields.map((item, position) => position === index ? { ...item, required: checked === true } : item) })} />必填</label>
        <Button type="button" size="sm" variant="outline" onClick={() => patch({ fields: template.fields.filter((_, position) => position !== index) })}>删除</Button>
      </div>)}
    </section>
    <section className="space-y-2">
      <div className="flex items-center justify-between"><p className="text-sm font-medium">阶段</p><Button type="button" size="sm" variant="outline" onClick={() => patch({ stages: [...stages, { id: `stage${stages.length + 1}`, label: '新阶段' }] })}>添加阶段</Button></div>
      {stages.map((stage, index) => <div key={`${stage.id}-${index}`} className="grid gap-2 md:grid-cols-[1fr_1fr_auto_auto]">
        <Input aria-label="阶段标识" value={stage.id} onChange={(event) => patch({ stages: stages.map((item, position) => position === index ? { ...item, id: event.target.value } : item) })} />
        <Input aria-label="阶段名称" value={stage.label} onChange={(event) => patch({ stages: stages.map((item, position) => position === index ? { ...item, label: event.target.value } : item) })} />
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={Boolean(stage.evidence)} onCheckedChange={(checked) => patch({ stages: stages.map((item, position) => position === index ? { ...item, evidence: checked === true } : item) })} />进入时需要回执</label>
        <Button type="button" size="sm" variant="outline" onClick={() => patch({ stages: stages.filter((_, position) => position !== index) })}>删除</Button>
      </div>)}
    </section>
    <section className="space-y-2">
      <div className="flex items-center justify-between"><p className="text-sm font-medium">识别信号</p><Button type="button" size="sm" variant="outline" onClick={() => patch({ signals: [...(template.signals || []), { keywords: [], suggestedStage: '', tasks: [], warning: '', priority: (template.signals || []).length + 1 }] })}>添加信号</Button></div>
      <p className="text-xs text-muted-foreground">按词匹配邮件或外部原文。优先级高的决定阶段。不能写正则或代码。</p>
      {(template.signals || []).map((signal, index) => <div key={index} className="grid gap-2 rounded-md border p-3">
        <Field label="关键词"><Input value={joinList(signal.keywords)} onChange={(event) => setSignal(index, { keywords: splitList(event.target.value) })} /></Field>
        <div className="grid gap-2 md:grid-cols-2">
          <Field label="建议阶段"><WorkbenchSelect value={signal.suggestedStage || 'none'} onValueChange={(value) => setSignal(index, { suggestedStage: value === 'none' ? null : value })} options={[{ value: 'none', label: '不改阶段' }, ...stages.map((stage) => ({ value: stage.id, label: stage.label }))]} /></Field>
          <Field label="跟进天数"><Input value={signal.followUpDays ?? ''} onChange={(event) => setSignal(index, { followUpDays: event.target.value === '' ? null : Number(event.target.value) })} /></Field>
        </div>
        <Field label="要生成的待办"><Input value={joinList(signal.tasks)} onChange={(event) => setSignal(index, { tasks: splitList(event.target.value) })} /></Field>
        <div className="grid gap-2 md:grid-cols-2">
          <Field label="前置待办"><Input value={joinList(signal.dependsOn)} placeholder="共同作者确认" onChange={(event) => setSignal(index, { dependsOn: splitList(event.target.value) })} /></Field>
          <Field label="出现这些词才挂前置"><Input value={joinList(signal.dependsOnKeywords)} placeholder="所有作者，共同作者" onChange={(event) => setSignal(index, { dependsOnKeywords: splitList(event.target.value) })} /></Field>
        </div>
        <Field label="优先级"><Input value={signal.priority ?? ''} onChange={(event) => setSignal(index, { priority: event.target.value === '' ? 0 : Number(event.target.value) })} /></Field>
        <Field label="提示"><Input value={signal.warning || ''} onChange={(event) => setSignal(index, { warning: event.target.value })} /></Field>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2"><Checkbox checked={Boolean(signal.supersede)} onCheckedChange={(checked) => setSignal(index, { supersede: checked === true })} />覆盖旧材料</label>
          <label className="flex items-center gap-2"><Checkbox checked={Boolean(signal.exclusive)} onCheckedChange={(checked) => setSignal(index, { exclusive: checked === true })} />只保留本信号任务</label>
          <label className="flex items-center gap-2"><Checkbox checked={Boolean(signal.holdResult)} onCheckedChange={(checked) => setSignal(index, { holdResult: checked === true })} />不能标成正式结果</label>
          <label className="flex items-center gap-2"><Checkbox checked={Boolean(signal.holdAdvance)} onCheckedChange={(checked) => setSignal(index, { holdAdvance: checked === true })} />不据此进入下一阶段</label>
          <Button type="button" size="sm" variant="outline" onClick={() => patch({ signals: template.signals.filter((_, position) => position !== index) })}>删除信号</Button>
        </div>
      </div>)}
    </section>
    <section className="space-y-2">
      <p className="text-sm font-medium">页面上显示哪些块</p>
      <div className="flex flex-wrap gap-3 text-sm">{PAGE_BLOCKS.map(([id, label]) => <label key={id} className="flex items-center gap-2"><Checkbox checked={(template.views || []).includes(id)} onCheckedChange={(checked) => patch({ views: checked ? [...new Set([...(template.views || []), id, 'overview', 'items'])] : (template.views || []).filter((view) => view !== id) })} />{label}</label>)}</div>
    </section>
    <section className="space-y-2">
      <p className="text-sm font-medium">使用的平台能力</p>
      <p className="text-xs text-muted-foreground">保存后的工作台使用同一套进度、来信和场景助手。助手里的提示来自下面的材料、识别信号和样例，不需要再写页面代码。</p>
      <div className="flex flex-wrap gap-3 text-sm">{EDITABLE_CAPABILITIES.map(([id, label]) => <label key={id} className="flex items-center gap-2"><Checkbox checked={(template.capabilities || []).includes(id)} onCheckedChange={(checked) => patch({ capabilities: checked ? [...new Set([...(template.capabilities || []), id])] : (template.capabilities || []).filter((item) => item !== id) })} />{label}</label>)}</div>
      {(template.capabilities || []).includes('recruitment.use') && <p className="text-xs text-muted-foreground">招聘引擎只保留在这个内置模板上，不能通过这里打开或关掉。</p>}
    </section>
    <Field label="样例输入"><Textarea value={template.samples?.[0]?.input || ''} onChange={(event) => patch({ samples: writeFirstSample(template, { input: event.target.value, expected: template.samples?.[0]?.expected || '生成待确认行动，不自动提交。' }) })} /></Field>
    <Field label="样例预期"><Input value={template.samples?.[0]?.expected || ''} onChange={(event) => patch({ samples: writeFirstSample(template, { expected: event.target.value }) })} /></Field>
    {(template.samples || []).length > 1 && <p className="text-xs text-muted-foreground">表单编辑第一条样例，其余 {template.samples.length - 1} 条会保留。全部样例可在高级 JSON 里改。</p>}
    <Button type="button" variant="outline" disabled={!template.name?.trim()} onClick={async () => {
      try {
        const result = await request('/scenarios/templates/replay', 'POST', { ...prepareTemplate(template), receivedAt: '2026-10-13T01:00:00.000Z' });
        setReplay(result);
      } catch (error) {
        setReplay({ error: error.message });
      }
    }}>回放样例（不写入、不发信）</Button>
    {replay?.error && <p className="text-sm text-destructive">{replay.error}</p>}
    {replay?.samples?.map((sample) => <div key={sample.input} className="space-y-1 rounded-md border p-3 text-sm">
      <p className="text-muted-foreground">预期：{sample.expected}</p>
      <p>{sample.interpretation?.warning}</p>
      <p>{sample.actions.length ? sample.actions.map((action) => `${action.kind === 'calendar' ? '待确认安排' : '待确认待办'}：${action.title}`).join('；') : '没有生成动作'}</p>
      <p className="text-xs text-muted-foreground">尚未写入待办或日历，也没有发信。</p>
    </div>)}
  </div>;
}
