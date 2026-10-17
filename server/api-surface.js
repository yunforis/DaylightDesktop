/**
 * Production API surface.
 *
 * `DAYLIGHT_RUNTIME=production` refuses every `/api` path that has not been moved onto
 * shared storage. A feature that is implemented but missing from `PRODUCTION_AREAS` is
 * therefore *unreachable in production*: it answers `503 WORKFLOW_NOT_MIGRATED` instead of
 * working. That refusal is deliberate and visible (never a silent fallback to local files),
 * but it is easy to forget when new routes land — which is exactly how the mailbox
 * knowledge base, the invitation replies, the private calendar feed and the two
 * `emails/:id` workflows ended up implemented but dead in production.
 *
 * So the classification lives here, one entry per top-level area with the reason it is
 * production-ready, and `server/api-surface.test.js` checks that *every* route registered
 * on the app is a deliberate decision rather than an oversight.
 *
 * Paths are relative to the `/api` mount point, e.g. `/rag/ask`, `/calendar.ics`.
 */

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `name` matches `/name` and `/name/...`; `name$` matches `/name` only. */
function matcher(entry) {
  const exact = entry.endsWith('$');
  const name = exact ? entry.slice(0, -1) : entry;
  return new RegExp(`^/${escapeRegExp(name)}${exact ? '$' : '(?:/|$)'}`);
}

/** Areas served from shared storage (PostgreSQL snapshots/auxiliary schema + Redis + S3). */
export const PRODUCTION_AREAS = new Map([
  ['auth', '认证与会话：PostgreSQL 用户表 + Redis 验证码/会话版本'],
  ['state$', '业务快照读取：mailbox_calendars + app_settings'],
  ['settings$', '设置读写：app_settings，按用户覆盖合并'],
  ['mailboxes', '邮箱列表与切换：app_settings.mailboxes + 任务入队'],
  ['scenarios', '场景工作台：共享存储快照'],
  ['jobs', '任务平台：daylight_jobs + 租约、心跳与幂等键'],
  ['sync', '手动同步入口：入队 mailbox.sync 由 worker 执行'],
  ['tasks', '待办读写：共享存储快照 + 证据核对'],
  ['events', '日程读写：共享存储快照 + 外部日历 outbox'],
  ['traces', '处理日志：settings:traces:<mailboxId> 快照文档'],
  ['recruitment', '招聘链路：recruitment:<mailboxId> 快照文档 + OSS 附件'],
  ['assistant', '小 D：共享存储快照上的工具调用与审核草稿'],
  ['calendar-sync', '外部日历连接、订阅与导出 outbox'],
  ['infra/public$', '登录页所需的非敏感基础设施状态'],
  ['material-kinds$', '材料类型枚举，纯静态数据'],
  ['rag', '邮箱知识库：在建 rag_chunks 辅助表 + PostgreSQL 分块存储'],
  ['invitations', '邀请意愿：邮件快照上的 attendance + 审核草稿'],
  ['invitation-preferences$', '回信模板偏好：app_settings'],
  ['emails', '邮件级重跑入口（发票提取、取消/改期目标确认），全部在共享存储快照内'],
  ['calendar.ics$', '私密日历订阅：Redis 令牌 + 共享存储日程快照'],
]);

/** Areas that intentionally still run on the legacy local-file path. */
export const LEGACY_AREAS = new Map([
  ['admin', '管理端：本地用户、邮件模板与基础设施探测文件'],
  ['backup', '备份与恢复：本地备份文件'],
  ['calendar-categories', '日程分类：本地分类文件'],
  ['demo', '示例数据导入：只操作本地演示数据'],
  ['infra', '基础设施重载入口；只有 /infra/public 在生产开放'],
  ['mail-filters', '邮件过滤规则：本地文件'],
  ['onboarding', '新手引导进度：本地文件'],
  ['persistence', '本地持久化方式切换'],
  ['prompts', '提示词文件'],
  ['report-prompts', '报告提示词文件与预设'],
  ['test', '遗留的模型/邮箱连通性测试入口，生产由真实同步替代'],
]);

function firstMatch(areas, path) {
  for (const [entry, reason] of areas) {
    if (matcher(entry).test(path)) return { area: entry.replace(/\$$/, ''), reason };
  }
  return null;
}

/** 旧版直接发信入口：路径已迁移，但发信必须走助手的审核发送流程。 */
const LEGACY_WORKFLOW = /^\/traces\/[^/]+\/send$/;

/**
 * 把 `req.path`（相对 `/api`）判成生产可服务、刻意保留的旧流程，或谁都没有表态的路径。
 * `unclassified` 是缺陷信号：新路由没有登记，生产会 503 且没人知道为什么。
 */
export function classifyApiPath(path) {
  const value = String(path || '');
  if (LEGACY_WORKFLOW.test(value)) {
    return { status: 'legacy_workflow', area: 'traces', reason: '旧版直接发信入口，请使用助手的审核发送流程' };
  }
  const production = firstMatch(PRODUCTION_AREAS, value);
  if (production) return { status: 'production', ...production };
  const legacy = firstMatch(LEGACY_AREAS, value);
  if (legacy) return { status: 'legacy', ...legacy };
  return { status: 'unclassified', area: null, reason: '' };
}

export function isProductionApiPath(path) {
  return classifyApiPath(path).status === 'production';
}
