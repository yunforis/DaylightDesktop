import { dateOffset } from './store.js';

export function exampleEmails() {
  const d1 = dateOffset(1);
  const d2 = dateOffset(3);
  const d3 = dateOffset(5);
  return [
    {
      id: 'demo:design-review', subject: '邀请｜Daylight 产品设计评审', sender: '林晓 <design@example.com>',
      receivedAt: `${dateOffset(0)}T08:40:00+08:00`,
      body: `你好，邀请你参加 Daylight 产品设计评审。\n时间：${d1} 14:00–15:30（北京时间）\n地点：腾讯会议，会议号 883 204 110\n我们一起过一下首页和日历页面的设计，记得带上最新稿件。\n林晓`,
      summary: `邀请参加 ${d1} 14:00–15:30 的 Daylight 产品设计评审，使用腾讯会议，需携带最新稿件。`,
      category: 'meeting', priority: 'high', tasks: [],
      events: [{ title: 'Daylight 产品设计评审', start: `${d1}T14:00:00+08:00`, end: `${d1}T15:30:00+08:00`,
        allDay: false, category: 'work', location: '腾讯会议 · 883 204 110', description: '评审首页和日历页面设计，携带最新稿件。' }],
    },
    {
      id: 'demo:coffee', subject: '一起喝杯咖啡？', sender: '陈可 <chenke@example.com>',
      receivedAt: `${dateOffset(0)}T10:15:00+08:00`,
      body: `嘿，好久不见！\n我们定在 ${d2} 下午 16:00 到 17:00，在「好天气咖啡」碰面吧。\n聊聊近况，顺便看看你正在做的小项目。到时见！`,
      summary: `陈可约定 ${d2} 16:00–17:00 在好天气咖啡见面，交流近况和正在做的小项目。`,
      category: 'meeting', priority: 'normal', tasks: [],
      events: [{ title: '和陈可喝咖啡', start: `${d2}T16:00:00+08:00`, end: `${d2}T17:00:00+08:00`,
        allDay: false, category: 'personal', location: '好天气咖啡', description: '与陈可见面，聊近况和正在做的小项目。' }],
    },
    {
      id: 'demo:workshop', subject: '报名成功：AI 产品共创工作坊', sender: '共创社区 <hello@example.com>',
      receivedAt: `${dateOffset(0)}T11:20:00+08:00`,
      body: `你的报名已确认！\n活动：AI 产品共创工作坊\n日期：${d3}\n时间：10:00–12:00（北京时间）\n地点：创意园 B 栋 203\n请带上电脑，提前 10 分钟到场。`,
      summary: `AI 产品共创工作坊报名成功，${d3} 10:00–12:00 在创意园 B 栋 203 举行，需携带电脑并提前到场。`,
      category: 'meeting', priority: 'normal', tasks: [],
      events: [{ title: 'AI 产品共创工作坊', start: `${d3}T10:00:00+08:00`, end: `${d3}T12:00:00+08:00`,
        allDay: false, category: 'work', location: '创意园 B 栋 203', description: '携带电脑，提前 10 分钟到场。' }],
    },
    {
      id: 'demo:newsletter', subject: '本周灵感速递 · 好设计值得收藏', sender: '设计周刊 <weekly@example.com>',
      receivedAt: `${dateOffset(0)}T12:00:00+08:00`,
      body: '本周我们整理了五个有趣的设计案例，以及一些值得收藏的配色。祝你拥有充满灵感的一周！', events: [],
      summary: '设计周刊分享设计案例和配色资讯，没有需要参加或处理的具体日程。',
      category: 'promo', priority: 'low', tasks: [],
    },
  ];
}

export function exampleChanges(events) {
  const review = events.find((event) => event.source === 'demo' && event.emailId === 'demo:design-review');
  const coffee = events.find((event) => event.source === 'demo' && event.emailId === 'demo:coffee');
  if (!review || !coffee) throw new Error('请先导入示例邮件，再演示取消与调整；如已删除相关示例日程，可在设置中清除示例数据后重新导入。');
  const newDay = dateOffset(2);
  return [
    {
      id: 'demo:coffee-cancel', subject: '取消｜和陈可喝咖啡', sender: '陈可 <chenke@example.com>',
      receivedAt: `${dateOffset(0)}T13:00:00+08:00`,
      body: `抱歉，原定 ${coffee.start.slice(0, 10)} 16:00–17:00 在「好天气咖啡」的见面取消。\n临时需要出差，这次不用前往，之后有空再约。`,
      summary: `陈可因临时出差，取消 ${coffee.start.slice(0, 10)} 在好天气咖啡的见面，无需前往。`,
      category: 'meeting', priority: 'low', tasks: [],
      events: [{ action: 'cancel', targetEventId: coffee.id, reason: '陈可临时出差，本次咖啡见面取消。' }],
    },
    {
      id: 'demo:design-review-reschedule', subject: '调整｜Daylight 产品设计评审', sender: '林晓 <design@example.com>',
      receivedAt: `${dateOffset(0)}T13:30:00+08:00`,
      body: `Daylight 产品设计评审有调整。\n原安排：${review.start.slice(0, 10)} 14:00–15:30，腾讯会议 883 204 110。\n新安排：${newDay} 10:00–11:30（北京时间），地点改为创意园 A 栋 302。\n原时间的会议取消，请以这封邮件为准。仍请携带最新设计稿。`,
      summary: `Daylight 产品设计评审调整为 ${newDay} 10:00–11:30，地点改为创意园 A 栋 302，仍需携带最新设计稿。`,
      category: 'meeting', priority: 'normal', tasks: [],
      events: [{ action: 'reschedule', targetEventId: review.id, reason: '评审时间及地点调整，请以新安排为准。',
        title: review.title, start: `${newDay}T10:00:00+08:00`, end: `${newDay}T11:30:00+08:00`,
        allDay: false, category: review.category, location: '创意园 A 栋 302', description: '评审首页和日历页面设计，携带最新稿件。' }],
    },
  ];
}

// Two preset invitations demonstrate a saved arrangement followed by a conflicting invitation.
export function exampleConflicts() {
  const day = dateOffset(1);
  return [
    {
      id: 'demo:conflict-busy', subject: '示例安排｜项目进度沟通', sender: '项目组 <team@example.com>',
      receivedAt: `${dateOffset(0)}T14:00:00+08:00`,
      body: `邀请你参加项目进度沟通。\n时间：${day} 09:00–10:00（北京时间）\n地点：会议室 A。`,
      summary: `项目进度沟通安排在 ${day} 09:00–10:00，会议室 A。`,
      category: 'meeting', priority: 'high', tasks: [],
      events: [{ title: '项目进度沟通', start: `${day}T09:00:00+08:00`, end: `${day}T10:00:00+08:00`,
        allDay: false, category: 'work', location: '会议室 A', description: '预置示例：作为日历中的已有安排。' }],
    },
    {
      id: 'demo:conflict-invite', subject: '冲突邀请｜新功能讨论', sender: '林晓 <design@example.com>',
      receivedAt: `${dateOffset(0)}T14:05:00+08:00`,
      body: `你好，邀请你参加新功能讨论。\n时间：${day} 09:30–10:30（北京时间）\n地点：腾讯会议。\n如果时间不方便，请提供其他可行的时段。`,
      summary: `邀请参加 ${day} 09:30–10:30 的新功能讨论，时间不方便时请回复其他时段。`,
      category: 'meeting', priority: 'high', tasks: [],
      events: [{ title: '新功能讨论', start: `${day}T09:30:00+08:00`, end: `${day}T10:30:00+08:00`,
        allDay: false, category: 'work', location: '腾讯会议', description: '预置示例：与项目进度沟通发生时间冲突。' }],
    },
  ];
}

// Preset extraction for the demo; this does not call the model or read a real mailbox.
export function exampleTasks() {
  const sentDay = dateOffset(0);
  return [
    {
      id: 'demo:report-task', subject: '待办｜周五前提交项目报告', sender: '项目组 <team@example.com>',
      receivedAt: `${sentDay}T08:00:00+08:00`,
      body: '请在本周五前提交 Daylight 项目报告，包含本周进展、风险和下周计划。发到项目组即可，不需要开会。',
      summary: '请在本周五前提交 Daylight 项目报告，涵盖进展、风险和下周计划。',
      category: 'task', priority: 'normal', events: [],
      tasks: [{ title: '提交 Daylight 项目报告', description: '包含本周进展、风险和下周计划，发送给项目组。', deadlineText: '本周五前' }],
    },
    {
      id: 'demo:report-reminder', subject: '提醒｜项目报告仍在周五前提交', sender: '项目组 <team@example.com>',
      receivedAt: `${sentDay}T09:00:00+08:00`,
      body: '提醒一下：Daylight 项目报告仍请在本周五前提交，与上一封邮件是同一份报告，不用另写一份。',
      summary: '再次提醒本周五前提交同一份 Daylight 项目报告，没有新增工作。',
      category: 'task', priority: 'normal', events: [],
      tasks: [{ title: '提交 Daylight 项目报告', deadlineText: '本周五前' }],
    },
    {
      id: 'demo:reply-task', subject: '请回复｜确认演示方案', sender: '林晓 <design@example.com>',
      receivedAt: `${sentDay}T10:00:00+08:00`,
      body: '你觉得当前 Daylight 演示方案可以吗？请在明天中午 12:00 前回复是否采用，方便我们继续准备。',
      summary: '林晓询问是否采用当前演示方案，需要在明天中午 12:00 前回复。',
      category: 'inquiry', priority: 'high', events: [],
      tasks: [{ title: '回复并确认演示方案', description: '确认是否采用当前 Daylight 演示方案。', deadlineText: '明天中午12:00前', dueAt: `${dateOffset(1)}T12:00:00+08:00` }],
    },
    {
      id: 'demo:invoice-task', subject: '发票｜工作坊费用待报销', sender: '共创社区 <billing@example.com>',
      receivedAt: `${sentDay}T11:00:00+08:00`,
      body: '工作坊费用电子发票已开具，请在下周一前提交报销申请。本示例仅演示邮件正文，不读取附件。',
      summary: '工作坊发票已开具，请在下周一前提交报销申请。',
      category: 'invoice', priority: 'normal', events: [],
      tasks: [{ title: '提交工作坊费用报销申请', description: '按邮件中的发票信息准备报销。', deadlineText: '下周一前' }],
    },
    {
      id: 'demo:notice-tag', subject: '通知｜演示环境维护完成', sender: '运维组 <ops@example.com>',
      receivedAt: `${sentDay}T12:00:00+08:00`,
      body: '演示环境维护已经完成，服务恢复正常。仅供知晓，无需回复或执行任何操作。',
      summary: '演示环境维护完成、服务恢复正常，仅需知晓。',
      category: 'notice', priority: 'low', events: [], tasks: [],
    },
    {
      id: 'demo:promo-tag', subject: '推广｜设计工具优惠资讯', sender: '设计资讯 <promo@example.com>',
      receivedAt: `${sentDay}T13:00:00+08:00`,
      body: '本周设计工具限时优惠，欢迎浏览我们的推荐。这是一封推广邮件，无需回复。',
      summary: '设计工具优惠推广，无需回复或行动。',
      category: 'promo', priority: 'low', events: [], tasks: [],
    },
  ];
}
