# 核心共享存储接口

实现范围：`store.js` 的 settings/calendar/calendarSync 与 scenarios repository。
`DAYLIGHT_RUNTIME=production` 强制快照上下文，无上下文返回 503；不读取、导入或双写 JSON。
本地默认模式继续同步 JSON；需要 PG 时显式使用以下 wrapper（local 下也可以使用）。
旧 hydrate 入口仅返回 explicit-migration-required/local-json-mode，不再双向回灌。

## 部署前置

部署迁移先创建现有 `app_settings/mailbox_calendars`，再执行 `STORAGE_SCHEMA`（从 `schema.js` 或 `index.js` 导出）：两表增加 `version BIGINT NOT NULL DEFAULT 1`，可重复执行。
迁移任务负责导入 `app_settings.id='default'` 的完整原始配置、日历与场景；请求路径不执行 DDL 或文件迁移。
settings 缺失返回 `STORAGE_SETTINGS_MISSING`，不创建默认配置。缺失的已归属邮箱日历和场景是空快照，首次显式修改通过 INSERT CAS 创建，不载入示例。

**所有旧 PG 写入方也必须接入版本协议。** 旧 infra upsert、assistant meeting 的直接 SQL 等若不递增版本，可绕过 CAS；本模块不能保证这类旁路的并发一致性。schema 迁移与所有调用方集成完成前不能声明全系统生产就绪。

## HTTP 接入

```js
import { withStorageCommit, readSettings, readStore, saveStore } from '../store.js';

// 认证后调用；req.user 必须来自服务器认证，不能来自客户端传入的 owner 字段。
const result = await withStorageCommit({
  userId: req.user.id,
  user: req.user,
  // 缺省加载全部自有邮箱，支持场景跨邮箱同步 readStore。
  // 指定此列表可减少加载，但未加载的 readStore 会报错，不回退文件。
  mailboxIds: [mailboxId],
}, async () => {
  const settings = readSettings(); // 同步，保留 owner 过滤和 userPrefs 视图
  const calendar = readStore(mailboxId); // 同步返回独立副本
  // 这里可以 await 网络调用：加载连接已释放，没有行锁/事务。
  calendar.tasks.push(task);
  saveStore(calendar, mailboxId); // 只暂存；不是持久化确认
  return { ok: true };
});
res.json(result); // 必须在 wrapper 成功返回后调用
```

`withStorageSnapshot(options, fn)` 仅加载，不自动提交；使用 `await commitStorage()` / `flushStorage()` 显式提交。
`discardStorage()` 清空 dirty 并关闭当前快照（可在提交失败后调用），供 HTTP 错误响应路径丢弃暂存数据；关闭后延迟 continuation 也不能读写。提交正在执行时禁止 discard。
`options.documents` 支持 `['prompts']` 或 `[{ table: 'app_settings', id: 'prompts', initial: {} }]`，在同一短读取事务加载额外文档。字符串缺省空对象，descriptor 不提供 initial 时缺失行报错；calendar descriptor 仍校验邮箱归属。此配置只接受服务端可信定义，不能接收客户端任意文档 ID。
存在未提交修改时 wrapper 拒绝返回成功（`STORAGE_UNCOMMITTED`）。这不能阻止调用方自己提前执行 `res.json/res.end`，HTTP 集成必须按上述顺序；SSE 的成功工具结果和 `done` 也必须等提交。
`withStorageCommit` / `withStorageTransaction` 在 callback 返回后自动 commit，再返回结果。它们不会把整个 callback 包进数据库事务。

认证 ALS 会被保留；也可显式传 `userId/user`。无用户仅允许内部可信 `system:true` 快照。
显式 options 中的 pool 可注入测试池或专用池，缺省使用 infra pool。嵌套快照拒绝执行；一个快照内的 mutation/commit 应顺序 await，不并行启动多个提交。
配置中已存在的邮箱 ID 不允许被另一用户重新认领。新建邮箱可以先提交 settings，再开启新快照加载该邮箱。

## 场景与日历

`readScenarioData()` 从同一快照读取 `app_settings.id=scenarios:${userId}`。
`mutateScenarioData(callback)` 的生产 callback 必须同步，其中原有同步 `readStore/saveStore` 可直接使用；场景与日历全部暂存到同一上下文，外层一次 commit 同事务提交。
callback 抛错时撤销它产生的所有暂存修改；返回 Promise 时拒绝，并关闭它的子上下文，延迟 continuation 不能写回父快照。
本地模式保留原文件及进程内串行行为。

## Jobs 接入

邮件 worker 可直接使用 `import { createMailJobStorage } from './storage/index.js'`，将 `createMailJobStorage()` 作为 `runMailJob` 的 storage 参数。测试可传 `{ pool }`。adapter 的 load/runSnapshot/commit 与 `server/mail-job.js` 契约匹配，冲突映射为 `MAIL_SNAPSHOT_CONFLICT`；加载全部自有邮箱以提供 peerTasks，且校验所有输入版本。

低层稳定入口：

```js
const snapshot = await createStorageSnapshot({ userId, mailboxId });
// snapshot.version 是加载时的版本向量 token；snapshot 保存可捕获的文档和身份上下文。
await runStorageSnapshot(snapshot, async () => {
  // 所有辅助 prompts/traces/recruitment 文档自动预载，读写仅暂存。
});
await repository.checkpoint(jobId, leaseToken, step, payload, async client => {
  await commitStorage({ client, snapshot, expectedVersion: snapshot.version });
});
```

`runStorageSnapshot` 不自动提交、不检查 dirty；结束后关闭本次执行的 ALS 上下文，防止 detached continuation 写入。异常使 snapshot 失效。`createStorageSnapshot` 返回时连接已释放。
`commitStorage({client})` 也可在已激活的 runStorageSnapshot 内调用。借用 client 必须已处于外层事务，本模块不执行 BEGIN/COMMIT/ROLLBACK/release。成功写入仅说明 SQL 已执行，最终持久化由外层 checkpoint 决定；快照会被消费，外层回滚后必须重新 load，禁止复用或宣称快照已提交。
`readSettings()` 使用 request context 的 `mailboxId` 覆盖偏好的活动邮箱，并校验实际归属；可由 createStorageSnapshot 的顶层 mailboxId 或 context.mailboxId 提供，不会持久修改用户偏好。

```js
const result = await withStorageCommit({
  userId: job.owner_id,
  mailboxIds: [job.mailbox_id],
  beforeCommit: async client => {
    await repository.lockLease(client, job.id, leaseToken);
    // 可使用同一个 client 插入 checkpoint/结果；其失败与业务修改一起回滚。
    // 不调用 repository.checkpoint()/complete()：它们会另开事务。
  },
}, async () => {
  // 模型/网络调用和业务暂存
  return resultObject;
});
```

`beforeCommit(client)` 在短事务中执行，适合租约 fencing 和 checkpoint SQL，禁止网络调用。
`afterWrite(client)` 在所有业务写入后、COMMIT 前执行最终租约重验；与 beforeCommit 使用同一 client，其异常会回滚全部写入。两个 hook 均可传给 commitStorage 或 withStorageCommit。
回调不能调用同步 storage API（提交期间上下文禁止变更）。如果要原子完成 job，使用同 client 的 SQL 更新 job；不要先提交 job 成功再提交业务。
外部 SMTP/飞书副作用无法由数据库事务回滚，仍需业务操作状态机和外部幂等/unknown 核对。

## 一致性与错误

- 快照读取使用短 `REPEATABLE READ READ ONLY` 事务，完成后立即释放连接。
- 每次提交获取新 client，BEGIN 后按固定 key 顺序锁定并校验全部已加载输入，dirty 行直接 UPDATE 锁，其余 SHARE 锁，不先读锁再升级；随后 CAS 写 dirty 文档，最后 COMMIT。
- 同一固定顺序的事务 advisory 共享/排他锁保护缺失行的读取与创建；全部接入该协议的写入方才能完整提供缺失行并发保证。
- 已存在行：`UPDATE ... WHERE version=expected RETURNING version`；缺失行：`INSERT ... ON CONFLICT DO NOTHING RETURNING version`。
- 冲突为 `status:409, code:STORAGE_VERSION_CONFLICT`，无自动重试/覆盖。调用方需重新加载并重新校验意图，不能盲目重放已发生的外部副作用。
- calendar-only 提交也检查 settings 版本，以拒绝基于旧邮箱归属/配置的写入。
- 一个快照内可多次 commit；成功后更新基准版本。提交失败使快照不可继续使用，必须开启新快照。连接断开时 COMMIT 结果可能未知，调用方应通过业务幂等记录核对。
- 快照不保证网络调用结束时数据仍最新；提交会验证所有已加载文档版本（包括未 dirty 的源日历/场景）。无 dirty 的显式 commit 也执行校验；纯 withStorageSnapshot 读取不自动提交校验。
- 共享 settings 单行版本会造成不同用户配置更新之间的保守冲突，这是当前文档模型的明确代价。
- 身份变化、未加载文档、关闭后的延迟回调均拒绝访问；无跨请求全局快照缓存。

## 验证

```sh
node --test server/storage.test.js
DAYLIGHT_STORAGE_TEST_URL='postgresql:///postgres?host=/tmp' node --test server/storage.test.js
```

未设置测试 URL 时跳过 PG 集成用例，继续验证无快照保护及 local 兼容。
PG 测试只在指定数据库创建唯一临时 schema，验证后删除该 schema，不读取业务表或真实凭据。
2026-10-17：Node 22.23.3、本机真实 PostgreSQL，14/14 存储测试通过；存储、mail-job、scenarios 定向回归 56/56 通过。覆盖并发 CAS、跨文档回滚、checkpoint 回滚、无连接占用、隔离、异步回调、本地兼容、通用文档、discard、最终租约检查、跨邮箱写偏差、借用事务以及 worker 显式邮箱；不是云端部署验收。定向输出见 `work/storage-mail-regression.tap`。
关闭环境代理后的全量回归：413 通过、6 失败、1 跳过。5 个会议存储测试 mock 不支持 infra 的 `.on()`；1 个辅助存储 mock 为不存在的输入返回版本 1，与完整输入校验冲突，需相关任务调整。完整输出位于 `work/storage-regression.tap`。
