import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import jwt from 'jsonwebtoken';

test('真实 HTTP：个人/HR 均可用招聘，工作台仍需登录且隔离用户，旧数据保留', {timeout:60000}, async()=>{
  fs.mkdirSync('work',{recursive:true});
  const dir=fs.mkdtempSync(path.resolve('work/scenarios-api-'));
  const secret='synthetic-scenarios-test-secret';
  const users=['personal','hr'].map((mode,i)=>({id:`user-${i}`,email:`user-${i}@example.invalid`,username:`user${i}`,role:'user',workspace_mode:mode,workspace_mode_changes:Array(4).fill({at:'2026-10-01T00:00:00Z',from:'hr',to:'personal'}),created_at:new Date().toISOString()}));
  fs.writeFileSync(path.join(dir,'users.json'),JSON.stringify({users,resets:[]}));
  fs.writeFileSync(path.join(dir,'infra.json'),JSON.stringify({postgres:{enabled:false},redis:{enabled:false},mq:{enabled:false},oss:{enabled:false},auth:{requireAuth:true,jwtSecret:secret}}));
  fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({apiKey:'',mailboxes:users.map((u,i)=>({id:`mail-${i}`,ownerUserId:u.id,email:u.email})),userPrefs:{'user-0':{activeMailboxId:'mail-0'},'user-1':{activeMailboxId:'mail-1'}}}));
  const mailDir=path.join(dir,'mailboxes','mail-0');fs.mkdirSync(mailDir,{recursive:true});
  fs.writeFileSync(path.join(mailDir,'calendar.json'),JSON.stringify({events:[],tasks:[],emails:[{id:'camp',subject:'夏令营确认',body:'请确认参营，原成绩单要求作废。'},{id:'phd',subject:'Re: PhD',body:'Happy to discuss your proposal. Funding is not confirmed yet.'},{id:'job',subject:'校招测评',body:'请周三前完成测评，面试另行通知。'},{id:'paper',subject:'终稿',body:'请所有作者确认后，于周五前提交终稿。'}]}));
  const oldPath=path.join(dir,'mailboxes','mail-1');fs.mkdirSync(oldPath,{recursive:true});
  const old='{"candidates":[{"id":"legacy-candidate","name":"合成人才"}],"interviews":[],"attachments":[],"conversations":[]}';
  fs.writeFileSync(path.join(oldPath,'recruitment.json'),old);
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  const child=spawn(process.execPath,['server/index.js','--production'],{env:{...process.env,PORT:String(port),DAYLIGHT_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',s=>output+=s);child.stderr.on('data',s=>output+=s);
  const tokens=users.map(u=>jwt.sign({sub:u.id,sv:0},secret,{expiresIn:'5m'}));
  const call=async(route,token,method='GET',body)=>{
    const res=await fetch(`http://127.0.0.1:${port}/api${route}`,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:res.status,data:await res.json()};
  };
  try {
    const readyDeadline=Date.now()+30000;
    while(Date.now()<readyDeadline&&!output.includes('Daylight is ready')) {
      if(child.exitCode!==null) throw new Error(output);
      await new Promise(r=>setTimeout(r,50));
    }
    assert.match(output,/Daylight is ready/);
    assert.equal((await call('/scenarios')).status,401);
    for(const token of tokens) {
      assert.equal((await call('/recruitment',token)).status,200);
      const me=await call('/auth/me',token);
      assert.equal(me.data.user.hasRecruitment,true);
      assert.equal('workspaceModeChangeLimit' in me.data.user,false);
      assert.equal((await call('/admin/users',token)).status,403);
      assert.equal((await call('/auth/workspace-mode',token,'POST',{workspaceMode:'hr'})).status,404);
    }
    const made=await call('/scenarios/workbenches',tokens[0],'POST',{templateId:'graduate-admission',name:'测试申请',mailboxIds:['mail-0']});
    assert.equal(made.status,200,JSON.stringify(made.data));
    assert.equal((await call('/scenarios/navigation',null,'PATCH',{hiddenFeatureIds:['invoices']})).status,401);
    const beforeNavigation=await call('/scenarios',tokens[0]);
    assert.deepEqual(beforeNavigation.data.navigation,{hiddenFeatureIds:[],hiddenWorkbenchIds:[]});
    const hide=await call('/scenarios/navigation',tokens[0],'PATCH',{hiddenFeatureIds:['invoices'],hiddenWorkbenchIds:[made.data.id]});
    assert.equal(hide.status,200);
    assert.deepEqual(hide.data,{hiddenFeatureIds:['invoices'],hiddenWorkbenchIds:[made.data.id]});
    const hidden=await call('/scenarios',tokens[0]);
    assert.deepEqual(hidden.data,{...beforeNavigation.data,navigation:hide.data});
    const persisted=fs.readdirSync(path.join(dir,'scenarios')).map(file=>JSON.parse(fs.readFileSync(path.join(dir,'scenarios',file),'utf8'))).find(data=>data.workbenches.some(w=>w.id===made.data.id));
    assert.deepEqual(persisted.navigation,hide.data);
    assert.equal((await call('/scenarios/navigation',tokens[1],'PATCH',{hiddenWorkbenchIds:[made.data.id]})).status,400);
    for(const invalid of [{hiddenFeatureIds:['unknown']},{hiddenFeatureIds:['invoices','invoices']},{hiddenWorkbenchIds:[7]},{extra:true}]) {
      assert.equal((await call('/scenarios/navigation',tokens[0],'PATCH',invalid)).status,400);
    }
    assert.deepEqual((await call('/scenarios',tokens[0])).data.navigation,hide.data);
    const restoreFeature=await call('/scenarios/navigation',tokens[0],'PATCH',{hiddenFeatureIds:[]});
    assert.equal(restoreFeature.status,200);
    assert.deepEqual(restoreFeature.data,{hiddenFeatureIds:[],hiddenWorkbenchIds:[made.data.id]});
    assert.deepEqual((await call('/scenarios',tokens[1])).data.navigation,{hiddenFeatureIds:[],hiddenWorkbenchIds:[]});
    assert.equal((await call('/scenarios/navigation',tokens[0],'PATCH',{hiddenWorkbenchIds:[]})).status,200);
    const legacy=await call('/scenarios',tokens[1]);
    assert.equal(legacy.data.workbenches.length,0);
    const again=await call('/scenarios',tokens[1]);
    assert.deepEqual(again.data,legacy.data);
    assert.equal((await call(`/scenarios/workbenches/${made.data.id}`,tokens[1],'PATCH',{name:'越权'})).status,404);
    assert.equal((await call('/scenarios/workbenches',tokens[0],'POST',{templateId:'recruitment',mailboxIds:['mail-1']})).status,400);
    assert.equal(fs.readFileSync(path.join(oldPath,'recruitment.json'),'utf8'),old);
    const templates=['graduate-admission','research-applications','job-applications','research-publications','recruitment','invoices'];
    const created={};
    for (const templateId of templates) {
      const result=await call('/scenarios/workbenches',tokens[0],'POST',{templateId,name:templateId,mailboxIds:['mail-0']});
      assert.equal(result.status,200,JSON.stringify(result.data));
      created[templateId]=result.data.id;
    }
    const preview=await call(`/scenarios/workbenches/${created['graduate-admission']}/mail-preview`,tokens[0]);
    assert.equal(preview.data.emails.some(email=>email.emailId==='camp'),true);
    const linked=await call(`/scenarios/workbenches/${created['graduate-admission']}/sources`,tokens[0],'POST',{mailboxId:'mail-0',emailId:'camp'});
    assert.equal(linked.status,200);
    const plan=await call(`/scenarios/workbenches/${created['graduate-admission']}/items/${linked.data.item.id}/plan`,tokens[0],'POST',{});
    assert.equal(plan.status,200);
    assert.equal(plan.data.materials.length,0);
    assert.equal(plan.data.actions.some(row=>row.title==='核对被覆盖的旧要求' && row.state==='pending'),true);
    const researchItem=await call(`/scenarios/workbenches/${created['research-applications']}/items`,tokens[0],'POST',{title:'导师',fields:{institution:'UCL',timeZone:'Europe/London'}});
    await call(`/scenarios/workbenches/${created['research-applications']}/sources`,tokens[0],'POST',{mailboxId:'mail-0',emailId:'phd',itemId:researchItem.data.id});
    const researchPlan=await call(`/scenarios/workbenches/${created['research-applications']}/items/${researchItem.data.id}/plan`,tokens[0],'POST',{});
    assert.equal(researchPlan.data.interpretation.suggestedStage,'discussion');
    const jobItem=await call(`/scenarios/workbenches/${created['job-applications']}/items`,tokens[0],'POST',{title:'岗位',fields:{company:'甲',position:'开发'}});
    const jobSlot=await call(`/scenarios/workbenches/${created['job-applications']}/items/${jobItem.data.id}/schedule`,tokens[0],'POST',{title:'测评后的面试',localStart:'2026-10-26T09:00',localEnd:'2026-10-26T10:00',timeZone:'Asia/Shanghai'});
    assert.equal((await call(`/scenarios/workbenches/${created['job-applications']}/actions/${jobSlot.data.action.id}/schedule`,tokens[0],'POST',{})).data.written,true);
    const calendar=await call('/state?scope=all',tokens[0]);
    const writtenEvent=calendar.data.events.find(event=>event.scenarioActionId===jobSlot.data.action.id);
    assert.ok(writtenEvent);
    assert.equal((await call(`/events/${writtenEvent.id}`,tokens[0],'DELETE')).status,200);
    const afterDelete=await call('/scenarios',tokens[0]);
    const removed=afterDelete.data.actions.find(row=>row.id===jobSlot.data.action.id);
    assert.equal(removed.localEventStatus,'removed');
    assert.equal(removed.state,'prepared');
    await call(`/scenarios/workbenches/${created['job-applications']}/sources`,tokens[0],'POST',{mailboxId:'mail-0',emailId:'job',itemId:jobItem.data.id});
    const jobPlan=await call(`/scenarios/workbenches/${created['job-applications']}/items/${jobItem.data.id}/plan`,tokens[0],'POST',{});
    const exam=jobPlan.data.actions.find(row=>row.title==='完成测评或笔试');
    assert.equal((await call(`/scenarios/workbenches/${created['job-applications']}/receipts`,tokens[0],'POST',{actionId:exam.id,note:'太早',status:'submitted'})).status,400);
    const confirmed=await call(`/scenarios/workbenches/${created['job-applications']}/actions/${exam.id}/confirm`,tokens[0],'POST',{});
    assert.equal(confirmed.status,200,JSON.stringify(confirmed.data));
    assert.equal((await call(`/scenarios/workbenches/${created['job-applications']}/receipts`,tokens[0],'POST',{actionId:exam.id,note:'平台回执',status:'submitted'})).status,200);
    const done=await call(`/tasks/${confirmed.data.execution.taskId}`,tokens[0],'PUT',{status:'done'});
    assert.equal(done.status,200,JSON.stringify(done.data));
    const listed=await call('/scenarios',tokens[0]);
    const examAction=listed.data.actions.find(row=>row.id===exam.id);
    assert.equal(examAction.localTaskStatus,'done');
    assert.equal(examAction.state,'submitted');
    const paperItem=await call(`/scenarios/workbenches/${created['research-publications']}/items`,tokens[0],'POST',{title:'稿件',fields:{venue:'会议'}});
    await call(`/scenarios/workbenches/${created['research-publications']}/sources`,tokens[0],'POST',{mailboxId:'mail-0',emailId:'paper',itemId:paperItem.data.id});
    const paperPlan=await call(`/scenarios/workbenches/${created['research-publications']}/items/${paperItem.data.id}/plan`,tokens[0],'POST',{});
    assert.equal(paperPlan.status,200);
    const paperGate=paperPlan.data.actions.find(action=>action.title==='共同作者确认');
    const paperSubmit=paperPlan.data.actions.find(action=>action.title==='提交终稿');
    const confirmPaper=()=>call(`/scenarios/workbenches/${created['research-publications']}/actions/${paperSubmit.id}/confirm`,tokens[0],'POST',{});
    assert.equal((await confirmPaper()).status,400);
    assert.equal((await call(`/scenarios/workbenches/${created['research-publications']}/actions/${paperGate.id}/confirm`,tokens[0],'POST',{})).status,200);
    const stillBlocked=await confirmPaper();
    assert.equal(stillBlocked.status,400);
    assert.match(stillBlocked.data.error,/前置行动尚未完成/);
    assert.equal((await call(`/scenarios/workbenches/${created['research-publications']}/receipts`,tokens[0],'POST',{actionId:paperGate.id,status:'confirmed',note:'合成作者确认回执'})).status,200);
    assert.equal((await confirmPaper()).status,200);
    const recruitList=await call('/scenarios',tokens[0]);
    assert.equal(recruitList.data.workbenches.filter(row=>row.template.id==='recruitment').length,1);
    const visibilityPath='/scenarios/navigation/visibility';
    const featureChange={kind:'feature',id:'invoices',visible:false};
    assert.equal((await call(visibilityPath,null,'PATCH',featureChange)).status,401);
    const changes=await Promise.all([made.data.id,created['job-applications']].map(id=>call(visibilityPath,tokens[0],'PATCH',{kind:'workbench',id,visible:false})));
    assert.ok(changes.every(result=>result.status===200));
    const hiddenWorkbenches=await call('/scenarios',tokens[0]);
    assert.deepEqual(hiddenWorkbenches.data.navigation.hiddenWorkbenchIds.slice().sort(),[made.data.id,created['job-applications']].sort());
    const mixed=await Promise.all([
      call(visibilityPath,tokens[0],'PATCH',{kind:'workbench',id:made.data.id,visible:true}),
      call(visibilityPath,tokens[0],'PATCH',{kind:'workbench',id:created['research-applications'],visible:false}),
      call(visibilityPath,tokens[0],'PATCH',featureChange),
    ]);
    assert.ok(mixed.every(result=>result.status===200));
    const afterVisibility=await call('/scenarios',tokens[0]);
    const navigation=afterVisibility.data.navigation;
    assert.deepEqual(navigation.hiddenWorkbenchIds.slice().sort(),[created['job-applications'],created['research-applications']].sort());
    assert.deepEqual(navigation.hiddenFeatureIds,['invoices']);
    assert.deepEqual(afterVisibility.data,{...recruitList.data,navigation});
    assert.deepEqual((await call(visibilityPath,tokens[0],'PATCH',featureChange)).data,navigation);
    for(const invalid of [{...featureChange,visible:'false'},{kind:'feature',id:'invoices'},{...featureChange,extra:true},{...featureChange,id:'unknown'}]) {
      assert.equal((await call(visibilityPath,tokens[0],'PATCH',invalid)).status,400);
    }
    assert.equal((await call(visibilityPath,tokens[1],'PATCH',{kind:'workbench',id:made.data.id,visible:false})).status,400);
    assert.deepEqual((await call('/scenarios',tokens[0])).data.navigation,navigation);
    assert.deepEqual((await call('/scenarios',tokens[1])).data.navigation,{hiddenFeatureIds:[],hiddenWorkbenchIds:[]});
    const hiddenRecruitment=await call(visibilityPath,tokens[0],'PATCH',{kind:'feature',id:'recruitment',visible:false});
    assert.equal(hiddenRecruitment.status,200);
    assert.deepEqual(hiddenRecruitment.data,{...navigation,hiddenFeatureIds:['invoices','recruitment']});
    assert.deepEqual((await call('/scenarios',tokens[0])).data,{...afterVisibility.data,navigation:hiddenRecruitment.data});
    assert.equal((await call('/recruitment',tokens[0])).status,200);
    const invoiceRestored=await call(visibilityPath,tokens[0],'PATCH',{kind:'feature',id:'invoices',visible:true});
    assert.equal(invoiceRestored.status,200);
    assert.deepEqual(invoiceRestored.data,{...navigation,hiddenFeatureIds:['recruitment']});
    assert.deepEqual((await call('/scenarios',tokens[0])).data.navigation,invoiceRestored.data);
    assert.deepEqual((await call('/scenarios',tokens[1])).data,legacy.data);
    const recruitmentRestored=await call(visibilityPath,tokens[0],'PATCH',{kind:'feature',id:'recruitment',visible:true});
    assert.equal(recruitmentRestored.status,200);
    assert.deepEqual(recruitmentRestored.data,{...navigation,hiddenFeatureIds:[]});
    assert.equal(fs.readFileSync(path.join(oldPath,'recruitment.json'),'utf8'),old);
    const deleted=await call(`/scenarios/workbenches/${created['graduate-admission']}`,tokens[0],'DELETE');
    assert.equal(deleted.status,200,JSON.stringify(deleted.data));
    const afterDeleteWb=await call('/scenarios',tokens[0]);
    assert.equal(afterDeleteWb.data.workbenches.some(row=>row.id===created['graduate-admission']),false);
    assert.equal(afterDeleteWb.data.workbenches.some(row=>row.template.id==='recruitment'),true);
    assert.equal(fs.readFileSync(path.join(oldPath,'recruitment.json'),'utf8'),old);
  } finally {
    child.kill('SIGTERM');
    if(child.exitCode===null) await once(child,'exit');
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
