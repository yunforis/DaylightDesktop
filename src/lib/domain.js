export const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const CATEGORIES = {
  work: { label: '工作安排', color: 'var(--cal-work, #3d7a5c)' },
  personal: { label: '生活日常', color: 'var(--cal-personal, #a66b3d)' },
};
export const EMAIL_ACTIONS = { create: '新建', cancel: '取消', reschedule: '调整' };
export const EMAIL_CATEGORIES = {
  meeting: '会议', task: '任务', notice: '通知', inquiry: '询问', invoice: '报销', promo: '推广',
  resume: '求职简历',
};

export const isCancelled = (event) => event.status === 'cancelled';
export const isConflicting = (event) => !isCancelled(event) && Boolean(event.currentConflictIds?.length || event.hasConflict);
export const eventStatus = (event) => isCancelled(event)
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
    result.conflicts && `${result.conflicts} 项冲突待确认`,
    result.filtered && `过滤跳过 ${result.filtered} 封`,
  ].filter(Boolean).join('，');
}

export function emailResult(email) {
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
    || (email.status === 'filtered' ? `已过滤${email.filterRuleName ? ` · ${email.filterRuleName}` : ''}`
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
