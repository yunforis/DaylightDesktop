export const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const CATEGORIES = {
  work: { label: '工作安排', color: 'var(--cal-work, #3d7a5c)' },
  personal: { label: '生活日常', color: 'var(--cal-personal, #a66b3d)' },
};
export const EMAIL_ACTIONS = { create: '新建', cancel: '取消', reschedule: '调整', keep: '保持' };
export const EMAIL_CATEGORIES = {
  meeting: '会议', task: '任务', notice: '通知', inquiry: '询问', invoice: '发票报销', promo: '推广',
  resume: '求职简历', general: '普通沟通', irrelevant: '无关',
};
export const EMAIL_INTENTS = {
  calendar: '日程', task: '待办', invoice: '发票报销', recruit: '招聘', reply: '需回复', fyi: '仅知晓', noise: '可忽略',
};

export const isCancelled = (event) => event.status === 'cancelled';
export const isDeclined = event => event.attendanceStatus === 'declined';
export const isConflicting = (event) => !isCancelled(event) && !isDeclined(event) && Boolean(event.currentConflictIds?.length || event.hasConflict);

/** 手动新建/编辑时：与现有非全天日程是否时间重叠（全天不参与）。 */
export function findManualConflicts(candidate, existingEvents, excludeId) {
  if (candidate?.allDay) return [];
  const start = Date.parse(candidate.start);
  const end = Date.parse(candidate.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  return (existingEvents || []).filter((other) => {
    if (!other || other.id === excludeId || isCancelled(other) || isDeclined(other) || other.allDay) return false;
    const otherStart = Date.parse(other.start);
    const otherEnd = Date.parse(other.end);
    if (!Number.isFinite(otherStart) || !Number.isFinite(otherEnd)) return false;
    return start < otherEnd && end > otherStart;
  });
}
export const eventStatus = (event) => isDeclined(event) ? '不参加' : isCancelled(event)
  ? (event.cancellationType === 'reschedule' ? '已调整' : '已取消')
  : (event.previousEventId ? '调整后' : '');
export const realMailSource = (email) => email.mailboxEmail || '真实邮箱';
export const createdIds = (email) => email.createdEventIds || (email.status === 'imported' ? email.eventIds || [] : []);
export const affectedIds = (email) => [...(email.cancelledEventIds || []), ...(email.rescheduledEventIds || [])];

export function syncChanges(result) {
  return [
    result.added && `新增 ${result.added} 项日程`,
    result.cancelled && `取消 ${result.cancelled} 项`,
    result.rescheduled && `调整 ${result.rescheduled} 项`,
    result.tasksAdded && `新增 ${result.tasksAdded} 项待办`,
    result.tasksMerged && `合并 ${result.tasksMerged} 项待办`,
    result.invoices && `提取 ${result.invoices} 张发票`,
    result.conflicts && `${result.conflicts} 项冲突待确认`,
    result.filtered && `过滤跳过 ${result.filtered} 封`,
  ].filter(Boolean).join('，');
}

export function emailResult(email) {
  if ((email.category || email.extraction?.category) === 'invoice') {
    const count = email.extraction?.invoices?.length || 0;
    if (email.invoiceStatus === 'partial') return count ? `${count} 张发票 · 部分待重试` : '发票待重试';
    if (email.invoiceStatus === 'failed') return count ? `${count} 张发票 · 提取失败` : '发票提取失败';
    if (count) return `${count} 张发票`;
    return email.invoiceStatus === 'empty' ? '未识别到发票' : '发票待提取';
  }
  const rescheduled = email.rescheduledEventIds?.length || 0;
  const cancelled = email.cancelledEventIds?.length || 0;
  const added = Math.max(0, createdIds(email).length - rescheduled);
  const tasksAdded = email.createdTaskIds?.length || 0;
  const tasksMerged = (email.mergedTaskIds || email.duplicateTaskIds)?.length || 0;
  const conflicts = email.conflicts?.length || 0;
  return [
    conflicts && `${conflicts} 项冲突`,
    added && `新建 ${added}`,
    cancelled && `取消 ${cancelled}`,
    rescheduled && `调整 ${rescheduled}`,
    tasksAdded && `待办 ${tasksAdded}`,
    tasksMerged && `合并待办 ${tasksMerged}`,
  ].filter(Boolean).join(' · ')
    || (email.status === 'needs_match' ? '待选择原日程'
      : email.status === 'filtered' ? `已过滤${email.filterRuleName ? ` · ${email.filterRuleName}` : ''}`
        : email.extraction?.category ? '已分类'
          : email.status === 'skipped' ? '已跳过' : '已处理');
}

export function withConflicts(events) {
  return (events || []).map((event, _, list) => {
    const currentConflictIds = isCancelled(event) || event.allDay ? [] : list.filter((other) =>
      other.id !== event.id && !isCancelled(other) && !other.allDay
      && (other.source === 'demo') === (event.source === 'demo')
      && Date.parse(event.start) < Date.parse(other.end)
      && Date.parse(other.start) < Date.parse(event.end)).map((other) => other.id);
    return { ...event, currentConflictIds };
  });
}
