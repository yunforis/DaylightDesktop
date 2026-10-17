import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runWithRequestContext } from './request-context.js';
fs.mkdirSync('work',{recursive:true});
const directory=fs.mkdtempSync(path.resolve('work/scenarios-test-'));
process.env.DAYLIGHT_DATA_DIR=directory;
fs.writeFileSync(path.join(directory,'infra.json'),JSON.stringify({postgres:{enabled:false},redis:{enabled:false},mq:{enabled:false}}));
fs.writeFileSync(path.join(directory,'settings.json'),JSON.stringify({mailboxes:[{id:'a-mail',ownerUserId:'a',email:'a@example.invalid'},{id:'b-mail',ownerUserId:'b',email:'b@example.invalid'}],userPrefs:{a:{activeMailboxId:'a-mail'},b:{activeMailboxId:'b-mail'}}}));
const service=await import('./scenarios/service.js');
const { readScenarioData, mutateScenarioData }=await import('./scenarios/repository.js');
const { OFFICIAL_TEMPLATES,exportTemplate }=await import('../shared/scenario-templates.js');
const { emailReference }=await import('./traces.js');
const asUser=(id,fn)=>runWithRequestContext({userId:id,user:{id,email:`${id}@example.invalid`}},fn);
after(()=>fs.rmSync(directory,{recursive:true,force:true}));

test('模型等待期间事项变更拒绝旧分析且不写入行动', async () => {
  await asUser('a', async () => {
    const workbench = await service.createWorkbench({ templateId: 'graduate-admission', name: '并发分析', mailboxIds: ['a-mail'] });
    const item = await service.createItem(workbench.id, { title: '原申请', fields: { institution: '合成学校' } });
    await assert.rejects(() => service.proposeItemPlan(workbench.id, item.id, {
      useModel: true,
      callModel: async () => {
        await service.updateItem(workbench.id, item.id, { title: '更新后的申请' });
        return { tasks: ['旧建议'], suggestedStage: null };
      },
    }), error => error.status === 409);
    const data = await readScenarioData();
    assert.equal(data.items.find(row => row.id === item.id).title, '更新后的申请');
    assert.equal(data.actions.filter(row => row.itemId === item.id).length, 0);
  });
});

test('五个官方样例只生成待确认动作，不写入日历或发信',()=>{
  const receivedAt='2026-10-13T01:00:00.000Z';
  const byId=id=>OFFICIAL_TEMPLATES.find(template=>template.id===id);
  const graduate=service.replayTemplateSample(byId('graduate-admission'),byId('graduate-admission').samples[0].input,receivedAt);
  assert.equal(graduate.written,false);
  assert.equal(graduate.sent,false);
  assert.equal(graduate.modelCalled,false);
  assert.equal(graduate.actions.filter(action=>action.kind==='calendar').length,1);
  assert.ok(graduate.actions.filter(action=>action.kind==='task').length>=2);
  const honor=service.replayTemplateSample(byId('graduate-admission'),'恭喜成为优秀营员，欢迎报考。',receivedAt);
  assert.notEqual(honor.interpretation.suggestedStage,'result');
  assert.match(honor.interpretation.warning,/不是正式录取/);
  assert.ok(honor.actions.some(action=>action.title==='核对是否为正式录取'&&action.state==='pending'));
  const blocked=service.mergeAnalysis(byId('graduate-admission'),honor.interpretation,{suggestedStage:'result',tasks:['记为录取'],warning:'模型认为已录取'});
  assert.notEqual(blocked.suggestedStage,'result');
  assert.equal(blocked.tasks.includes('核对是否为正式录取'),true);
  const research=service.replayTemplateSample(byId('research-applications'),byId('research-applications').samples[0].input,receivedAt);
  assert.equal(research.interpretation.suggestedStage,'discussion');
  assert.equal(research.actions.some(action=>action.kind==='calendar'),false);
  const job=service.replayTemplateSample(byId('job-applications'),byId('job-applications').samples[0].input,receivedAt);
  assert.ok(job.actions.some(action=>action.title==='完成测评或笔试'&&action.state==='pending'));
  assert.equal(job.actions.some(action=>action.kind==='calendar'),false);
  assert.equal(job.interpretation.suggestedStage,'assessment');
  const supplement=service.replayTemplateSample(byId('job-applications'),'请补充成绩单。',receivedAt);
  assert.equal(supplement.interpretation.suggestedStage,null);
  assert.match(supplement.interpretation.warning,/不代表进入下一轮/);
  assert.ok(supplement.actions.some(action=>action.title==='补充材料'&&action.state==='pending'));
  const notAdvanced=service.mergeAnalysis(byId('job-applications'),supplement.interpretation,{suggestedStage:'interview',tasks:['安排面试'],warning:''});
  assert.equal(notAdvanced.suggestedStage,null);
  assert.equal(notAdvanced.tasks.includes('补充材料'),true);
  const paper=service.replayTemplateSample(byId('research-publications'),byId('research-publications').samples[0].input,receivedAt);
  assert.deepEqual(paper.interpretation.dependsOn,['共同作者确认']);
  assert.ok(paper.actions.some(action=>action.title==='提交终稿'));
  assert.ok(paper.actions.some(action=>action.title==='共同作者确认'));
  const recruitment=service.replayTemplateSample(byId('recruitment'),byId('recruitment').samples[0].input,receivedAt);
  assert.equal(recruitment.sent,false);
  assert.equal(recruitment.interpretation.suggestedStage,'screening');
  assert.ok(recruitment.actions.some(action=>action.title==='在招聘引擎中筛选候选人'&&action.state==='pending'&&action.kind==='task'));
  assert.equal(recruitment.actions.some(action=>action.kind==='calendar'),false);
  const invoice=service.replayTemplateSample(byId('invoices'),byId('invoices').samples[0].input,receivedAt);
  assert.equal(invoice.sent,false);
  assert.equal(invoice.interpretation.suggestedStage,'review');
  assert.ok(invoice.actions.some(action=>action.title==='核对发票字段并准备报销'&&action.state==='pending'&&action.kind==='task'));
  assert.equal(invoice.actions.some(action=>action.kind==='calendar'),false);
  const pack=service.replayTemplatePack({...byId('job-applications'),receivedAt});
  assert.equal(pack.modelCalled,false);
  assert.equal(pack.samples.length,1);
});

test('工作台允许同模板多实例、隔离邮箱与用户、保留模板快照',async()=>{
  await assert.rejects(()=>service.listScenarios(),/请先登录/);
  await asUser('a',async()=>{
    await assert.rejects(()=>service.createWorkbench({templateId:'graduate-admission',name:'越权',mailboxIds:['b-mail']}),/属于当前用户/);
    const one=await service.createWorkbench({templateId:'graduate-admission',name:'夏令营',mailboxIds:['a-mail']});
    const two=await service.createWorkbench({templateId:'graduate-admission',name:'预推免',mailboxIds:['a-mail']});
    assert.notEqual(one.id,two.id);
    const item=await service.createItem(one.id,{title:'A 校申请',fields:{institution:'A 校'}});
    await assert.rejects(()=>service.updateItem(one.id,item.id,{stage:'applied'}),/回执/);
    await service.updateItem(one.id,item.id,{stage:'applied',receipt:'报名系统已显示已提交'});
    const data=await service.listScenarios();
    assert.equal(data.items.find(i=>i.id===item.id).stage,'applied');
    assert.equal(data.items.find(i=>i.id===item.id).stageReceipt,'报名系统已显示已提交');
    assert.equal(data.history.filter(h=>h.itemId===item.id).length,2);
    await assert.rejects(()=>service.updateWorkbench(one.id,{template:{...one.template,stages:[{id:'new',label:'新阶段'}]}}),/先移动事项/);
    await asUser('b',async()=>{
      assert.equal((await service.listScenarios()).workbenches.length,0);
      await assert.rejects(()=>service.updateWorkbench(one.id,{name:'盗改'}),/不存在/);
      await assert.rejects(()=>service.updateItem(one.id,item.id,{stage:'closed'}),/不存在/);
    });
    const pack=await service.exportWorkbenchTemplate(one.id);
    assert.equal(JSON.stringify(pack).includes('A 校'),false);
    const custom=await service.savePersonalTemplate(pack);
    assert.match(custom.id,/^custom-/);
    assert.equal((await service.listScenarios()).templates.length,1);
  });
});

test('各场景可建立事项；编辑历史保留；不合法字段和能力不落盘',async()=>{
  await asUser('b',async()=>{
    for(const t of OFFICIAL_TEMPLATES) {
      const w=await service.createWorkbench({templateId:t.id,mailboxIds:['b-mail']});
      const fields=Object.fromEntries(t.fields.filter(f=>f.required).map(f=>[f.key,'合成样例']));
      const item=await service.createItem(w.id,{title:`${t.name}测试`,fields});
      assert.equal(item.stage,t.stages[0].id);
      await assert.rejects(()=>service.updateItem(w.id,item.id,{stage:'invented'}),/阶段无效/);
      assert.equal((await service.listScenarios()).items.find(i=>i.id===item.id).stage,t.stages[0].id);
    }
    const w=(await service.listScenarios()).workbenches.find(w=>w.template.id==='research-applications');
    await assert.rejects(()=>service.createItem(w.id,{title:'坏时区',fields:{institution:'A',timeZone:'invented'}}),/IANA/);
    await assert.rejects(()=>service.savePersonalTemplate({...exportTemplate(OFFICIAL_TEMPLATES[0]),template:{...OFFICIAL_TEMPLATES[0],capabilities:['shell']}}),/不支持/);
  });
});

test('邮件预览只读，确认关联不重复副作用',async()=>{
  const folder=path.join(directory,'mailboxes','a-mail');
  fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(folder,'calendar.json'),JSON.stringify({events:[],tasks:[],emails:[{id:'mail-camp',subject:'夏令营入营确认',sender:'school@example.invalid',body:'请于周五前确认'}]}));
  await asUser('a',async()=>{
    const wb=await service.createWorkbench({templateId:'graduate-admission',name:'预览台',mailboxIds:['a-mail']});
    const preview=await service.previewWorkbenchMail(wb.id);
    assert.equal(preview.emails.some(e=>e.emailId==='mail-camp' && !e.linked),true);
    const first=await service.linkMailSource(wb.id,{mailboxId:'a-mail',emailId:'mail-camp'});
    const second=await service.linkMailSource(wb.id,{mailboxId:'a-mail',emailId:'mail-camp',itemId:first.item.id});
    assert.equal(second.duplicate,true);
    assert.equal(second.item.sources.length,1);
    const store=JSON.parse(fs.readFileSync(path.join(folder,'calendar.json'),'utf8'));
    assert.equal(store.events.length,0);
    assert.equal(store.tasks.length,0);
  });
});

test('礼貌回复不当录取；终稿依赖作者确认；回执才算提交',async()=>{
  const folder=path.join(directory,'mailboxes','b-mail');
  fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(folder,'calendar.json'),JSON.stringify({events:[],tasks:[],emails:[{id:'phd',subject:'Re: proposal',body:'Happy to discuss your proposal. Funding is not confirmed yet.'},{id:'paper',subject:'camera-ready',body:'请所有作者确认后，于周五前提交终稿。'}]}));
  await asUser('b',async()=>{
    const research=await service.createWorkbench({templateId:'research-applications',name:'申博',mailboxIds:['b-mail']});
    const talk=await service.createItem(research.id,{title:'导师',fields:{institution:'U'}});
    await service.linkMailSource(research.id,{mailboxId:'b-mail',emailId:'phd',itemId:talk.id});
    const plan=await service.proposeItemPlan(research.id,talk.id);
    assert.equal(plan.interpretation.suggestedStage,'discussion');
    const storedTalk=(await service.listScenarios()).items.find(row=>row.id===talk.id);
    assert.notEqual(storedTalk.stage,'discussion');
    assert.equal(storedTalk.suggestedStage,'discussion');
    const adopted=await service.updateItem(research.id,talk.id,{stage:'discussion'});
    assert.equal(adopted.stage,'discussion');
    assert.equal(adopted.suggestedStage,null);
    const follow=plan.actions.find(action=>action.title==='整理下一轮材料或跟进');
    assert.ok(follow?.dueAt);
    assert.ok(Date.parse(follow.dueAt)-Date.now()>6*24*60*60*1000);
    assert.match(plan.interpretation.warning,/愿意交流/);
    assert.match(plan.interpretation.warning,/名额未定/);
    assert.match(plan.interpretation.warning,/不能标记录取/);
    assert.ok(plan.actions.some(action=>action.title==='记录名额未定并跟进'));
    assert.notEqual(talk.stage,'result');
    const draft=await service.saveReplyDraft(research.id,talk.id,{body:'感谢愿意交流。我先补充研究计划，不将此信视为录取。'});
    assert.equal(draft.sent,false);
    assert.equal(draft.action.state,'prepared');
    const mailed=JSON.parse(fs.readFileSync(path.join(folder,'calendar.json'),'utf8'));
    assert.equal(mailed.emails.find(email=>email.id==='phd').userDraft,draft.action.body);
    const sent=await service.recordReceipt(research.id,{actionId:draft.action.id,status:'sent',note:'我已在邮箱发出'});
    assert.equal(sent.action.state,'sent');
    await assert.rejects(()=>service.saveReplyDraft(research.id,talk.id,{body:'再改一版'}),/不能在此覆盖/);
    const paperWb=await service.createWorkbench({templateId:'research-publications',name:'投稿',mailboxIds:['b-mail']});
    const paper=await service.createItem(paperWb.id,{title:'稿件',fields:{venue:'会议'}});
    await service.linkMailSource(paperWb.id,{mailboxId:'b-mail',emailId:'paper',itemId:paper.id});
    const paperPlan=await service.proposeItemPlan(paperWb.id,paper.id);
    const gate=paperPlan.actions.find(a=>a.title==='共同作者确认') || (await service.listScenarios()).actions.find(a=>a.title==='共同作者确认');
    const submit=(await service.listScenarios()).actions.find(a=>a.itemId===paper.id && a.title==='提交终稿');
    assert.ok(gate && submit);
    const friday=(await service.listScenarios()).actions.find(a=>a.itemId===paper.id && a.title==='周五前提交终稿');
    assert.ok(friday);
    assert.deepEqual(friday.dependsOn,[gate.id]);
    await assert.rejects(()=>service.confirmAction(paperWb.id,friday.id),/前置行动/);
    await assert.rejects(()=>service.confirmAction(paperWb.id,submit.id),/前置行动/);
    const prepared=await service.confirmAction(paperWb.id,gate.id);
    assert.equal(prepared.action.state,'prepared');
    const again=await service.confirmAction(paperWb.id,gate.id);
    assert.equal(again.duplicate,true);
    const tasks=JSON.parse(fs.readFileSync(path.join(folder,'calendar.json'),'utf8')).tasks;
    assert.equal(tasks.filter(t=>t.scenarioActionId===gate.id).length,1);
    assert.equal(tasks.find(t=>t.scenarioActionId===gate.id).sources[0].emailId,'paper');
    assert.match(tasks.find(t=>t.scenarioActionId===gate.id).description,/尚未对外提交/);
    await assert.rejects(()=>service.recordReceipt(paperWb.id,{}),/回执/);
    const receipt=await service.recordReceipt(paperWb.id,{actionId:gate.id,note:'作者邮件确认'});
    assert.equal(receipt.action.state,'submitted');
  });
});

test('后续通知覆盖材料版本；跨时区安排与跨工作台冲突',async()=>{
  const folder=path.join(directory,'mailboxes','a-mail');
  fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,'calendar.json');
  const store=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{events:[],tasks:[],emails:[]};
  store.emails=(store.emails||[]).filter(e=>e.id!=='revoke');
  store.emails.push({id:'need-score',subject:'夏令营通知',body:'请周二12点前确认参营，并提交成绩单。',receivedAt:'2026-10-13T01:00:00.000Z'});
  store.emails.push({id:'revoke',subject:'夏令营通知',body:'原成绩单要求作废，无需再提交旧版。'});
  store.events=store.events||[];
  store.tasks=store.tasks||[];
  fs.writeFileSync(file,JSON.stringify(store));
  await asUser('a',async()=>{
    const camp=await service.createWorkbench({templateId:'graduate-admission',name:'夏令营覆盖',mailboxIds:['a-mail']});
    const item=await service.createItem(camp.id,{title:'A校',fields:{institution:'A校'}});
    await service.linkMailSource(camp.id,{mailboxId:'a-mail',emailId:'need-score',itemId:item.id});
    await service.proposeItemPlan(camp.id,item.id);
    await service.linkMailSource(camp.id,{mailboxId:'a-mail',emailId:'revoke',itemId:item.id});
    await service.proposeItemPlan(camp.id,item.id);
    const materials=(await service.listScenarios()).materials.filter(m=>m.itemId===item.id && m.label==='成绩单');
    assert.equal(materials.find(m=>m.version===1).state,'superseded');
    assert.equal(materials.some(m=>m.version===2),false);
    const actions=(await service.listScenarios()).actions.filter(action=>action.itemId===item.id);
    assert.equal(actions.find(action=>action.title==='准备：成绩单').state,'cancelled');
    assert.equal(actions.find(action=>action.title==='周二12点前确认参营').state,'cancelled');
    assert.equal(actions.some(action=>action.title==='周二12点前确认参营' && action.state==='pending'),false);
    assert.equal(actions.find(action=>action.title==='核对被覆盖的旧要求').state,'pending');
    await assert.rejects(()=>service.confirmAction(camp.id,actions.find(action=>action.title==='周二12点前确认参营').id),/不能再写入待办/);
    const spring=service.resolveLocalTime('2026-03-29T01:30','Europe/London');
    assert.equal(spring.missing,true);
    const fall=service.resolveLocalTime('2026-10-25T01:30','Europe/London');
    assert.equal(fall.ambiguous,true);
    assert.equal(fall.options.length,2);
    const bst=fall.options.find(option=>option.utc==='2026-10-25T00:30:00.000Z');
    assert.ok(bst);
    const research=await service.createWorkbench({templateId:'research-applications',name:'伦敦面谈',mailboxIds:['a-mail']});
    const talk=await service.createItem(research.id,{title:'面谈',fields:{institution:'UCL',timeZone:'Europe/London'}});
    const ambiguous=await service.proposeSchedule(research.id,talk.id,{title:'面谈',localStart:'2026-10-25T01:30',localEnd:'2026-10-25T01:45',timeZone:'Europe/London'});
    assert.equal(ambiguous.ambiguous,true);
    const chosen=await service.proposeSchedule(research.id,talk.id,{title:'面谈',localStart:'2026-10-25T01:30',localEnd:'2026-10-25T01:45',timeZone:'Europe/London',startOffsetMin:bst.offsetMin,endOffsetMin:bst.offsetMin});
    assert.equal(chosen.action.schedule.timeZone,'Europe/London');
    assert.match(chosen.action.schedule.beijingStart,/T\d{2}:\d{2}/);
    const job=await service.createWorkbench({templateId:'job-applications',name:'校招面试',mailboxIds:['a-mail']});
    const role=await service.createItem(job.id,{title:'岗位',fields:{company:'甲',position:'开发'}});
    const other=await service.proposeSchedule(job.id,role.id,{title:'面试',localStart:'2026-10-25T08:30',localEnd:'2026-10-25T09:00',timeZone:'Asia/Shanghai'});
    await service.confirmSchedule(job.id,other.action.id);
    const overlap=await service.confirmSchedule(research.id,chosen.action.id);
    assert.equal(overlap.written,false);
    assert.ok(overlap.conflicts.some(c=>c.workbenchId===job.id&&c.workbenchName==='校招面试'));
    const forced=await service.confirmSchedule(research.id,chosen.action.id,{acknowledgeConflicts:true});
    assert.equal(forced.written,true);
    const events=JSON.parse(fs.readFileSync(file,'utf8')).events.filter(e=>e.scenarioActionId===chosen.action.id);
    assert.equal(events.length,1);
    const repeated=await service.confirmSchedule(research.id,chosen.action.id,{acknowledgeConflicts:true});
    assert.equal(repeated.duplicate,true);
  });
});

test('同一封邮件在两个工作台只写入一次待办和一次相同时刻',async()=>{
  await asUser('a',async()=>{
    const mailboxId='a-mail';
    const folder=path.join(directory,'mailboxes',mailboxId);
    fs.mkdirSync(folder,{recursive:true});
    const file=path.join(folder,'calendar.json');
    fs.writeFileSync(file,JSON.stringify({emails:[{id:'shared-mail',subject:'测评与面试',body:'请周三前完成测评。',receivedAt:'2026-10-13T01:00:00.000Z'}],events:[],tasks:[]}));
    const left=await service.createWorkbench({templateId:'job-applications',name:'公司甲',mailboxIds:[mailboxId]});
    const right=await service.createWorkbench({templateId:'job-applications',name:'公司乙',mailboxIds:[mailboxId]});
    const leftLink=await service.linkMailSource(left.id,{mailboxId,emailId:'shared-mail'});
    const rightLink=await service.linkMailSource(right.id,{mailboxId,emailId:'shared-mail'});
    const leftPlan=await service.proposeItemPlan(left.id,leftLink.item.id,{useModel:false});
    const rightPlan=await service.proposeItemPlan(right.id,rightLink.item.id,{useModel:false});
    const leftTask=leftPlan.actions.find(action=>action.title==='完成测评或笔试');
    const rightTask=rightPlan.actions.find(action=>action.title==='完成测评或笔试');
    assert.ok(leftTask&&rightTask);
    await service.confirmAction(left.id,leftTask.id);
    const secondTask=await service.confirmAction(right.id,rightTask.id);
    assert.equal(secondTask.shared,true);
    const tasks=JSON.parse(fs.readFileSync(file,'utf8')).tasks.filter(task=>task.title==='完成测评或笔试');
    assert.equal(tasks.length,1);
    assert.ok(tasks[0].workbenchIds.includes(left.id)&&tasks[0].workbenchIds.includes(right.id));
    const slot={timeZone:'Asia/Shanghai',localStart:'2026-10-20T10:00',localEnd:'2026-10-20T11:00'};
    const leftSchedule=await service.proposeSchedule(left.id,leftLink.item.id,slot);
    const rightSchedule=await service.proposeSchedule(right.id,rightLink.item.id,slot);
    await service.confirmSchedule(left.id,leftSchedule.action.id,{});
    const secondSchedule=await service.confirmSchedule(right.id,rightSchedule.action.id,{});
    assert.equal(secondSchedule.shared,true);
    const events=JSON.parse(fs.readFileSync(file,'utf8')).events.filter(event=>event.emailId==='shared-mail');
    assert.equal(events.length,1);
    assert.ok(events[0].workbenchIds.includes(left.id)&&events[0].workbenchIds.includes(right.id));
  });
});

test('事项只读复用已有附件和知识片段，关掉能力后不再返回',async()=>{
  const { replaceChunks } = await import('./rag/store.js');
  await asUser('a',async()=>{
    const folder=path.join(directory,'mailboxes','a-mail');
    fs.mkdirSync(folder,{recursive:true});
    const file=path.join(folder,'calendar.json');
    fs.writeFileSync(file,JSON.stringify({events:[],tasks:[],emails:[{id:'score-mail',subject:'成绩单说明',body:'请查收成绩单。',trace_id:'score-trace',attachments:[{filename:'成绩单.pdf',contentType:'application/pdf'}]}]}));
    fs.writeFileSync(path.join(folder,'traces.json'),JSON.stringify([{trace_id:'score-trace',email_ref:'ignored',status:'imported',subject:'成绩单说明',draft_reply:'不应返回的草稿',spans:[{tool_calls:[{name:'calendar.create',arguments:{secret:'hidden'}}]}]}]));
    const wb=await service.createWorkbench({templateId:'graduate-admission',name:'材料核对',mailboxIds:['a-mail']});
    const link=await service.linkMailSource(wb.id,{mailboxId:'a-mail',emailId:'score-mail'});
    await replaceChunks('a-mail','score-file',[{id:'chunk-score',mailboxId:'a-mail',attachmentId:'score-file',filename:'成绩单.pdf',page:1,chunkIndex:0,content:'成绩单说明需要核对原件'}]);
    const found=await service.inspectItemEvidence(wb.id,link.item.id);
    assert.equal(found.attachments[0].filename,'成绩单.pdf');
    assert.equal(found.retrieval,'keyword');
    assert.equal(found.citations[0].filename,'成绩单.pdf');
    assert.equal(found.traces[0].traceId,'score-trace');
    assert.deepEqual(found.traces[0].tools,['calendar.create']);
    assert.equal(JSON.stringify(found).includes('不应返回的草稿'),false);
    assert.equal(JSON.stringify(found).includes('hidden'),false);
    assert.equal(found.attachments[0].contentType,'application/pdf');
    assert.equal('bytes' in found.attachments[0],false);
    await service.updateWorkbench(wb.id,{template:{...wb.template,capabilities:['tasks.write','calendar.write']}});
    const hidden=await service.inspectItemEvidence(wb.id,link.item.id);
    assert.equal(hidden.attachments.length,0);
    assert.equal(hidden.citations.length,0);
    assert.equal(hidden.retrieval,'skipped');
  });
});

test('工作台待办在回执前不能勾选完成',async()=>{
  const { assertTaskCompletable } = await import('./tasks.js');
  await asUser('a',async()=>{
    const job=await service.createWorkbench({templateId:'job-applications',name:'测评证据',mailboxIds:['a-mail']});
    const role=await service.createItem(job.id,{title:'开发',fields:{company:'甲',position:'开发'}});
    const folder=path.join(directory,'mailboxes','a-mail');
    fs.mkdirSync(folder,{recursive:true});
    const file=path.join(folder,'calendar.json');
    const store=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{events:[],tasks:[],emails:[]};
    store.emails=store.emails||[];
    store.emails.push({id:'exam',subject:'测评',body:'请周三前完成测评。'});
    fs.writeFileSync(file,JSON.stringify(store));
    await service.linkMailSource(job.id,{mailboxId:'a-mail',emailId:'exam',subject:'测评',itemId:role.id});
    const plan=await service.proposeItemPlan(job.id,role.id);
    const action=plan.actions.find(row=>row.title==='完成测评或笔试');
    assert.ok(action);
    await assert.rejects(()=>service.recordReceipt(job.id,{actionId:action.id,note:'已在招聘平台提交测评',status:'submitted'}),/先确认写入待办/);
    const confirmed=await service.confirmAction(job.id,action.id);
    const tasks=JSON.parse(fs.readFileSync(file,'utf8')).tasks;
    const task=tasks.find(row=>row.id===confirmed.execution.taskId);
    assert.equal(task.verificationMode,'scenario_receipt');
    assert.throws(()=>assertTaskCompletable(task),/登记已提交/);
    await service.recordReceipt(job.id,{actionId:action.id,note:'已在招聘平台提交测评',status:'submitted'});
    const after=JSON.parse(fs.readFileSync(file,'utf8')).tasks.find(row=>row.id===task.id);
    assert.equal(after.scenarioReceipt.status,'submitted');
    assert.equal(assertTaskCompletable(after).ok,true);
    assert.equal((await service.listScenarios()).actions.find(row=>row.id===action.id).state,'submitted');
    const synced=await service.syncLocalTaskStatus(action.id,'done');
    assert.equal(synced.localTaskStatus,'done');
    assert.equal(synced.state,'submitted');
  });
});

test('校招改期保留原日程并关联新安排',async()=>{
  await asUser('a',async()=>{
    const job=await service.createWorkbench({templateId:'job-applications',name:'改期',mailboxIds:['a-mail']});
    const role=await service.createItem(job.id,{title:'开发岗',fields:{company:'甲',position:'开发'}});
    const first=await service.proposeSchedule(job.id,role.id,{title:'一面',localStart:'2026-11-02T10:00',localEnd:'2026-11-02T10:30',timeZone:'Asia/Shanghai'});
    await service.confirmSchedule(job.id,first.action.id);
    const moved=await service.proposeSchedule(job.id,role.id,{title:'一面改期',localStart:'2026-11-03T14:00',localEnd:'2026-11-03T14:30',timeZone:'Asia/Shanghai',reschedule:true});
    const written=await service.confirmSchedule(job.id,moved.action.id);
    assert.equal(written.written,true);
    const file=path.join(directory,'mailboxes','a-mail','calendar.json');
    const events=JSON.parse(fs.readFileSync(file,'utf8')).events.filter(event=>event.workbenchId===job.id);
    const oldEvent=events.find(event=>event.scenarioActionId===first.action.id);
    const nextEvent=events.find(event=>event.scenarioActionId===moved.action.id);
    assert.equal(oldEvent.status,'cancelled');
    assert.equal(oldEvent.cancellationType,'reschedule');
    assert.equal(oldEvent.replacementEventId,nextEvent.id);
    assert.equal(nextEvent.previousEventId,oldEvent.id);
    assert.equal(nextEvent.status,'active');
  });
});

test('模型不能把礼貌回复改成录取，未配置模型时拒绝分析',async()=>{
  const template=OFFICIAL_TEMPLATES.find(item=>item.id==='research-applications');
  const rules=service.interpretNotice('research-applications','Happy to discuss your proposal. Funding is not confirmed yet.');
  const merged=service.mergeAnalysis(template,rules,{suggestedStage:'result',warning:'建议标记录取',tasks:['准备研究计划下一版']});
  assert.equal(merged.suggestedStage,'discussion');
  assert.match(merged.warning,/不能标记录取/);
  assert.equal(merged.tasks.includes('准备研究计划下一版'),true);
  const folder=path.join(directory,'mailboxes','a-mail');
  fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,'calendar.json');
  const store=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{events:[],tasks:[],emails:[]};
  store.emails=store.emails||[];
  store.emails.push({id:'polite',subject:'Re: proposal',body:'Happy to discuss your proposal. Funding is not confirmed yet.'});
  fs.writeFileSync(file,JSON.stringify(store));
  await asUser('a',async()=>{
    const wb=await service.createWorkbench({templateId:'research-applications',name:'模型',mailboxIds:['a-mail']});
    const item=await service.createItem(wb.id,{title:'导师',fields:{institution:'U'}});
    await service.linkMailSource(wb.id,{mailboxId:'a-mail',emailId:'polite',itemId:item.id});
    await assert.rejects(()=>service.proposeItemPlan(wb.id,item.id,{useModel:true}),/请先配置模型/);
    const plan=await service.proposeItemPlan(wb.id,item.id,{useModel:true,callModel:async()=>({suggestedStage:'result',tasks:['跟进下一封'],warning:'模型原文'})});
    assert.equal(plan.interpretation.source,'model+rules');
    assert.equal(plan.interpretation.suggestedStage,'discussion');
  });
});

test('模板草稿拒绝代码，升级不删除已有事项',async()=>{
  assert.throws(()=>service.draftTemplate({code:'process.exit(0)',name:'坏'}),/不能包含代码/);
  assert.equal(service.draftTemplate({prompt:'帮我做一个保研工作台'}).status,'reserved');
  const draft=service.draftTemplate({name:'访学联系',fields:[{key:'school',label:'学校',type:'text',required:true}],stages:[{id:'open',label:'进行中'}]});
  assert.equal(draft.status,'draft');
  assert.equal(JSON.stringify(draft.pack).includes('recruitment.use'),false);
  assert.equal(JSON.stringify(draft.pack).includes('invoices.use'),false);
  await asUser('a',async()=>{
    const wb=await service.createWorkbench({templateId:'job-applications',name:'升级',mailboxIds:['a-mail']});
    const item=await service.createItem(wb.id,{title:'岗位',fields:{company:'甲',position:'开发'}});
    await service.updateWorkbench(wb.id,{template:{...wb.template,version:'0.9.0',rules:'旧规则，至少十个字符'}});
    const preview=await service.previewWorkbenchUpgrade(wb.id);
    assert.equal(preview.available,true);
    const upgraded=await service.applyWorkbenchUpgrade(wb.id);
    assert.equal(upgraded.template.version,'1.0.0');
    assert.equal((await service.listScenarios()).items.find(row=>row.id===item.id).title,'岗位');
    await service.updateWorkbench(wb.id,{template:{...upgraded.template,signals:[]}});
    const stale=await service.previewWorkbenchUpgrade(wb.id);
    assert.equal(stale.available,true);
    assert.match(stale.reason,/识别规则有更新/);
    const restored=await service.applyWorkbenchUpgrade(wb.id);
    assert.ok(restored.template.signals.some(signal=>(signal.tasks||[]).includes('完成测评或笔试')));
    assert.equal((await service.listScenarios()).items.find(row=>row.id===item.id).title,'岗位');
    assert.equal((await service.previewWorkbenchUpgrade(wb.id)).available,false);
    const withoutEvidence={...restored.template,stages:restored.template.stages.map(({evidence,...stage})=>stage)};
    await service.updateWorkbench(wb.id,{template:withoutEvidence});
    const gated=await service.previewWorkbenchUpgrade(wb.id);
    assert.equal(gated.available,true);
    assert.ok(gated.evidenceStages.includes('已投递'));
    assert.ok(gated.evidenceStages.includes('结果待核对'));
    await service.applyWorkbenchUpgrade(wb.id);
    assert.equal((await service.listScenarios()).items.find(row=>row.id===item.id).stage,item.stage);
  });
});

test('招聘简历邮件只生成筛选待办，确认后不发邀约也不改招聘资料',async()=>{
  const folder=path.join(directory,'mailboxes','b-mail');
  fs.mkdirSync(folder,{recursive:true});
  const calendarPath=path.join(folder,'calendar.json');
  const store=fs.existsSync(calendarPath)?JSON.parse(fs.readFileSync(calendarPath,'utf8')):{events:[],tasks:[],emails:[]};
  store.emails=store.emails||[];
  if(!store.emails.some(email=>email.id==='resume-mail')) store.emails.push({id:'resume-mail',subject:'应聘',body:'附件为我的求职简历。'});
  store.events=store.events||[];
  store.tasks=store.tasks||[];
  fs.writeFileSync(calendarPath,JSON.stringify(store));
  const recruitmentPath=path.join(folder,'recruitment.json');
  const existed=fs.existsSync(recruitmentPath);
  const before=existed?fs.readFileSync(recruitmentPath,'utf8'):null;
  try {
  await asUser('b',async()=>{
    const wb=await service.createWorkbench({templateId:'recruitment',name:'简历筛选',mailboxIds:['b-mail']});
    const item=await service.createItem(wb.id,{title:'开发岗',fields:{position:'开发'}});
    await service.linkMailSource(wb.id,{mailboxId:'b-mail',emailId:'resume-mail',itemId:item.id});
    const plan=await service.proposeItemPlan(wb.id,item.id);
    const screen=plan.actions.find(action=>action.title==='在招聘引擎中筛选候选人');
    assert.equal(plan.interpretation.suggestedStage,'screening');
    const storedRole=(await service.listScenarios()).items.find(row=>row.id===item.id);
    assert.equal(storedRole.stage,'received');
    assert.equal(storedRole.suggestedStage,'screening');
    assert.ok(screen);
    assert.equal(screen.kind,'task');
    assert.equal(plan.actions.some(action=>action.kind==='calendar'||action.kind==='draft'),false);
    const confirmed=await service.confirmAction(wb.id,screen.id);
    assert.equal(confirmed.action.state,'prepared');
    const tasks=JSON.parse(fs.readFileSync(calendarPath,'utf8')).tasks;
    assert.equal(tasks.filter(task=>task.scenarioActionId===screen.id).length,1);
    assert.equal(fs.existsSync(recruitmentPath),existed);
    if(before!==null) assert.equal(fs.readFileSync(recruitmentPath,'utf8'),before);
  });
  } finally {
    if(before===null) fs.rmSync(recruitmentPath,{force:true});
    else fs.writeFileSync(recruitmentPath,before);
  }
});

test('招聘事项只读复用已关联邮件的简历和执行记录',async()=>{
  const folder=path.join(directory,'mailboxes','b-mail');
  fs.mkdirSync(folder,{recursive:true});
  const calendarPath=path.join(folder,'calendar.json');
  const store=fs.existsSync(calendarPath)?JSON.parse(fs.readFileSync(calendarPath,'utf8')):{events:[],tasks:[],emails:[]};
  store.emails=store.emails||[];
  if(!store.emails.some(email=>email.id==='resume-mail')) store.emails.push({id:'resume-mail',subject:'应聘',body:'附件为我的求职简历。'});
  fs.writeFileSync(calendarPath,JSON.stringify(store));
  const recruitmentPath=path.join(folder,'recruitment.json');
  const before=fs.existsSync(recruitmentPath)?fs.readFileSync(recruitmentPath,'utf8'):'';
  try {
  fs.writeFileSync(recruitmentPath,JSON.stringify({
    candidates:[{id:'cand-1',name:'合成候选人',phone:'13800000000'}],
    attachments:[
      {id:'cv-linked',emailId:'resume-mail',filename:'简历.pdf',contentType:'application/pdf',candidateId:'cand-1',text:'不应返回的简历正文'},
      {id:'cv-other',emailId:'other-mail',filename:'别人的简历.pdf',contentType:'application/pdf'},
    ],
    interviews:[],
    traces:[
      {trace_id:'recruit-trace',email_id:'resume-mail',status:'imported',subject:'应聘',draft_reply:'不应返回的邀约草稿',spans:[{tool_calls:[{name:'resume.parse',arguments:{secret:'hidden'}}]}]},
      {trace_id:'reply-trace',email_ref:emailReference('recruitment:resume-mail'),status:'imported',subject:'面试回复',spans:[{tool_calls:[{name:'interview.reply'}]}]},
      {trace_id:'other-trace',email_ref:emailReference('recruitment:other-mail'),status:'imported',subject:'其他人的执行记录',spans:[{tool_calls:[{name:'interview.reply'}]}]},
    ],
  }));
  await asUser('b',async()=>{
    const wb=await service.createWorkbench({templateId:'recruitment',name:'证据复用',mailboxIds:['b-mail']});
    const item=await service.createItem(wb.id,{title:'开发岗',fields:{position:'开发'}});
    await service.linkMailSource(wb.id,{mailboxId:'b-mail',emailId:'resume-mail',itemId:item.id});
    const found=await service.inspectItemEvidence(wb.id,item.id);
    assert.equal(found.attachments.some(file=>file.filename==='简历.pdf'&&file.source==='recruitment'&&file.candidateId==='cand-1'),true);
    assert.equal(found.attachments.some(file=>file.filename==='别人的简历.pdf'),false);
    assert.equal(found.traces.some(trace=>trace.traceId==='recruit-trace'&&trace.source==='recruitment'&&trace.tools.includes('resume.parse')),true);
    assert.equal(found.traces.some(trace=>trace.traceId==='reply-trace'&&trace.tools.includes('interview.reply')),true);
    assert.equal(found.traces.some(trace=>trace.traceId==='other-trace'),false);
    const packed=JSON.stringify(found);
    assert.equal(packed.includes('不应返回'),false);
    assert.equal(packed.includes('hidden'),false);
    assert.equal(packed.includes('13800000000'),false);
  });
  } finally {
    if(before) fs.writeFileSync(recruitmentPath,before);
    else fs.rmSync(recruitmentPath,{force:true});
  }
});

test('读取已有招聘文件不创建工作台，历史招聘工作台和原数据仍保留',async()=>{
  const folder=path.join(directory,'mailboxes','a-mail');
  fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,'recruitment.json');
  const original=JSON.stringify({candidates:[{id:'keep',name:'合成'}],interviews:[],attachments:[]});
  fs.writeFileSync(file,original);
  await asUser('a',async()=>{
    const before=await readScenarioData();
    const first=await service.listScenarios();
    assert.deepEqual(first.workbenches,before.workbenches);
    assert.equal(first.workbenches.some(row=>row.template.capabilities.includes('recruitment.use')),false);
    const second=await service.listScenarios();
    assert.deepEqual(second,first);
    assert.deepEqual(await readScenarioData(),before);
    const legacy=await service.createWorkbench({templateId:'recruitment',name:'原有招聘工作台',mailboxIds:['a-mail']});
    const item=await service.createItem(legacy.id,{title:'保留的招聘事项',fields:{position:'开发'}});
    const saved=await readScenarioData();
    for(let i=0;i<2;i++) {
      const current=await service.listScenarios();
      assert.deepEqual(current.workbenches,saved.workbenches);
      assert.ok(current.items.some(row=>row.id===item.id));
      assert.deepEqual(await readScenarioData(),saved);
    }
    assert.equal(fs.readFileSync(file,'utf8'),original);
    const again=await service.createWorkbench({templateId:'recruitment',name:'再添加',mailboxIds:['a-mail']});
    await service.deleteWorkbench(again.id);
    const after=await service.listScenarios();
    assert.equal(after.workbenches.some(row=>row.id===again.id),false);
    assert.equal(after.workbenches.some(row=>row.id===legacy.id),true);
    assert.equal(fs.readFileSync(file,'utf8'),original);
    await assert.rejects(()=>service.deletePersonalTemplate('graduate-admission'),/官方模板不能删除/);
  });
});

test('已提交的研究计划在补充要求后保留旧版本',async()=>{
  await asUser('b',async()=>{
    const wb=await service.createWorkbench({templateId:'research-applications',name:'材料版本',mailboxIds:['b-mail']});
    const item=await service.createItem(wb.id,{title:'导师',fields:{institution:'U'}});
    await service.proposeItemPlan(wb.id,item.id);
    const first=(await service.listScenarios()).materials.find(row=>row.itemId===item.id && row.label==='研究计划');
    await service.recordReceipt(wb.id,{materialId:first.id,note:'已准备第一版研究计划'});
    await service.recordExternalSource(wb.id,item.id,{channel:'个人补充',note:'请补充研究计划的第二版。'});
    await service.proposeItemPlan(wb.id,item.id);
    const rows=(await service.listScenarios()).materials.filter(row=>row.itemId===item.id && row.label==='研究计划');
    assert.equal(rows.find(row=>row.version===1).state,'superseded');
    assert.equal(rows.find(row=>row.version===2).state,'missing');
  });
});

test('保研通知拆成多条截止待办，未确认前不写入待办',async()=>{
  const folder=path.join(directory,'mailboxes','b-mail');
  fs.mkdirSync(folder,{recursive:true});
  const calendarPath=path.join(folder,'calendar.json');
  const existing=fs.existsSync(calendarPath)?JSON.parse(fs.readFileSync(calendarPath,'utf8')):{events:[],tasks:[],emails:[]};
  existing.emails=existing.emails||[];
  existing.emails.push({id:'camp-deadlines',subject:'参营确认',receivedAt:'2026-10-13T01:00:00.000Z',body:'请周二12点前确认参营，周三前补成绩单，周五14点面试。'});
  fs.writeFileSync(calendarPath,JSON.stringify(existing));
  await asUser('b',async()=>{
    const wb=await service.createWorkbench({templateId:'graduate-admission',name:'夏令营截止',mailboxIds:['b-mail']});
    const item=await service.createItem(wb.id,{title:'A校',fields:{institution:'A校'}});
    await service.linkMailSource(wb.id,{mailboxId:'b-mail',emailId:'camp-deadlines',itemId:item.id});
    const plan=await service.proposeItemPlan(wb.id,item.id);
    const titles=plan.actions.map(action=>action.title);
    assert.ok(titles.includes('周二12点前确认参营'));
    assert.ok(titles.includes('周三前补成绩单'));
    assert.ok(titles.includes('周五14点面试'));
    const confirm=plan.actions.find(action=>action.title==='周二12点前确认参营');
    assert.equal(confirm.state,'pending');
    assert.equal(confirm.dueAt,'2026-10-13T12:00:00+08:00');
    const interview=plan.actions.find(action=>action.title==='周五14点面试');
    assert.equal(interview.dueAt,'2026-10-16T14:00:00+08:00');
    assert.equal(interview.kind,'calendar');
    assert.equal(interview.schedule.beijingStart,'2026-10-16T14:00');
    assert.equal(interview.schedule.beijingEnd,'2026-10-16T15:00');
    const store=JSON.parse(fs.readFileSync(calendarPath,'utf8'));
    assert.equal(store.tasks.some(task=>task.scenarioActionId===confirm.id),false);
    assert.equal((store.events||[]).some(event=>event.scenarioActionId===interview.id),false);
    const written=await service.confirmSchedule(wb.id,interview.id);
    assert.equal(written.written,true);
    const saved=JSON.parse(fs.readFileSync(calendarPath,'utf8')).events.find(event=>event.scenarioActionId===interview.id);
    assert.equal(saved.status,'active');
    assert.equal(saved.start,interview.schedule.startUtc);
  });
});

test('外部来源只记原文，可生成建议和未发送草稿',async()=>{
  await asUser('b',async()=>{
    const wb=await service.createWorkbench({templateId:'research-publications',name:'投稿外部',mailboxIds:['b-mail']});
    const item=await service.createItem(wb.id,{title:'会议稿',fields:{venue:'会议'}});
    await assert.rejects(()=>service.recordExternalSource(wb.id,item.id,{channel:'私人邮箱',note:'秘密'}),/模板列出的外部来源/);
    await service.recordExternalSource(wb.id,item.id,{channel:'投稿系统',note:'请所有作者确认后，于周五前提交终稿。'});
    const plan=await service.proposeItemPlan(wb.id,item.id);
    assert.ok(plan.actions.some(action=>action.title==='共同作者确认'));
    const deadline=plan.actions.find(action=>action.title.includes('周五前'));
    assert.equal(deadline.kind,'task');
    assert.match(deadline.dueAt,/T18:00:00\+08:00/);
    const { createHash } = await import('node:crypto');
    const scenarioFile=path.join(directory,'scenarios',`${createHash('sha256').update('b').digest('hex')}.json`);
    const stored=JSON.parse(fs.readFileSync(scenarioFile,'utf8'));
    const saved=stored.actions.find(action=>action.id===deadline.id);
    saved.dueAt=null;
    fs.writeFileSync(scenarioFile,JSON.stringify(stored));
    const again=await service.proposeItemPlan(wb.id,item.id);
    const filled=(await service.listScenarios()).actions.find(action=>action.id===deadline.id);
    assert.equal(again.actions.some(action=>action.id===deadline.id),false);
    assert.match(filled.dueAt,/T18:00:00\+08:00/);
    assert.equal(filled.state,'pending');
    const material=(await service.listScenarios()).materials.find(row=>row.itemId===item.id);
    assert.equal(material.state,'missing');
    await assert.rejects(()=>service.recordReceipt(wb.id,{materialId:material.id,note:'对方已收',status:'confirmed'}),/不能标为对方确认/);
    const ready=await service.recordReceipt(wb.id,{materialId:material.id,note:'本地已备好',status:'prepared'});
    assert.equal(ready.material.state,'prepared');
    assert.equal(ready.material.receipt,'本地已备好');
    const submitted=await service.recordReceipt(wb.id,{materialId:material.id,note:'投稿系统回执 123',status:'submitted'});
    assert.equal(submitted.material.state,'submitted');
    const draft=await service.saveReplyDraft(wb.id,item.id,{body:'收到终稿通知，尚未在投稿系统提交。'});
    assert.equal(draft.sent,false);
    assert.equal(draft.action.state,'prepared');
    assert.equal(draft.action.emailId,null);
  });
});

test('终稿可以同时依赖多项前置，未完成时不能写入待办',async()=>{
  const draft=service.draftTemplate({
    name:'双前置',
    fields:[{key:'venue',label:'会议',type:'text',required:true}],
    stages:[{id:'final',label:'终稿'}],
    externalSources:['投稿系统'],
    capabilities:['tasks.write'],
    signals:[
      {keywords:['终稿'],tasks:['提交终稿'],dependsOn:['共同作者确认','注册缴费'],priority:10},
      {keywords:['作者'],tasks:['共同作者确认'],priority:5},
      {keywords:['注册'],tasks:['注册缴费'],priority:5},
    ],
  });
  const seen=service.interpretNotice(draft.pack.template,'请作者确认并完成注册后提交终稿');
  assert.deepEqual(seen.dependencyByTitle['提交终稿'],['共同作者确认','注册缴费']);
  await asUser('a',async()=>{
    const folder=path.join(directory,'mailboxes','a-mail');
    fs.mkdirSync(folder,{recursive:true});
    const file=path.join(folder,'calendar.json');
    if(!fs.existsSync(file)) fs.writeFileSync(file,JSON.stringify({emails:[],events:[],tasks:[]}));
    const saved=await service.savePersonalTemplate(draft.pack);
    const wb=await service.createWorkbench({templateId:saved.id,name:'双前置',mailboxIds:['a-mail']});
    const item=await service.createItem(wb.id,{title:'稿件',fields:{venue:'会议'}});
    await service.recordExternalSource(wb.id,item.id,{channel:'投稿系统',note:'请作者确认并完成注册后提交终稿。'});
    await service.proposeItemPlan(wb.id,item.id);
    const actions=(await service.listScenarios()).actions.filter(action=>action.itemId===item.id);
    const submit=actions.find(action=>action.title==='提交终稿');
    const gates=actions.filter(action=>['共同作者确认','注册缴费'].includes(action.title));
    assert.equal(gates.length,2);
    assert.deepEqual(submit.dependsOn,gates.map(action=>action.id));
    await assert.rejects(()=>service.confirmAction(wb.id,submit.id),/前置行动尚未完成：共同作者确认、注册缴费/);
    await service.confirmAction(wb.id,gates[0].id);
    await assert.rejects(()=>service.confirmAction(wb.id,submit.id),/前置行动/);
    const done=await service.confirmAction(wb.id,gates[1].id).then(()=>service.confirmAction(wb.id,submit.id));
    assert.equal(done.action.state,'prepared');
  });
});

test('带前置的报告时间在前置完成前不能写入日历',async()=>{
  const draft=service.draftTemplate({
    name:'报告前置',
    fields:[{key:'venue',label:'会议',type:'text',required:true}],
    stages:[{id:'final',label:'终稿'}],
    capabilities:['tasks.write','calendar.write','mail.read'],
    signals:[
      {keywords:['报告'],tasks:['周五14点报告'],dependsOn:['共同作者确认'],dependsOnKeywords:['作者'],priority:10},
      {keywords:['作者'],tasks:['共同作者确认'],priority:5},
    ],
  });
  await asUser('a',async()=>{
    const folder=path.join(directory,'mailboxes','a-mail');
    fs.mkdirSync(folder,{recursive:true});
    const file=path.join(folder,'calendar.json');
    const store=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{emails:[],events:[],tasks:[]};
    store.emails=store.emails||[];
    store.emails.push({id:'talk-mail',subject:'报告安排',body:'请作者确认。周五14点报告。',receivedAt:'2026-10-13T01:00:00.000Z'});
    fs.writeFileSync(file,JSON.stringify(store));
    const saved=await service.savePersonalTemplate(draft.pack);
    const wb=await service.createWorkbench({templateId:saved.id,name:'报告前置',mailboxIds:['a-mail']});
    const item=await service.createItem(wb.id,{title:'会议报告',fields:{venue:'会议'}});
    await service.linkMailSource(wb.id,{mailboxId:'a-mail',emailId:'talk-mail',itemId:item.id});
    await service.proposeItemPlan(wb.id,item.id);
    const actions=(await service.listScenarios()).actions.filter(action=>action.itemId===item.id);
    const talk=actions.find(action=>action.title==='周五14点报告');
    const gate=actions.find(action=>action.title==='共同作者确认');
    assert.equal(talk.kind,'calendar');
    assert.ok(talk.dependsOn.includes(gate.id));
    await assert.rejects(()=>service.confirmSchedule(wb.id,talk.id),/前置行动尚未完成：共同作者确认/);
    await service.confirmAction(wb.id,gate.id);
    const written=await service.confirmSchedule(wb.id,talk.id);
    assert.equal(written.written,true);
  });
});

test('个人模板可以用识别信号声明阶段和待办',async()=>{
  const draft=service.draftTemplate({
    name:'实验室轮转',
    fields:[{key:'lab',label:'实验室',type:'text',required:true}],
    stages:[{id:'preparing',label:'准备中'},{id:'interview',label:'面谈'}],
    signals:[{keywords:['轮转面谈'],suggestedStage:'interview',tasks:['准备轮转材料'],priority:5}],
  });
  assert.equal(draft.status,'draft');
  const seen=service.interpretNotice(draft.pack.template,'下周三有轮转面谈');
  assert.equal(seen.suggestedStage,'interview');
  assert.deepEqual(seen.tasks,['准备轮转材料']);
});

test('个人模板使用通用安全提示，不套用招聘文案',async()=>{
  const draft=service.draftTemplate({name:'访学联系',fields:[{key:'school',label:'学校',type:'text',required:true}],stages:[{id:'open',label:'进行中'}]});
  await asUser('a',async()=>{
    const saved=await service.savePersonalTemplate(draft.pack);
    const wb=await service.createWorkbench({templateId:saved.id,name:'访学',mailboxIds:['a-mail']});
    const item=await service.createItem(wb.id,{title:'实验室',fields:{school:'A'}});
    const plan=await service.proposeItemPlan(wb.id,item.id);
    assert.equal(plan.interpretation.warning.includes('招聘'),false);
    assert.match(plan.interpretation.warning,/不代表已提交/);
  });
});

test('本地并发写入序列化，不丢工作台或串用户',async()=>{
  await asUser('a',async()=>{
    const before=(await service.listScenarios()).workbenches.length;
    await Promise.all(Array.from({length:8},(_,i)=>service.createWorkbench({templateId:'job-applications',name:`并发${i}`,mailboxIds:['a-mail']})));
    assert.equal((await service.listScenarios()).workbenches.length,before+8);
  });
});

test('工作台隐藏偏好按用户持久化，部分更新保留归档与业务数据',async()=>{
  await asUser('a',async()=>{
    const wb=await service.createWorkbench({templateId:'job-applications',name:'可隐藏工作台',mailboxIds:['a-mail']});
    await service.createItem(wb.id,{title:'保留的岗位',fields:{company:'测试企业',position:'开发'}});
    await service.updateWorkbench(wb.id,{archived:true});
    const before=await readScenarioData();
    assert.equal(before.navigation,undefined);
    assert.deepEqual((await service.listScenarios()).navigation,{hiddenFeatureIds:[],hiddenWorkbenchIds:[]});
    const hidden=await service.updateScenarioNavigation({hiddenFeatureIds:['invoices'],hiddenWorkbenchIds:[wb.id]});
    assert.deepEqual(hidden,{hiddenFeatureIds:['invoices'],hiddenWorkbenchIds:[wb.id]});
    assert.deepEqual(await readScenarioData(),{...before,navigation:hidden});
    assert.deepEqual((await service.listScenarios()).navigation,hidden);
    await asUser('b',async()=>{
      assert.deepEqual((await service.listScenarios()).navigation,{hiddenFeatureIds:[],hiddenWorkbenchIds:[]});
      await assert.rejects(()=>service.updateScenarioNavigation({hiddenWorkbenchIds:[wb.id]}),/属于当前用户/);
    });
    const restored=await service.updateScenarioNavigation({hiddenFeatureIds:[]});
    assert.deepEqual(restored,{hiddenFeatureIds:[],hiddenWorkbenchIds:[wb.id]});
    assert.deepEqual(await readScenarioData(),{...before,navigation:restored});
    assert.deepEqual(await service.updateScenarioNavigation({hiddenWorkbenchIds:[]}),{hiddenFeatureIds:[],hiddenWorkbenchIds:[]});
  });
});

test('工作台显示设置严格校验，非法更新不改变已存数据',async()=>{
  await assert.rejects(()=>service.updateScenarioNavigation({hiddenFeatureIds:['invoices']}),/请先登录/);
  await asUser('a',async()=>{
    const wb=(await service.listScenarios()).workbenches[0];
    await service.updateScenarioNavigation({hiddenFeatureIds:['invoices'],hiddenWorkbenchIds:[wb.id]});
    const before=await readScenarioData();
    const invalid=[null,[],true,'invoices',{unknown:[]},
      {hiddenFeatureIds:null},{hiddenFeatureIds:'invoices'},{hiddenFeatureIds:[1]},{hiddenFeatureIds:['']},
      {hiddenFeatureIds:['invoices','invoices']},{hiddenFeatureIds:['unknown']},
      {hiddenWorkbenchIds:{}},{hiddenWorkbenchIds:[false]},{hiddenWorkbenchIds:[wb.id,wb.id]},
      {hiddenWorkbenchIds:['missing-workbench']},
      {hiddenFeatureIds:[],hiddenWorkbenchIds:['missing-workbench']},
    ];
    for(const input of invalid) {
      await assert.rejects(()=>service.updateScenarioNavigation(input),error=>error.status===400);
      assert.deepEqual(await readScenarioData(),before);
    }
  });
});

test('旧工作台显示设置规范化返回，兼容缺失值并保留其他字段',async()=>{
  await asUser('a',async()=>{
    const wb=(await service.listScenarios()).workbenches[0];
    await mutateScenarioData(data=>{
      data.futureSetting={retained:true};
      data.navigation={hiddenFeatureIds:['invoices','unknown','invoices'],hiddenWorkbenchIds:[wb.id,'old-deleted-id',wb.id],futurePreference:'preserve'};
    });
    assert.deepEqual((await service.listScenarios()).navigation,{hiddenFeatureIds:['invoices'],hiddenWorkbenchIds:[wb.id]});
    const before=await readScenarioData();
    await service.updateScenarioNavigation({hiddenFeatureIds:[]});
    assert.deepEqual(await readScenarioData(),{...before,navigation:{...before.navigation,hiddenFeatureIds:[],hiddenWorkbenchIds:[wb.id]}});
  });
});

test('并发调整保留两类偏好，历史招聘工作台仍保留原记录',async()=>{
  await asUser('a',async()=>{
    const before=await service.listScenarios();
    const recruitment=before.workbenches.find(w=>!w.archived&&w.template.capabilities.includes('recruitment.use'));
    assert.ok(recruitment);
    const file=path.join(directory,'mailboxes','a-mail','recruitment.json');
    const original=fs.readFileSync(file,'utf8');
    await service.updateScenarioNavigation({hiddenFeatureIds:[],hiddenWorkbenchIds:[]});
    await Promise.all([
      service.updateScenarioNavigation({hiddenFeatureIds:['invoices']}),
      service.updateScenarioNavigation({hiddenWorkbenchIds:[recruitment.id]}),
    ]);
    for(let i=0;i<2;i++) {
      const current=await service.listScenarios();
      assert.deepEqual(current.navigation,{hiddenFeatureIds:['invoices'],hiddenWorkbenchIds:[recruitment.id]});
      assert.deepEqual(current.workbenches,before.workbenches);
    }
    assert.equal(fs.readFileSync(file,'utf8'),original);
  });
});

test('单项显示操作并发合并同一列表，混合隐藏恢复幂等且保留业务数据',async()=>{
  await asUser('a',async()=>{
    const workbenches=await Promise.all(['甲','乙','丙'].map(label=>service.createWorkbench({templateId:'job-applications',name:`并发可见性${label}`,mailboxIds:['a-mail']})));
    const [left,right,archived]=workbenches;
    await service.updateWorkbench(archived.id,{archived:true});
    await service.updateScenarioNavigation({hiddenFeatureIds:[],hiddenWorkbenchIds:[]});
    const before=await readScenarioData();
    await Promise.all([
      service.updateScenarioVisibility({kind:'workbench',id:left.id,visible:false}),
      service.updateScenarioVisibility({kind:'workbench',id:right.id,visible:false}),
      service.updateScenarioVisibility({kind:'feature',id:'invoices',visible:false}),
    ]);
    let navigation=(await service.listScenarios()).navigation;
    assert.deepEqual(navigation.hiddenWorkbenchIds.slice().sort(),[left.id,right.id].sort());
    assert.deepEqual(navigation.hiddenFeatureIds,['invoices']);
    await Promise.all([
      service.updateScenarioVisibility({kind:'workbench',id:left.id,visible:true}),
      service.updateScenarioVisibility({kind:'workbench',id:archived.id,visible:false}),
    ]);
    navigation=(await service.listScenarios()).navigation;
    assert.deepEqual(navigation.hiddenWorkbenchIds.slice().sort(),[right.id,archived.id].sort());
    assert.deepEqual(navigation.hiddenFeatureIds,['invoices']);
    const after=await readScenarioData();
    assert.deepEqual(after,{...before,navigation:{...before.navigation,...navigation}});
    await Promise.all([
      service.updateScenarioVisibility({kind:'workbench',id:archived.id,visible:false}),
      service.updateScenarioVisibility({kind:'workbench',id:left.id,visible:true}),
      service.updateScenarioVisibility({kind:'feature',id:'invoices',visible:false}),
    ]);
    assert.deepEqual(await readScenarioData(),after);
    const restored=await service.updateScenarioVisibility({kind:'feature',id:'invoices',visible:true});
    assert.deepEqual(restored,{...navigation,hiddenFeatureIds:[]});
    await asUser('b',async()=>{
      const ownBefore=await readScenarioData();
      await assert.rejects(()=>service.updateScenarioVisibility({kind:'workbench',id:left.id,visible:false}),/属于当前用户/);
      assert.deepEqual(await readScenarioData(),ownBefore);
    });
  });
});

test('单项显示操作严格校验完整请求，拒绝未登录及非法输入且不落盘',async()=>{
  const valid={kind:'feature',id:'invoices',visible:false};
  await assert.rejects(()=>service.updateScenarioVisibility(valid),/请先登录/);
  await asUser('a',async()=>{
    const before=await readScenarioData();
    const invalid=[null,[],true,'invoices',{},
      {id:'invoices',visible:false},{kind:'feature',visible:false},{kind:'feature',id:'invoices'},
      {...valid,kind:'features'},{...valid,kind:null},{...valid,id:[]},{...valid,id:''},
      {...valid,id:'unknown'},{...valid,visible:'false'},{...valid,visible:0},{...valid,visible:null},
      {...valid,extra:true},{...valid,kind:'workbench',id:'missing-workbench'},
    ];
    for(const input of invalid) {
      await assert.rejects(()=>service.updateScenarioVisibility(input),error=>error.status===400);
      assert.deepEqual(await readScenarioData(),before);
    }
  });
});

test('智能招聘和发票入口独立隐藏恢复，按用户保存且不改招聘或工作台数据',async()=>{
  await asUser('a',async()=>{
    await service.updateScenarioNavigation({hiddenFeatureIds:[],hiddenWorkbenchIds:[]});
    const before=await readScenarioData();
    const file=path.join(directory,'mailboxes','a-mail','recruitment.json');
    const original=fs.readFileSync(file,'utf8');
    await Promise.all(['invoices','recruitment'].map(id=>service.updateScenarioVisibility({kind:'feature',id,visible:false})));
    const hidden=(await service.listScenarios()).navigation;
    assert.deepEqual(hidden.hiddenFeatureIds.slice().sort(),['invoices','recruitment']);
    assert.deepEqual(hidden.hiddenWorkbenchIds,[]);
    assert.deepEqual(await readScenarioData(),{...before,navigation:{...before.navigation,...hidden}});
    await asUser('b',async()=>{
      assert.deepEqual((await service.listScenarios()).navigation,{hiddenFeatureIds:[],hiddenWorkbenchIds:[]});
      await service.updateScenarioNavigation({hiddenFeatureIds:['recruitment']});
      assert.deepEqual((await service.listScenarios()).navigation,{hiddenFeatureIds:['recruitment'],hiddenWorkbenchIds:[]});
    });
    assert.deepEqual((await service.listScenarios()).navigation,hidden);
    const restored=await service.updateScenarioVisibility({kind:'feature',id:'recruitment',visible:true});
    assert.deepEqual(restored,{hiddenFeatureIds:['invoices'],hiddenWorkbenchIds:[]});
    assert.deepEqual((await service.listScenarios()).navigation,restored);
    await asUser('b',async()=>{
      assert.deepEqual((await service.listScenarios()).navigation,{hiddenFeatureIds:['recruitment'],hiddenWorkbenchIds:[]});
      await service.updateScenarioNavigation({hiddenFeatureIds:[]});
    });
    assert.deepEqual(await readScenarioData(),{...before,navigation:{...before.navigation,...restored}});
    assert.equal(fs.readFileSync(file,'utf8'),original);
  });
});
