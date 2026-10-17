# 外部日历持久任务接线

`queueExternalSync` 在 storage snapshot 内只 stage `app_settings` 的 `external-sync:<mailboxId>` 文档；调用方必须把日程与意图放在同一次 `commitStorage` 中。开发文件模式继续使用原同步流程。`readCalendarSync()` 读取已有 `settings:default.calendarSync`，不需要新增 calendarSync 配置文档。

服务入口需接入以下函数（本模块不自行启动定时器）：

```js
import { createCalendarHandler, scheduleExternalCalendars } from './calendar-job.js';

// 注册到已有 JobWorker handlers。
handlers['calendar.sync'] = createCalendarHandler(jobs);

// 在调度器循环内调用；多个调度副本可并行调用。
await scheduleExternalCalendars(jobs);
```

调度器扫描已提交的 pending 意图，在一个短事务中创建 `daylight_jobs`、`daylight_job_outbox` 并更新 scheduled 标记。幂等键为 `calendar:<intentId>`。业务提交成功但调度器未运行时，意图保留，后续扫描可恢复。业务提交和调度是两个事务；业务事务内的意图文档承担 durable outbox。

worker 每次调用远端前提交 sending 检查点，调用后在新事务中保存远端 ID、连接令牌更新、执行结果和现有日程的 externalIds。两次写入均通过 `lockLease` fencing。网络调用期间无数据库事务或连接占用。删除本地日程后，远端 ID 仍保存在意图文档 targets 中。日程更新使用固定 ID PATCH，删除使用固定 ID DELETE，失败可重试；已成功的 target 不重复调用。

创建调用失败、回执丢失、发送后进程退出或 lease 丢失，都保留 unknown 或 sending，恢复时转为 unknown；同一日程/连接的后续意图也禁止再次创建。未知结果不会盲重试。CalDAV 412 不当作创建成功。

业务写入口使用 `saveCalendarWithExternalSync(store, mailboxId)`，显式比较 title/start/end/allDay/location/description/取消状态。邮件 snapshot 适配器在 checkpoint 提交前暂存，场景确认/改期在 `mutateScenarioData` 内暂存，助手和招聘日程在原 snapshot 提交内暂存。回执仍调用原始 `saveStore`，不反向生成意图。重复保存、workbench 元数据变更和 externalIds 回写不生成新意图；保留已有 externalIds；遵守连接开关和 requireConfirm，支持非活动自有邮箱。文件模式沿用原有行为。

人工恢复 service：认证且已建立 snapshot 的 API 可调用 `await reconcileUnknownCalendarResult(mailboxId, intentId, { confirmed: true, connectionId, outcome: 'found', remoteId, note })`，随后 `await commitStorage()` 成功后才返回。`found` 通过远端 GET 验证 ID/资源有效，CalDAV 限定配置的同源集合且不跟随重定向；用户须核对所选日程的业务归属。`outcome: 'absent'` 依据用户明确核验说明关闭当前尝试，不请求远端、不自动重发，并保留目标屏障，禁止已有后续意图变成自动创建。两种结果均保存 actorId/时间/说明和本地身份映射，不创建或重置 jobs。并发变化由 snapshot CAS 拒绝。仅接受 unknown 回执；sending 需先由带 fencing 的 worker 归一化。

还需主服务整合的路径：

- `index.js` 的直接 `syncEventExternal` 批量推送和连接探测仍是原同步入口；生产业务推送应改用持久意图并返回排队回执，连接探测需明确保留独立探测语义。
- 人工核验 service 的 HTTP 路由及 UI、人工确认不存在后的独立重新创建流程、意图/targets 保留清理和任务 UI 错误解释仍需主服务接线。
- 场景原有 supersede 只撤销 pending 行动，没有取消已确认日程的独立业务入口；改期的旧日程取消已同事务接入。若增加独立取消入口，应调用上述业务 writer。

本地模拟验证：`node --test server/calendar-job.test.js server/capability-loop.test.js`（Node 22+）。未连接真实外部日历；数据库驱动测试使用内存事务模型，不能替代真实 PG 多副本验收。

2026-10-17 增量定向验证：Node 22.23.3，`node --test server/calendar-job.test.js server/mail-job.test.js server/assistant-meetings.test.js server/recruitment.test.js server/scenarios.test.js`。新增覆盖场景 callback/数据库失败回滚、邮件 supplied-client checkpoint 回滚及重放、重复保存、改期取消与新建、非活动邮箱和确认开关、unknown 人工核验回滚及禁止重发。均为受控模拟。
