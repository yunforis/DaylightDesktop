import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
fs.mkdirSync(new URL('../work/',import.meta.url),{recursive:true});
process.env.DAYLIGHT_DATA_DIR=fs.mkdtempSync(new URL('../work/invitations-test-',import.meta.url));
const {decideInvitation,normalizeInvitationPreferences}=await import('./invitations.js');
const {findConflicts}=await import('./conflicts.js');
const {mobileCors}=await import('./mobile-cors.js');
const {importEmail}=await import('./agent.js');
function fixture({mode='qq',autoReply=false}={}) {
 const store={events:[{id:'event',title:'讨论',start:new Date(Date.now()+86400000).toISOString(),end:new Date(Date.now()+90000000).toISOString()}],emails:[{id:'mail',sender:'team@example.invalid',subject:'邀请',mode,createdEventIds:['event']}]};
 let draftCalls=0;const drafts=new Map();
 const dependencies={getSettings:()=>({activeMailboxId:'mine',invitationPreferences:{autoReply}}),read:()=>structuredClone(store),save:value=>Object.assign(store,structuredClone(value)),
 createDraft:async(_id,input)=>{draftCalls++;const draft={id:'draft',status:'pending',revision:1,...input};drafts.set('draft',draft);return {draft};},
 getDraft:async(_id,id)=>({draft:drafts.get(id)}),discardDraft:async()=>{drafts.get('draft').status='discarded';}};
 return {store,drafts,dependencies,calls:()=>draftCalls};
}
test('default records intention without preparing or sending mail; reversal restores pending',async()=>{
 const f=fixture();await decideInvitation('mail','declined',f.dependencies);assert.equal(f.calls(),0);assert.equal(f.store.events[0].attendanceStatus,'declined');
 await decideInvitation('mail','pending',f.dependencies);assert.equal(f.store.emails[0].attendance.decision,'pending');
});
test('opt-in prepares one reviewable draft; duplicate decisions reuse it; no SMTP dependency',async()=>{
 const f=fixture({autoReply:true});const result=await decideInvitation('mail','accepted',f.dependencies);
 assert.equal(result.draft.to[0],'team@example.invalid');assert.match(result.draft.body,/讨论/);assert.equal(result.draft.status,'pending');
 await decideInvitation('mail','accepted',f.dependencies);assert.equal(f.calls(),1);
 f.drafts.get('draft').status='unknown';await assert.rejects(decideInvitation('mail','pending',f.dependencies),/无法撤销/);
 f.drafts.get('draft').status='sent';await assert.rejects(decideInvitation('mail','declined',f.dependencies),/无法撤销/);
});
test('demo never creates real reply drafts; foreign/expired invitations rejected',async()=>{
 const f=fixture({mode:'demo',autoReply:true});await decideInvitation('mail','accepted',f.dependencies);assert.equal(f.calls(),0);
 await assert.rejects(decideInvitation('foreign','accepted',f.dependencies),error=>error.status===404);
 f.store.events[0].end='2020-01-01';await assert.rejects(decideInvitation('mail','accepted',f.dependencies),/结束/);
});
test('declined invitations do not block conflict time; preference values normalized',()=>{
 const event={start:'2027-01-01T10:00:00+08:00',end:'2027-01-01T11:00:00+08:00'};
 assert.equal(findConflicts(event,[{...event,attendanceStatus:'declined'}]).length,0);
 assert.equal(normalizeInvitationPreferences(null).autoReply,false);
});
test('native CORS answers approved preflight without granting arbitrary sites access',()=>{
 for(const [origin,expected] of [['capacitor://localhost',true],['https://evil.invalid',false]]) {
  const headers={};let ended=false,next=false;
  const res={setHeader:(k,v)=>headers[k]=v,vary:()=>{},status:()=>res,end:()=>ended=true};
  mobileCors()({method:'OPTIONS',get:()=>origin},res,()=>next=true);
  assert.equal(ended,expected);assert.equal(next,!expected);assert.equal(headers['Access-Control-Allow-Origin'],expected?origin:undefined);
 }
});


test('declining frees conflict time but preserves the original as a cancellation/reschedule target',()=>{
 const original={id:'declined-original',title:'合成讨论',start:'2027-01-02T10:00:00+08:00',end:'2027-01-02T11:00:00+08:00',allDay:false,category:'work',source:'email',attendanceStatus:'declined'};
 const store={events:[original],emails:[],tasks:[],lastSync:null};
 const record=importEmail(store,{id:'qq:rescheduled-invitation',subject:'合成讨论改期',sender:'team@example.invalid'},
  {category:'meeting',intent:'calendar',summary:'改期通知',events:[{action:'reschedule',targetEventId:original.id,title:'合成讨论',start:'2027-01-03T10:00:00+08:00',end:'2027-01-03T11:00:00+08:00',allDay:false,category:'work',reason:'对方调整时间'}]},'qq');
 assert.equal(original.status,'cancelled');assert.equal(record.pendingActions?.length||0,0);
 const replacement=store.events.find(row=>row.previousEventId===original.id);assert.ok(replacement);assert.equal(replacement.attendanceStatus,undefined,'new time requires a new attendance decision');
 assert.equal(original.replacementEventId,replacement.id);
});
