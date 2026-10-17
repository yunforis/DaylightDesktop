import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Download, LayoutDashboard, PanelsTopLeft, Plus, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { request as apiRequest } from '@/lib/api';
import { fullDateTime } from '@/lib/time';
import { templateCatalog } from '../../shared/scenario-templates.js';
import { useWorkspace } from '@/context/workspace';
import RecruitmentPage from '@/pages/recruitment-page';
import InvoicesPage from '@/pages/invoices-page';
import { WORKBENCH_FEATURES, useWorkbenches } from '@/context/workbenches';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import TemplateEditor, { emptyTemplate, prepareTemplate } from '@/components/template-editor';
import { ScenarioAssistant, WorkbenchSelect } from '@/components/scenario-studio';

function showView(template, name) {
  return !template.views?.length || template.views.includes(name);
}
function Field({label,children}) { return <label className="grid gap-2 text-sm"><span className="font-medium">{label}</span>{children}</label>; }
function openPrerequisiteTitles(actions, row) {
  return (row.dependsOn || []).flatMap((id) => {
    const gate = (actions || []).find((action) => action.id === id);
    return gate && !['prepared', 'confirmed', 'submitted', 'sent', 'cancelled'].includes(gate.state) ? [gate.title] : [];
  });
}
function download(value,filename) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  const a=document.createElement('a'); a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);
}
function catalogLabel(template) {
  const catalog = templateCatalog(template);
  if (catalog === 'official') return '官方模板';
  if (catalog === 'personal') return '个人模板';
  return '社区模板';
}

export default function WorkbenchesPage() {
  const {id}=useParams();
  const [params, setParams]=useSearchParams();
  const location = useLocation();
  const adjusting = !id && params.get('adjust') === '1';
  const navigate=useNavigate();
  const { openEmail, trackJob } = useWorkspace();
  const request = async (url, method, body) => {
    if (!url.endsWith('/plan') || method !== 'POST') return apiRequest(url, method, body);
    let result;
    try {
      result = await apiRequest(url, method, body, { idempotencyKey: crypto.randomUUID() });
    } catch {
      throw new Error('分析任务未能提交，请稍后重试。');
    }
    if (result.job) {
      trackJob(result.job);
      return { ...result, interpretation: { warning: '分析任务已提交，请在对应邮箱的「后台任务」查看进度；完成后建议会更新。' } };
    }
    return result;
  };
  const { data, error, loading, reload, scenarioWorkbenches, visibleFeatures, visibleWorkbenches } = useWorkbenches();
  const [busy,setBusy]=useState(false);
  const [chosen,setChosen]=useState(null),[title,setTitle]=useState(''),[mailboxIds,setMailboxIds]=useState([]);
  const [itemDraft,setItemDraft]=useState(null),[config,setConfig]=useState(null),[composer,setComposer]=useState(null),[preview,setPreview]=useState(null);
  const [slot,setSlot]=useState({title:'面谈或面试',localStart:'',localEnd:'',timeZone:'Asia/Shanghai',startOffsetMin:'',endOffsetMin:'',reschedule:false});
  const [scheduleItemId,setScheduleItemId]=useState('');
  const [mailItemId,setMailItemId]=useState('new');
  const [recruitMailboxId,setRecruitMailboxId]=useState('');
  const [stageFilter,setStageFilter]=useState('all');
  const [replyBody,setReplyBody]=useState('');
  const [externalNote,setExternalNote]=useState('');
  const [externalChannel,setExternalChannel]=useState('');
  const [formMessage,setFormMessage]=useState('');
  const [evidence,setEvidence]=useState(null);
  const [upgradePreview,setUpgradePreview]=useState(null);
  const [contextMenu,setContextMenu]=useState(null);
  const stateLabel={pending:'待确认',prepared:'已准备',submitted:'已提交',sent:'已发送',confirmed:'对方确认',missing:'待准备',superseded:'已覆盖',cancelled:'已取消'};
  const execute=async(fn)=>{
    setBusy(true);
    try {await fn();await reload();}
    catch(e){setFormMessage(e.message);toast.error(e.message);}
    finally{setBusy(false);}
  };
  const workbench=data?.workbenches.find(w=>w.id===id);
  const templates=useMemo(() => {
    if (!data) return [];
    const personal = (data.templates || []).map((template) => ({ ...template, catalog: 'personal' }));
    return [...(data.officialTemplates || []), ...personal];
  }, [data]);
  const officialTemplates = templates.filter((template) => templateCatalog(template) === 'official');
  const communityTemplates = templates.filter((template) => templateCatalog(template) === 'community');
  const personalTemplates = templates.filter((template) => templateCatalog(template) === 'personal');
  const managedEntries = useMemo(() => {
    if (!data) return [];
    const features = WORKBENCH_FEATURES
      .filter((feature) => !data.navigation?.hiddenFeatureIds?.includes(feature.id))
      .map((feature) => ({ kind: 'feature', id: feature.id, name: feature.name, description: feature.description, path: feature.path, icon: feature.icon }));
    const boards = (scenarioWorkbenches || [])
      .filter((item) => !item.archived && !data.navigation?.hiddenWorkbenchIds?.includes(item.id))
      .map((item) => ({ kind: 'workbench', id: item.id, name: item.name, description: item.template?.name || '场景工作台', path: `/app/workbenches/${item.id}`, templateName: item.template?.name }));
    return [...features, ...boards];
  }, [data, scenarioWorkbenches]);
  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);
  const items=data?.items.filter(i=>i.workbenchId===id) || [];
  const itemKey=items.map(item=>item.id).join(',');
  useEffect(()=>{
    if (!items.some(item=>item.id===scheduleItemId)) setScheduleItemId(items[0]?.id || '');
  },[itemKey]);
  useEffect(()=>{
    if (mailItemId!=='new' && !items.some(item=>item.id===mailItemId)) setMailItemId(items[0]?.id || 'new');
  },[itemKey]);
  const mailboxKey=(workbench?.mailboxIds || []).join(',');
  useEffect(()=>{
    if (!workbench?.mailboxIds.includes(recruitMailboxId)) setRecruitMailboxId(workbench?.mailboxIds[0] || '');
  },[mailboxKey]);
  const templateStamp = workbench ? `${workbench.id}:${workbench.template.version}:${workbench.template.stages.map((stage) => `${stage.id}${stage.evidence ? '!' : ''}`).join(',')}:${(workbench.template.signals || []).length}` : '';
  useEffect(() => {
    if (!workbench || String(workbench.template.id).startsWith('custom-')) {
      setUpgradePreview(null);
      return undefined;
    }
    let cancelled = false;
    request(`/scenarios/workbenches/${workbench.id}/upgrade`).then((preview) => {
      if (!cancelled) setUpgradePreview(preview);
    }).catch(() => { if (!cancelled) setUpgradePreview(null); });
    return () => { cancelled = true; };
  }, [templateStamp]);
  useEffect(() => {
    if (!adjusting) return undefined;
    const hash = location.hash?.replace(/^#/, '');
    if (!hash) return undefined;
    const timer = window.setTimeout(() => {
      document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [adjusting, location.hash, location.search]);
  const startCreate=template=>{setChosen(template);setTitle(template.name);setMailboxIds(data.mailboxes[0] ? [data.mailboxes[0].id] : []);};
  const create=()=>execute(async()=>{
    const result=await request('/scenarios/workbenches','POST',{templateId:chosen.id,name:title,mailboxIds});
    if ((chosen.id === 'recruitment' || chosen.id === 'invoices') && data.navigation?.hiddenFeatureIds?.includes(chosen.id)) {
      await request('/scenarios/navigation/visibility', 'PATCH', { kind: 'feature', id: chosen.id, visible: true });
    }
    setChosen(null);navigate(`/app/workbenches/${result.id}`);
  });
  const receiptForStage = (currentStage, stageId) => {
    const stage = workbench?.template.stages.find((item) => item.id === stageId);
    if (!stage?.evidence || currentStage === stageId) return { stage: stageId };
    const receipt = window.prompt(`进入「${stage.label}」需要回执。粘贴提交、缴费或对方确认的原文。收到通知不能代替这一步。`);
    if (!receipt?.trim()) return null;
    return { stage: stageId, receipt: receipt.trim() };
  };
  const saveItem=()=>execute(async()=>{
    const current = items.find((item) => item.id === itemDraft.id);
    const stagePatch = receiptForStage(current?.stage, itemDraft.stage);
    if (!stagePatch) return;
    await request(`/scenarios/workbenches/${id}/items${itemDraft.id ? `/${itemDraft.id}`:''}`,itemDraft.id?'PATCH':'POST',{...itemDraft,...stagePatch});
    setItemDraft(null);
  });
  const upload=event=>{
    const file=event.target.files?.[0];event.target.value='';if(!file)return;
    execute(async()=>{const template=await request('/scenarios/templates/import','POST',JSON.parse(await file.text()));toast.success(`已添加个人模板：${template.name}`);});
  };
  const setVisible = (kind, entryId, visible) => execute(async () => {
    await request('/scenarios/navigation/visibility', 'PATCH', { kind, id: entryId, visible });
  });
  const removeEntry = (entry) => execute(async () => {
    await request('/scenarios/navigation/visibility', 'PATCH', {
      kind: entry.kind === 'feature' ? 'feature' : 'workbench',
      id: entry.id,
      visible: false,
    });
    toast.success(`已移除「${entry.name}」`);
    setContextMenu(null);
  });
  const enableFeature = (featureId) => execute(async () => {
    await request('/scenarios/navigation/visibility', 'PATCH', { kind: 'feature', id: featureId, visible: true });
    toast.success('已显示功能入口');
  });
  const renderTemplateCard = (t) => {
    const catalog = templateCatalog(t);
    const official = catalog === 'official';
    const featureId = t.id === 'recruitment' || t.id === 'invoices' ? t.id : null;
    const featureHidden = featureId && data.navigation?.hiddenFeatureIds?.includes(featureId);
    return <Card key={t.id} className={official ? 'flex flex-col border-primary/40 shadow-sm ring-1 ring-primary/15' : 'flex flex-col'}>
      <CardHeader>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <Badge variant={official ? 'default' : 'secondary'} className={official ? 'bg-primary text-primary-foreground' : ''}>
            {catalogLabel(t)}
          </Badge>
          <span className="text-muted-foreground">v{t.version}</span>
        </CardDescription>
        <CardTitle className="text-lg">{t.name}</CardTitle>
        <CardDescription>{t.subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <p className="flex-1 text-sm text-muted-foreground">{t.description}</p>
        <div className="flex flex-wrap gap-2">
          {featureHidden && <Button variant="default" disabled={busy} onClick={() => enableFeature(featureId)}>显示入口</Button>}
          <Button variant="outline" disabled={busy} onClick={() => startCreate(t)}><Plus className="size-4"/>添加工作台</Button>
          {catalog === 'personal' && <Button variant="ghost" disabled={busy} onClick={() => execute(async () => {
            if (!window.confirm(`删除个人模板「${t.name}」？已经用它创建的工作台会保留。`)) return;
            await request(`/scenarios/templates/${t.id}`, 'DELETE');
            toast.success('已删除个人模板');
          })}>删除模板</Button>}
        </div>
      </CardContent>
    </Card>;
  };
  if(!data)return <div className="p-6 text-sm">{error || '正在加载工作台…'}{error && <Button onClick={()=>reload().catch(()=>{})} variant="outline" className="ml-3">重试</Button>}</div>;
  if(id&&!workbench)return <div className="p-6">{loading ? '正在加载工作台…' : error || '工作台不存在。'}{error && <Button onClick={()=>reload().catch(()=>{})} variant="outline" className="ml-3">重试</Button>}<Link to="/app/workbenches" className="ml-2 underline">返回工作台</Link></div>;
  const focusItem = items.find((item) => item.id === scheduleItemId) || null;
  const blockedTitles = (item) => (data.actions || []).filter((row) => row.itemId === item.id && openPrerequisiteTitles(data.actions, row).length).map((row) => `${row.title}需先完成${openPrerequisiteTitles(data.actions, row).join('、')}`);
  const visibleItems = stageFilter === 'all' ? items : items.filter((item) => item.stage === stageFilter);
  return <div className="mx-auto w-full max-w-5xl space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        {(id || adjusting) && <Link to="/app/workbenches" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground"><ArrowLeft className="size-4"/>我的工作台</Link>}
        <h1 className="text-2xl font-semibold tracking-tight">{workbench?.name || (adjusting ? '管理工作台' : '我的工作台')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{workbench?.template.description || (adjusting ? '在下方管理已添加的入口，或从官方与社区模板继续添加。移除只收起导航，已有数据始终保留。' : '集中使用常用功能，把邮件中的机会、要求和下一步行动组织起来。')}</p>
      </div>
      {workbench ? <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={()=>execute(async()=>{const preview=await request(`/scenarios/workbenches/${id}/upgrade`); if(!preview.available){toast.message(preview.reason||'已是当前官方模板');return;} await request(`/scenarios/workbenches/${id}/upgrade`,'POST',{}); toast.success(preview.currentVersion===preview.nextVersion ? '已更新官方识别规则，事项保留' : `已升级到 ${preview.nextVersion}，事项保留`);})}>检查模板升级</Button>
        <Button variant="outline" onClick={()=>setConfig({name:workbench.name,keywords:workbench.scope.keywords.join(', '),senders:workbench.scope.senders.join(', '),template:structuredClone(workbench.template),raw:false})}>工作台设置</Button>
        <Button variant="outline" disabled={busy} onClick={()=>execute(async()=>{
          if(!window.confirm(`删除工作台「${workbench.name}」？这个工作台里的事项和材料清单会去掉。已经写入的待办、日程和招聘资料仍留在原来的邮箱里。`)) return;
          await request(`/scenarios/workbenches/${id}`,'DELETE');
          toast.success('已删除工作台');
          navigate('/app/workbenches');
        })}>删除工作台</Button>
        <Button disabled={workbench.archived} onClick={()=>setItemDraft({title:'',fields:{},stage:workbench.template.stages[0].id,notes:''})}><Plus className="size-4"/>新建事项</Button>
      </div> : adjusting ? <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={()=>setComposer(emptyTemplate())}>制作模板</Button><Button asChild variant="outline"><label className="cursor-pointer"><Upload className="size-4"/>导入模板<input type="file" accept="application/json,.json" className="hidden" onChange={upload}/></label></Button><Button asChild><Link to="/app/workbenches">完成</Link></Button></div> : null}
    </header>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {workbench && upgradePreview?.available && <Alert><AlertDescription>{upgradePreview.evidenceStages?.length ? `官方模板有更新。点「检查模板升级」后，已有事项会保留；进入${upgradePreview.evidenceStages.join('、')}需要回执，收到通知不能代替提交或确认。` : (upgradePreview.reason || '官方模板有更新。点「检查模板升级」后，已有事项会保留。')}</AlertDescription></Alert>}
    {!workbench ? <>
      {adjusting ? <>
        <section className="space-y-4" aria-labelledby="workbench-visibility-title">
          <div><h2 id="workbench-visibility-title" className="text-lg font-semibold">已添加的工作台</h2><p className="mt-1 text-sm text-muted-foreground">可直接移除，或右键打开菜单。移除只收起侧栏和首页入口，事项与招聘资料仍保留。</p></div>
          {managedEntries.length ? <div className="grid gap-3 sm:grid-cols-2">{managedEntries.map((entry) => {
            const Icon = entry.icon || PanelsTopLeft;
            return <Card
              key={`${entry.kind}:${entry.id}`}
              className="relative"
              onContextMenu={(event) => {
                event.preventDefault();
                setContextMenu({ entry, x: event.clientX, y: event.clientY });
              }}
            >
              <CardContent className="flex items-center justify-between gap-4 py-5">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <Icon className="size-4 shrink-0 text-primary" />
                    <p className="truncate text-base font-medium">{entry.name}</p>
                  </div>
                  <p className="text-xs text-muted-foreground">{entry.kind === 'feature' ? '功能入口' : entry.templateName} · 已添加</p>
                  <Link to={entry.path} className="inline-flex items-center gap-1 text-sm text-primary">打开<ArrowRight className="size-3"/></Link>
                </div>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => removeEntry(entry)}>移除</Button>
              </CardContent>
            </Card>;
          })}</div> : <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">还没有已添加的入口。从下方模板添加后会出现在这里。</CardContent></Card>}
        </section>
        <section id="add-workbench" className="space-y-6">
          <div><h2 className="text-lg font-semibold">添加工作台</h2><p className="mt-1 text-sm text-muted-foreground">选择模板，每个场景都可以创建多个工作台。添加时不会自动发信或修改历史日程。</p></div>
          {officialTemplates.length > 0 && <div className="space-y-3">
            <h3 className="text-sm font-semibold tracking-wide text-primary">官方模板</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{officialTemplates.map(renderTemplateCard)}</div>
          </div>}
          {communityTemplates.length > 0 && <div className="space-y-3">
            <h3 className="text-sm font-semibold tracking-wide text-muted-foreground">社区模板</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{communityTemplates.map(renderTemplateCard)}</div>
          </div>}
          {personalTemplates.length > 0 && <div className="space-y-3">
            <h3 className="text-sm font-semibold tracking-wide text-muted-foreground">个人模板</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{personalTemplates.map(renderTemplateCard)}</div>
          </div>}
      </section>
        {contextMenu && <div
          className="fixed z-50 min-w-40 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" className="flex w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => { navigate(contextMenu.entry.path); setContextMenu(null); }}>打开</button>
          <button type="button" className="flex w-full rounded-sm px-2 py-1.5 text-left text-sm text-destructive hover:bg-accent" disabled={busy} onClick={() => removeEntry(contextMenu.entry)}>移除</button>
        </div>}
      </> : visibleFeatures.length || visibleWorkbenches.length ? <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="我的工作台功能">
        {visibleFeatures.map(feature=><Link key={feature.id} to={feature.path}><Card className="h-full transition-colors hover:border-primary/50"><CardHeader><CardDescription className="flex items-center gap-2"><feature.icon className="size-4"/>内置功能</CardDescription><CardTitle className="flex items-center justify-between text-lg">{feature.name}<ArrowRight className="size-4"/></CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">{feature.description}</CardContent></Card></Link>)}
        {visibleWorkbenches.map(w=><Link key={w.id} to={`/app/workbenches/${w.id}`}><Card className="h-full transition-colors hover:border-primary/50"><CardHeader><CardDescription className="flex items-center gap-2"><PanelsTopLeft className="size-4"/>{w.template.name}</CardDescription><CardTitle className="flex items-center justify-between gap-2 text-lg"><span className="truncate">{w.name}</span><ArrowRight className="size-4 shrink-0"/></CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">{data.items.filter(i=>i.workbenchId===w.id).length} 个事项 · {w.mailboxIds.length} 个关联邮箱</CardContent></Card></Link>)}
      </section> : <Card><CardContent className="flex flex-col items-center gap-3 py-12 text-center"><LayoutDashboard className="size-8 text-muted-foreground"/><h2 className="font-medium">还没有显示的功能</h2><p className="text-sm text-muted-foreground">通过侧栏「管理工作台」添加官方或社区模板。</p><Button asChild variant="outline"><Link to="/app/workbenches?adjust=1">管理工作台</Link></Button></CardContent></Card>}
    </> : <>
      <div className="flex flex-wrap gap-2">{[`${workbench.template.name} · v${workbench.template.version}`, ...workbench.mailboxIds.map(mid=>data.mailboxes.find(m=>m.id===mid)?.email || mid)].map(label=><Badge key={label} variant="secondary">{label}</Badge>)}</div>
      {workbench.template.capabilities?.includes('recruitment.use') && (
        <Card id="recruitment-engine">
          <CardHeader>
            <CardTitle className="text-base">智能招聘</CardTitle>
            <CardDescription>候选人、简历解析、RAG、筛选对话、邀约审核、发信与飞书会议都在此工作台内使用，数据按该工作台绑定的邮箱保存。</CardDescription>
          </CardHeader>
          <CardContent className="min-w-0 space-y-3">
            {workbench.mailboxIds.length>1 && <Field label="招聘使用的邮箱"><WorkbenchSelect value={recruitMailboxId} onValueChange={setRecruitMailboxId} options={workbench.mailboxIds.map(mailboxId=>({value:mailboxId,label:(data.mailboxes.find(m=>m.id===mailboxId)?.email)||mailboxId}))}/></Field>}
            <RecruitmentPage embedded mailboxId={recruitMailboxId || workbench.mailboxIds[0]} />
          </CardContent>
        </Card>
      )}
      {workbench.template.capabilities?.includes('invoices.use') && (
        <Card id="invoice-assistant">
          <CardHeader>
            <CardTitle className="text-base">发票助手</CardTitle>
            <CardDescription>从邮件附件提取发票字段并复制报销信息。提取结果需对照原件，这里不自动改日程或待办。</CardDescription>
          </CardHeader>
          <CardContent className="min-w-0"><InvoicesPage embedded mailboxIds={workbench.mailboxIds} /></CardContent>
        </Card>
      )}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]">
      {showView(workbench.template,'board') && <Card className="min-w-0 lg:sticky lg:top-0">
        <CardHeader className="gap-3">
          <CardTitle className="text-base">跟进中的事项</CardTitle>
          <CardDescription>{workbench.template.noticeWarning || '收到通知只记为来源。阶段、材料和回执分开看，确认后才写入待办。'}</CardDescription>
          <div className="flex flex-wrap gap-1.5">{[{id:'all',label:'全部',count:items.length}].concat(workbench.template.stages.filter(stage=>items.some(item=>item.stage===stage.id)).map(stage=>({id:stage.id,label:stage.label,count:items.filter(item=>item.stage===stage.id).length}))).map(stage=><Button key={stage.id} size="sm" variant={stageFilter===stage.id?'default':'outline'} onClick={()=>setStageFilter(stage.id)}>{stage.label} {stage.count}</Button>)}</div>
        </CardHeader>
        <CardContent className="max-h-[calc(100svh-12rem)] space-y-2 overflow-y-auto">
          {!visibleItems.length && <p className="py-8 text-center text-sm text-muted-foreground">这里还没有事项。新建后单独跟住一篇稿件、一次申请或一个岗位，避免和别的进度混在一起。</p>}
          {visibleItems.map(item=><button key={item.id} type="button" onClick={()=>setScheduleItemId(item.id)} className={`w-full rounded-lg border p-3 text-left transition-colors hover:border-primary/50 ${item.id===focusItem?.id?'border-primary bg-primary/5':''}`}><span className="block font-medium">{item.title}</span><span className="mt-1 block text-xs text-muted-foreground">{workbench.template.stages.find(stage=>stage.id===item.stage)?.label || item.stage}{blockedTitles(item).length?' · 有行动被前置挡住':''}{workbench.template.fields.slice(0,2).map(field=>item.fields[field.key]).filter(Boolean).length?` · ${workbench.template.fields.slice(0,2).map(field=>item.fields[field.key]).filter(Boolean).join(' · ')}`:''}</span></button>)}
        </CardContent>
      </Card>}
      <div className="min-w-0 space-y-4">
      {focusItem && <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><CardTitle className="text-base">{focusItem.title}</CardTitle><CardDescription>先看这一件还被什么挡住。改阶段只表示进度，不代表已经提交、缴费或对方确认。</CardDescription></div>
            <Button variant="outline" size="sm" onClick={()=>{setEvidence(null);setItemDraft(structuredClone(focusItem));}}>编辑资料</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {blockedTitles(focusItem).length>0 && <Alert><AlertDescription>还不能确认：{blockedTitles(focusItem).join('；')}。收到通知不会解除这个前置。</AlertDescription></Alert>}
          {focusItem.stageReceipt && <p className="text-sm text-muted-foreground">本阶段回执：{focusItem.stageReceipt}</p>}
          <div className="flex flex-wrap gap-1.5">{workbench.template.stages.map(stage=><Button key={stage.id} size="sm" variant={focusItem.stage===stage.id?'default':'outline'} disabled={busy||focusItem.stage===stage.id} onClick={()=>{const body=receiptForStage(focusItem.stage,stage.id);if(!body)return;execute(async()=>{await request(`/scenarios/workbenches/${id}/items/${focusItem.id}`,'PATCH',body);});}}>{stage.label}{stage.evidence?' · 需回执':''}</Button>)}</div>
          {focusItem.suggestedStage && focusItem.suggestedStage!==focusItem.stage && <Button variant="outline" size="sm" disabled={busy} onClick={()=>{const body=receiptForStage(focusItem.stage,focusItem.suggestedStage);if(!body)return;execute(async()=>{await request(`/scenarios/workbenches/${id}/items/${focusItem.id}`,'PATCH',body);toast.success('已采用建议阶段');});}}>采用建议：{workbench.template.stages.find(stage=>stage.id===focusItem.suggestedStage)?.label || focusItem.suggestedStage}</Button>}
        </CardContent>
      </Card>}
      <Tabs defaultValue={(showView(workbench.template,'materials') || showView(workbench.template,'actions')) ? 'work' : 'mail'} className="min-w-0">
        <TabsList>
          {showView(workbench.template,'mail') && <TabsTrigger value="mail">来信与来源</TabsTrigger>}
          {(showView(workbench.template,'materials') || showView(workbench.template,'actions')) && <TabsTrigger value="work">材料与行动</TabsTrigger>}
        </TabsList>
      {showView(workbench.template,'mail') && <TabsContent value="mail"><Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-base">邮件关联</CardTitle>
            <CardDescription>按模板关键词预览命中邮件。确认后只记录来源，不自动发信或改日历。</CardDescription>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-72">
            <Field label="关联到">
              <WorkbenchSelect value={mailItemId} onValueChange={setMailItemId} options={[{value:'new',label:'从来信新建事项'},...items.map(item=>({value:item.id,label:item.title}))]} />
            </Field>
            <Button variant="outline" size="sm" disabled={busy} onClick={()=>execute(async()=>setPreview(await request(`/scenarios/workbenches/${id}/mail-preview`)))}>预览可关联邮件</Button>
          </div>
        </CardHeader>
        {formMessage && <p role="alert" className="px-6 pb-2 text-sm text-destructive">{formMessage}</p>}
        {preview && <CardContent className="space-y-2 text-sm">
          {preview.emails.length===0 && <p className="text-muted-foreground">当前范围内没有命中邮件。可在设置里补充关键词，或同步邮箱后再预览。</p>}
          {preview.emails.map(mail=><div key={`${mail.mailboxId}:${mail.emailId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
            <span className="min-w-0"><span className="block truncate font-medium">{mail.subject || '无主题'}</span><span className="text-xs text-muted-foreground">{mail.sender}{mail.linked?' · 已关联':''}</span></span>
            <Button size="sm" variant="outline" disabled={busy||mail.linked} onClick={()=>execute(async()=>{const itemId=mailItemId==='new'?undefined:mailItemId;await request(`/scenarios/workbenches/${id}/sources`,'POST',{...mail,itemId});setPreview(await request(`/scenarios/workbenches/${id}/mail-preview`));toast.success(itemId?'已关联到所选事项，未发信':'已从来信建立事项，未发信');})}>{mail.linked?'已关联':'确认关联'}</Button>
          </div>)}
        </CardContent>}
        <CardContent className="space-y-2 border-t text-sm">
          <p className="text-muted-foreground">官网、报名系统、短信或群通知不在邮箱里。粘贴原文只作为来源，不会标成已提交。</p>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="来源"><WorkbenchSelect value={externalChannel} onValueChange={setExternalChannel} placeholder="选择来源" options={(workbench.template.externalSources||[]).map(channel=>({value:channel,label:channel}))}/></Field>
            <Field label="关联事项"><WorkbenchSelect value={scheduleItemId} onValueChange={setScheduleItemId} placeholder="先新建事项" options={items.map(item=>({value:item.id,label:item.title}))}/></Field>
          </div>
          <Field label="原文"><Textarea value={externalNote} onChange={e=>setExternalNote(e.target.value)} placeholder="粘贴官网、系统或群里的通知原文"/></Field>
          <Button variant="outline" disabled={busy||!scheduleItemId||!externalChannel||!externalNote.trim()} onClick={()=>execute(async()=>{await request(`/scenarios/workbenches/${id}/items/${scheduleItemId}/external-sources`,'POST',{channel:externalChannel,note:externalNote});setExternalNote('');setFormMessage('');toast.success('已登记外部来源，尚未提交或发送');})}>登记外部来源</Button>
          <div className="space-y-1 pt-2">
            <p className="font-medium">来源记录</p>
            {items.filter(item=>!focusItem||item.id===focusItem.id).every(item=>!(item.sources||[]).length) && <p className="text-muted-foreground">还没有关联邮件或外部来源。</p>}
            {items.filter(item=>!focusItem||item.id===focusItem.id).flatMap(item=>(item.sources||[]).map((source,index)=><div key={`${item.id}-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">{item.title} · {source.kind==='external'?`${source.channel}：${String(source.note||'').slice(0,80)}`:(source.subject||'邮件')}{source.emailId && <Button type="button" size="sm" variant="outline" onClick={()=>openEmail(source.emailId, source.mailboxId)}>查看原文</Button>}</div>))}
          </div>
        </CardContent>
      </Card></TabsContent>}
      {(showView(workbench.template,'materials') || showView(workbench.template,'actions')) && <TabsContent value="work"><Card>
        <CardHeader>
          <CardTitle className="text-base">材料与行动</CardTitle>
          <CardDescription>只显示当前事项。材料版本和行动分开。被前置挡住时不能确认；收到邮件也不等于已经提交。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {showView(workbench.template,'materials') && (data.materials || []).filter(row=>row.workbenchId===id && (!focusItem || row.itemId===focusItem.id)).map(row=><div key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"><span>{row.label} v{row.version} · {stateLabel[row.state] || row.state}{row.receipt ? ` · ${row.receipt}` : ''}</span>
<span className="flex flex-wrap gap-2">
{row.state==='missing' && <Button size="sm" variant="outline" disabled={busy} onClick={()=>execute(async()=>{const note=window.prompt('材料已在本地备好。这一步不是外部提交。');if(!note)return;await request(`/scenarios/workbenches/${id}/receipts`,'POST',{materialId:row.id,note,status:'prepared'});})}>登记已准备</Button>}
{['missing','prepared'].includes(row.state) && <Button size="sm" variant="outline" disabled={busy} onClick={()=>execute(async()=>{const note=window.prompt('材料已提交的回执，不代表对方已确认');if(!note)return;await request(`/scenarios/workbenches/${id}/receipts`,'POST',{materialId:row.id,note,status:'submitted'});})}>登记材料已提交</Button>}
</span></div>)}
          {showView(workbench.template,'actions') && <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{workbench.template.fields.some(field=>field.type==='timezone')?'登记对方时区的面谈（确认后才进日历）':'登记面谈、报告时间或改期'}</summary><div className="mt-3 grid max-w-xl gap-2 md:grid-cols-2">
            <Field label="关联事项"><WorkbenchSelect value={scheduleItemId} onValueChange={setScheduleItemId} placeholder="先新建事项" options={items.map(item=>({value:item.id,label:item.title}))}/></Field>
            <Field label="安排标题"><Input value={slot.title} onChange={e=>setSlot({...slot,title:e.target.value})}/></Field>
            <Field label="对方时区"><Input value={slot.timeZone} placeholder="Europe/London" onChange={e=>setSlot({...slot,timeZone:e.target.value})}/></Field>
            <Field label="对方开始"><Input value={slot.localStart} placeholder="2026-10-25T01:30" onChange={e=>setSlot({...slot,localStart:e.target.value})}/></Field>
            <Field label="对方结束"><Input value={slot.localEnd} placeholder="2026-10-25T01:45" onChange={e=>setSlot({...slot,localEnd:e.target.value})}/></Field>
            <Field label="开始偏移（夏令时回拨时填写）"><Input value={slot.startOffsetMin} onChange={e=>setSlot({...slot,startOffsetMin:e.target.value})}/></Field>
            <Field label="结束偏移"><Input value={slot.endOffsetMin} onChange={e=>setSlot({...slot,endOffsetMin:e.target.value})}/></Field>
            <label className="flex items-center gap-2 text-sm md:col-span-2"><Checkbox checked={slot.reschedule} onCheckedChange={checked=>setSlot({...slot,reschedule:checked===true})}/>这是改期：保留原安排并关联新时间，确认后才写入日历</label>
            <Button className="md:col-span-2" variant="outline" disabled={busy||!scheduleItemId} onClick={()=>execute(async()=>{
              const body={...slot,startOffsetMin:slot.startOffsetMin===''?undefined:Number(slot.startOffsetMin),endOffsetMin:slot.endOffsetMin===''?undefined:Number(slot.endOffsetMin)};
              const result=await request(`/scenarios/workbenches/${id}/items/${scheduleItemId}/schedule`,'POST',body);
              if(result.ambiguous) toast.message('该时刻在夏令时回拨中出现两次，请填写偏移分钟后重试');
              else toast.success(`已登记到所选事项，北京时间 ${result.action.schedule.beijingStart}`);
            })}>登记安排（尚未进日历）</Button>
          </div></details>}
          {showView(workbench.template,'actions') && workbench.template.capabilities?.includes('drafts.write') && <div className="grid max-w-xl gap-2 rounded-md border p-3">
            <Field label="回复草稿"><Textarea value={replyBody} onChange={e=>setReplyBody(e.target.value)} placeholder="写给对方的草稿。保存后只写入关联邮件，不会发送。"/></Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy||!scheduleItemId||!replyBody.trim()} onClick={()=>execute(async()=>{await request(`/scenarios/workbenches/${id}/items/${scheduleItemId}/reply-draft`,'POST',{body:replyBody});toast.success('已保存回复草稿，尚未发送');})}>保存回复草稿（不发送）</Button>
              {workbench.template.capabilities?.includes('mail.send') && <Button variant="outline" disabled={busy||!scheduleItemId||!replyBody.trim()} onClick={()=>execute(async()=>{
                const item = items.find((row) => row.id === scheduleItemId);
                const suggested = String(item?.fields?.contact || '').trim();
                const to = suggested || window.prompt('收件人邮箱。放入审核后仍不会发送。');
                if (!to?.trim()) return;
                const subject = window.prompt('邮件主题', item?.title || '回复');
                if (!subject?.trim()) return;
                await request('/assistant/drafts','POST',{ mailboxId: workbench.mailboxIds[0], to: to.trim(), subject: subject.trim(), body: replyBody });
                toast.success('已放入小 D 审核列表。打开小 D 核对后才会发送。');
              })}>放入小 D 审核（不发送）</Button>}
            </div>
          </div>}
          {showView(workbench.template,'actions') && (data.actions || []).filter(row=>row.workbenchId===id && (!focusItem || row.itemId===focusItem.id)).map(row=><div key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
            <span>{items.find(item=>item.id===row.itemId)?.title || '未命名事项'} · {row.title} · {stateLabel[row.state] || row.state}{row.localTaskStatus==='done' ? ' · 待办已完成' : ''}{row.receipt ? ` · ${row.receipt}` : ''}{row.kind==='calendar' && row.localEventStatus==='removed' ? ' · 日程已从日历删除' : ''}{row.kind==='calendar' && row.schedule ? ` · 北京 ${row.schedule.beijingStart}` : ''}{row.kind!=='calendar' && row.dueAt ? ` · 截止 ${fullDateTime(row.dueAt)}` : ''}{row.kind==='draft' && row.body ? ` · ${String(row.body).slice(0, 80)}` : ''}{openPrerequisiteTitles(data.actions, row).length ? ` · 待前置：${openPrerequisiteTitles(data.actions, row).join('、')}` : (row.dependsOn?.length ? ' · 前置已完成' : '')}</span>
            <span className="flex flex-wrap gap-2">
              {row.title==='在招聘引擎中筛选候选人' && <Button size="sm" variant="outline" disabled={busy} onClick={()=>execute(async()=>{const evidence=await request(`/scenarios/workbenches/${id}/items/${row.itemId}/evidence`);const candidate=(evidence.attachments||[]).find(file=>file.candidateId)?.candidateId;const next=new URLSearchParams(params);if(candidate)next.set('candidate',candidate);else next.delete('candidate');setParams(next,{replace:true});document.getElementById('recruitment-engine')?.scrollIntoView({behavior:'smooth',block:'start'});toast.message(candidate?'已打开关联候选人，尚未发邀约':'已打开招聘引擎，尚未发邀约');})}>打开招聘引擎</Button>}
              {row.title==='核对发票字段并准备报销' && <Button size="sm" variant="outline" onClick={()=>document.getElementById('invoice-assistant')?.scrollIntoView({behavior:'smooth',block:'start'})}>打开发票助手</Button>}
              {row.kind==='calendar' ? <Button size="sm" variant="outline" disabled={busy||row.state!=='pending'||openPrerequisiteTitles(data.actions, row).length>0} onClick={()=>execute(async()=>{
                const first=await request(`/scenarios/workbenches/${id}/actions/${row.id}/schedule`,'POST',{});
                if(first.shared){toast.message('这封邮件的相同时刻已在日历中，未再次写入');return;}
                if(first.written){toast.success('已写入日历');return;}
                if(!first.conflicts?.length) return;
                const lines=first.conflicts.slice(0,5).map(item=>`${item.title||'未命名'}${item.workbenchName?`（${item.workbenchName}）`:''}`).join('\n');
                if(!window.confirm(`与 ${first.conflicts.length} 个已有安排重叠，仍写入日历？\n${lines}`)) return;
                await request(`/scenarios/workbenches/${id}/actions/${row.id}/schedule`,'POST',{acknowledgeConflicts:true});
                toast.success('已写入日历，并保留冲突记录');
              })}>确认写入日历</Button> : row.kind==='draft' ? null : <Button size="sm" variant="outline" disabled={busy||row.state!=='pending'||openPrerequisiteTitles(data.actions, row).length>0} onClick={()=>execute(async()=>{const result=await request(`/scenarios/workbenches/${id}/actions/${row.id}/confirm`,'POST',{});toast.success(result.shared?'这封邮件的相同待办已存在，未再次创建':'已写入待办');})}>确认写入待办</Button>}
              <Button size="sm" variant="outline" disabled={busy||row.state!=='prepared'} onClick={()=>execute(async()=>{const note=window.prompt('已提交到外部系统的回执，不代表对方已确认');if(!note)return;await request(`/scenarios/workbenches/${id}/receipts`,'POST',{actionId:row.id,note,status:'submitted'});})}>登记已提交</Button>
              <Button size="sm" variant="outline" disabled={busy||!['prepared','submitted','sent'].includes(row.state)} onClick={()=>execute(async()=>{const note=window.prompt('对方确认的原文或回执');if(!note)return;await request(`/scenarios/workbenches/${id}/receipts`,'POST',{actionId:row.id,note,status:'confirmed'});})}>登记对方确认</Button>
              {row.kind==='draft' && row.emailId && <Button size="sm" variant="outline" type="button" onClick={()=>openEmail(row.emailId, row.mailboxId)}>打开原邮件</Button>}
              {row.kind==='draft' && <Button size="sm" variant="outline" disabled={busy||row.state!=='prepared'} onClick={()=>execute(async()=>{const note=window.prompt('你已自行发出的说明。这里不会代发邮件。');if(!note)return;await request(`/scenarios/workbenches/${id}/receipts`,'POST',{actionId:row.id,note,status:'sent'});})}>登记已发送</Button>}
            </span>
          </div>)}
          {showView(workbench.template,'actions') && !(data.actions || []).some(row=>row.workbenchId===id && (!focusItem || row.itemId===focusItem.id)) && <p className="text-muted-foreground">在下方场景助手里按规则生成。确认前不会写入待办，收到邮件也不等于已经提交。</p>}
        </CardContent>
      </Card></TabsContent>}
      </Tabs>
      <ScenarioAssistant template={workbench.template} itemTitle={focusItem?.title || ''} busy={busy} onPlan={()=>execute(async()=>{if(!scheduleItemId)return;const plan=await request(`/scenarios/workbenches/${id}/items/${scheduleItemId}/plan`,'POST',{});toast.message(plan.interpretation?.warning || '已按规则生成待确认行动，尚未写入待办');})} />
      </div>
      </div>
      <Card><CardHeader><CardTitle className="text-base">近期变化</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">{data.history.filter(h=>h.workbenchId===id).slice(-8).reverse().map(h=><div key={h.id} className="flex flex-wrap justify-between gap-2 border-b pb-2"><span>{typeof h.detail==='string'?h.detail:'更新事项，已保留修改前后记录'}</span><time className="text-xs text-muted-foreground">{new Date(h.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</time></div>)}</CardContent></Card>
    </>}
    <Dialog open={Boolean(chosen)} onOpenChange={open=>!open&&setChosen(null)}><DialogContent><DialogHeader><DialogTitle>添加{chosen?.name}工作台</DialogTitle><DialogDescription>模板只定义处理方式，邮件数据保留在原邮箱中。</DialogDescription></DialogHeader><Field label="工作台名称"><Input value={title} onChange={e=>setTitle(e.target.value)}/></Field><div className="space-y-2"><Label>关联邮箱</Label>{data.mailboxes.map(m=><label key={m.id} className="flex items-center gap-2 text-sm"><Checkbox checked={mailboxIds.includes(m.id)} onCheckedChange={checked=>setMailboxIds(checked?[...mailboxIds,m.id]:mailboxIds.filter(v=>v!==m.id))}/>{m.email || '尚未配置的邮箱'}</label>)}</div><p className="text-xs text-muted-foreground">能力：{chosen?.capabilities.join('、')}。外部发送仍需要确认。</p><Button disabled={busy||!title.trim()||!mailboxIds.length} onClick={create}>创建工作台</Button></DialogContent></Dialog>
    <Dialog open={Boolean(itemDraft)} onOpenChange={open=>{if(!open){setItemDraft(null);setEvidence(null);}}}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>{itemDraft?.id?'编辑事项':'新建事项'}</DialogTitle><DialogDescription>阶段表示业务进度，不代表待办或外部操作已经完成。</DialogDescription></DialogHeader>{itemDraft&&<><Field label="事项名称"><Input value={itemDraft.title} onChange={e=>setItemDraft({...itemDraft,title:e.target.value})}/></Field><Field label="阶段"><WorkbenchSelect value={itemDraft.stage} onValueChange={stage=>setItemDraft({...itemDraft,stage})} options={workbench.template.stages.map(s=>({value:s.id,label:s.label}))}/></Field>{itemDraft.id && itemDraft.suggestedStage && itemDraft.suggestedStage!==itemDraft.stage && <Button type="button" variant="outline" disabled={busy} onClick={()=>{const body=receiptForStage(items.find(row=>row.id===itemDraft.id)?.stage,itemDraft.suggestedStage);if(!body)return;execute(async()=>{const saved=await request(`/scenarios/workbenches/${id}/items/${itemDraft.id}`,'PATCH',body);setItemDraft(saved);toast.success('已采用建议阶段');});}}>采用建议阶段：{workbench.template.stages.find(s=>s.id===itemDraft.suggestedStage)?.label || itemDraft.suggestedStage}</Button>}{workbench.template.fields.map(f=><Field key={f.key} label={`${f.label}${f.required?' *':''}`}><Input type={['email','url','number','date'].includes(f.type)?f.type:'text'} placeholder={f.type==='timezone'?'例如 Europe/London':''} value={itemDraft.fields[f.key]??''} onChange={e=>setItemDraft({...itemDraft,fields:{...itemDraft.fields,[f.key]:e.target.value}})}/></Field>)}<Field label="备注"><Textarea value={itemDraft.notes} onChange={e=>setItemDraft({...itemDraft,notes:e.target.value})}/></Field><div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={saveItem}>保存事项</Button>{itemDraft.id && <Button variant="outline" disabled={busy} onClick={()=>execute(async()=>{await request(`/scenarios/workbenches/${id}/items/${itemDraft.id}`,'PATCH',itemDraft);const plan=await request(`/scenarios/workbenches/${id}/items/${itemDraft.id}/plan`,'POST',{});const listed=await request('/scenarios');const fresh=listed.items.find(row=>row.id===itemDraft.id);if(fresh)setItemDraft(structuredClone(fresh));toast.message(plan.interpretation?.warning || '已按规则生成建议');})}>按规则生成</Button>}
{itemDraft.id && <Button variant="outline" disabled={busy} onClick={()=>execute(async()=>{await request(`/scenarios/workbenches/${id}/items/${itemDraft.id}`,'PATCH',itemDraft);const plan=await request(`/scenarios/workbenches/${id}/items/${itemDraft.id}/plan`,'POST',{useModel:true});const listed=await request('/scenarios');const fresh=listed.items.find(row=>row.id===itemDraft.id);if(fresh)setItemDraft(structuredClone(fresh));toast.message(plan.interpretation?.warning || '已结合模型生成建议，尚未改阶段或发信');})}>用模型分析</Button>}
{(workbench.template.capabilities||[]).some(cap=>['attachments.read','knowledge.search'].includes(cap)) && itemDraft.id && <Button variant="outline" disabled={busy} onClick={()=>execute(async()=>{setEvidence(await request(`/scenarios/workbenches/${id}/items/${itemDraft.id}/evidence`));})}>查看附件与引用</Button>}</div>
{evidence && <div className="space-y-2 text-sm"><p className="font-medium">已有附件与知识引用</p>{!evidence.attachments.length && !evidence.citations.length && <p className="text-muted-foreground">没有可展示的附件或已入库片段。这里不重新识别文件，也不调用向量模型。</p>}{evidence.attachments.map((file,index)=><p key={`${file.emailId}-${index}`} className="flex flex-wrap items-center gap-2">{file.filename}{file.source==='recruitment'?' · 招聘附件':''}<Button type="button" size="sm" variant="outline" onClick={()=>openEmail(file.emailId, file.mailboxId)}>查看原文</Button></p>)}{evidence.citations.map(row=><p key={row.chunkId} className="text-muted-foreground">{row.filename ? `${row.filename}：` : ''}{row.quote}</p>)}{evidence.traces.map(row=><p key={row.traceId} className="flex flex-wrap items-center gap-2">{row.source==='recruitment'?'招聘执行记录':'执行记录'} · {row.subject || '邮件'}{row.tools?.length ? ` · ${row.tools.join('、')}` : ''}{row.traceId && <Button asChild size="sm" variant="outline"><Link to={`/app/traces?trace=${encodeURIComponent(row.traceId)}${row.mailboxId ? `&mailbox=${encodeURIComponent(row.mailboxId)}` : ''}`}>打开证据链</Link></Button>}</p>)}</div>}</>}</DialogContent></Dialog>
    <Dialog open={Boolean(config)} onOpenChange={open=>!open&&setConfig(null)}><DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto"><DialogHeader><DialogTitle>工作台配置与模板</DialogTitle><DialogDescription>用表单改字段、阶段、信号、提示词和页面块。保存只影响这个工作台。已有事项使用的阶段不能直接删除。模板里的邮件关键词始终参与预览；下面的额外关键词和发件人只扩大这个工作台的处理范围。</DialogDescription></DialogHeader>{config&&<><Field label="工作台名称"><Input value={config.name} onChange={e=>setConfig({...config,name:e.target.value})}/></Field><Field label="额外关键词（处理范围，逗号分隔）"><Input value={config.keywords} onChange={e=>setConfig({...config,keywords:e.target.value})}/></Field><Field label="发件人范围（逗号分隔）"><Input value={config.senders} onChange={e=>setConfig({...config,senders:e.target.value})}/></Field>{config.raw ? <Field label="模板 JSON"><Textarea className="min-h-64 font-mono text-xs" value={typeof config.template==='string'?config.template:JSON.stringify(config.template,null,2)} onChange={e=>setConfig({...config,template:e.target.value})}/></Field> : <TemplateEditor template={config.template} onChange={template=>setConfig({...config,template})}/>}<div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={()=>execute(async()=>{const template=prepareTemplate(typeof config.template==='string'?JSON.parse(config.template):config.template);await request(`/scenarios/workbenches/${id}`,'PATCH',{name:config.name,template,scope:{keywords:config.keywords.split(/[,，]/).map(s=>s.trim()).filter(Boolean),senders:config.senders.split(/[,，]/).map(s=>s.trim()).filter(Boolean)}});setConfig(null);toast.success('已保存模板配置');})}>保存配置</Button><Button variant="outline" onClick={()=>setConfig({...config,raw:!config.raw,template:config.raw?JSON.parse(config.template):JSON.stringify(config.template,null,2)})}>{config.raw?'返回表单':'高级 JSON'}</Button><Button variant="outline" disabled={busy} onClick={()=>execute(async()=>download(await request(`/scenarios/workbenches/${id}/template`),`${workbench.template.id}.json`))}><Download className="size-4"/>导出模板</Button><Button variant="outline" disabled={busy||workbench.template.id==='recruitment'} onClick={()=>execute(async()=>{const pack=await request(`/scenarios/workbenches/${id}/template`);await request('/scenarios/templates/import','POST',pack);toast.success('已保存为个人模板');})}>保存为个人模板</Button></div></>}</DialogContent></Dialog>
    <Dialog open={Boolean(composer)} onOpenChange={open=>!open&&setComposer(null)}><DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto"><DialogHeader><DialogTitle>制作邮件处理模板</DialogTitle><DialogDescription>保存后的个人模板会打开同一套工作台：进度、来信、材料行动和场景助手。助手内容来自你填写的信号、材料和样例。不能附带代码、密钥或真实邮件。社区审核尚未开放。</DialogDescription></DialogHeader>{composer&&<><TemplateEditor template={composer} onChange={setComposer}/><Button disabled={busy||!composer.name.trim()} onClick={()=>execute(async()=>{const draft=await request('/scenarios/templates/draft','POST',prepareTemplate(composer));if(draft.status!=='draft') throw new Error(draft.message||'草稿未生成');await request('/scenarios/templates/import','POST',draft.pack);setComposer(null);toast.success('已保存个人模板，可在下方添加工作台');})}>保存为个人模板</Button></>}</DialogContent></Dialog>
  </div>;
}
