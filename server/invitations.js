import addressparser from 'nodemailer/lib/addressparser/index.js';
import { createHash } from 'node:crypto';
import { readSettings, saveSettings, readStore, saveStore } from './store.js';
import { createAssistantDraft, getAssistantDraft, discardAssistantDraft, listAssistantDrafts } from './assistant-actions.js';

import { normalizeInvitationPreferences } from './invitations-preferences.js';
export { DEFAULT_INVITATION_PREFERENCES, normalizeInvitationPreferences } from './invitations-preferences.js';
export function invitationEvents(store, email) {
  const ids = email.createdEventIds || (email.status === 'imported' ? email.eventIds || [] : []);
  return (store.events || []).filter(event => ids.includes(event.id) && event.status !== 'cancelled' && Date.parse(event.end) > Date.now());
}
export function attendanceReply(settings, decision, events) {
  const prefs = normalizeInvitationPreferences(settings.invitationPreferences);
  const template = decision === 'accepted' ? prefs.acceptedTemplate : prefs.declinedTemplate;
  const format = value => new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));
  return events.map(event => template.replace(/\{(title|time|location)\}/g,(_,key) => ({title:event.title,time:event.allDay ? `${format(event.start)}（全天）` : `${format(event.start)} – ${format(event.end)}`,location:event.location || '未注明'})[key])).join('\n\n');
}
const fail = (message,status=409) => {throw Object.assign(new Error(message),{status});};
const locks = new Set();
// This endpoint records intention and prepares a durable draft. SMTP is only invoked
// through the existing revision-checked assistant draft send endpoint after review.
export async function decideInvitation(emailId, decision, dependencies = {}) {
  const {getSettings=readSettings, read=readStore, save=saveStore, createDraft=createAssistantDraft, getDraft=getAssistantDraft, discardDraft=discardAssistantDraft}=dependencies;
  if(!['accepted','declined','pending'].includes(decision)) fail('请选择参加、不参加或撤销。',400);
  const settings=getSettings(), mailboxId=settings.activeMailboxId;
  const lock=`${mailboxId}:${emailId}`;
  if(locks.has(lock)) fail('这份邀请正在保存，请稍后再试。');
  locks.add(lock);
  try {
    let store=read(mailboxId), email=store.emails.find(row=>row.id===emailId);
    if(!email) fail('邀请不存在或不属于当前邮箱。',404);
    const events=invitationEvents(store,email);
    if(!events.length) fail('邀请已经结束、取消或没有有效日程，请刷新。');
    const previous=email.attendance;
    let priorDraft=null;
    if(previous?.draftId) priorDraft=(await getDraft(mailboxId,previous.draftId)).draft;
    if(previous?.decision===decision) return {...email,...(priorDraft ? {draft:priorDraft}: {})};
    if(['sent','sending','unknown'].includes(priorDraft?.status) || ['sent','sending','unknown'].includes(previous?.delivery?.status)) fail('回信已发送或结果待核对，无法撤销或更改；请先核对发件邮箱。');
    if(priorDraft && priorDraft.status!=='discarded') await discardDraft(mailboxId,priorDraft.id,{revision:priorDraft.revision});
    const attendance={decision,decidedAt:new Date().toISOString(),operationId:createHash('sha256').update(`${mailboxId}:${emailId}:${previous?.operationId || 'initial'}:${decision}`).digest('hex'),delivery:{status:email.mode==='demo'?'demo':'not_sent'}};
    // Persist before the async draft creation. A retry reuses operationId and cannot send mail.
    email.attendance=attendance;
    for(const event of events) event.attendanceStatus=decision;
    save(store,mailboxId);
    let draft;
    if(decision!=='pending' && email.mode==='qq' && normalizeInvitationPreferences(settings.invitationPreferences).autoReply) {
      const to=[email.replyTo,email.senderAddress,email.sender].flatMap(value=>addressparser(value||'',{flatten:true})).find(value=>value.address?.includes('@'))?.address;
      if(!to) { attendance.delivery={status:'not_sent',error:'原邮件没有有效回复地址，已记录意愿。'}; }
      else {
        try {
          ({draft}=await createDraft(mailboxId,{to:[to],subject:`Re: ${email.subject || '活动邀请'}`.replace(/[\r\n\0]/g,' ').slice(0,300),body:attendanceReply(settings,decision,events),operationKey:`invitation:${emailId}:${attendance.operationId}`},settings));
          attendance.draftId=draft.id;attendance.delivery={status:draft.status};
        } catch { attendance.delivery={status:'not_sent',error:'意愿已保存，回复草稿未能生成，请通过小 D 起草回复。'}; }
      }
      store=read(mailboxId);email=store.emails.find(row=>row.id===emailId);
      if(email?.attendance?.operationId===attendance.operationId) {email.attendance=attendance;save(store,mailboxId);}
    }
    return {...email,...(draft ? {draft}: {})};
  } finally {locks.delete(lock);}
}
export async function invitationStates() {
  const settings=readSettings(), store=readStore(settings.activeMailboxId);
  const decided=(store.emails||[]).filter(email=>email.attendance);
  if(!decided.some(email=>email.attendance.draftId)) return Object.fromEntries(decided.map(email=>[email.id,email.attendance]));
  const {drafts}=await listAssistantDrafts(settings.activeMailboxId);
  return Object.fromEntries(decided.map(email=>{const draft=drafts.find(row=>row.id===email.attendance.draftId);return [email.id,{...email.attendance,...(draft ? {delivery:{status:draft.status,error:draft.error,canRetry:draft.canRetry}} : {})}];}));
}
export function saveInvitationPreferences(value) {
  const invitationPreferences=normalizeInvitationPreferences(value);
  saveSettings({...readSettings(),invitationPreferences});return invitationPreferences;
}
