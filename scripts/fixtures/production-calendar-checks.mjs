// Real production entries and PostgreSQL; only the remote Google transport is synthetic.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';

export async function verifyCalendar({ pool, env, preload, dir, launch, stop, call, expect, until, check }) {
  const requests = [];
  const mock = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, path: req.url, body: Buffer.concat(chunks).toString() });
    assert.equal(req.headers.authorization, 'Bearer synthetic-calendar-token');
    // Record acceptance, then lose the create response: its outcome must remain unknown.
    if (req.method === 'POST') return req.socket.destroy();
    if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'synthetic-remote-event' }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const calendarEnv = { ...env, PRODUCTION_VERIFY_CALENDAR_URL: `http://127.0.0.1:${mock.address().port}` };
  let worker;
  const document = async () => (await pool.query("SELECT payload FROM app_settings WHERE id='external-sync:mail-alice'")).rows[0]?.payload;
  const calendar = async () => (await pool.query("SELECT payload FROM mailbox_calendars WHERE mailbox_id='mail-alice'")).rows[0].payload;
  const jobFor = async intent => (await pool.query('SELECT * FROM daylight_jobs WHERE idempotency_key=$1', [`calendar:${intent.id}`])).rows[0];
  async function schedule(intent) {
    const scheduler = launch('calendar-scheduler', [process.execPath, '--import', preload, 'server/scheduler.js'], calendarEnv);
    try {
      await until(async () => Boolean(await jobFor(intent)), 'calendar scheduler job');
      assert.equal((await document()).intents.find(value => value.id === intent.id).status, 'scheduled');
      const job = await jobFor(intent);
      assert.equal(job.kind, 'calendar.sync');
      assert.equal(job.owner_id, 'alice');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM daylight_job_outbox WHERE job_id=$1', [job.id])).rows[0].n, 1);
      return job;
    } finally { await stop(scheduler); }
  }
  async function run(intent, status = 'succeeded') {
    const job = await schedule(intent);
    worker = launch('calendar-worker', [process.execPath, '--import', preload, 'server/worker.js'], calendarEnv);
    await until(async () => (await jobFor(intent)).status === status, `calendar worker ${status}`);
    await stop(worker);
    return job;
  }
  try {
    // Seed a known remote identity through the real HTTP calendar writer before enabling sync.
    const event = expect(await call('/events', 0, 'POST', { title: '合成远端日程',
      start: '2027-01-15T10:00:00+08:00', end: '2027-01-15T11:00:00+08:00',
      externalIds: { 'mock-google': 'synthetic-remote-event' } }));
    await pool.query(`UPDATE app_settings SET payload=jsonb_set(payload,'{calendarSync}',$1::jsonb),version=version+1 WHERE id='default'`,
      [JSON.stringify({ requireConfirm: false, connections: [{ id: 'mock-google', provider: 'google', enabled: true,
        accessToken: 'synthetic-calendar-token', expiresAt: Date.now() + 3600000, calendarId: 'primary' }] })]);
    let update;
    await check('calendar HTTP event and durable intent commit atomically in real PostgreSQL', async () => {
      const beforeCalendar = await calendar(), beforeIntent = await document();
      await pool.query(`CREATE FUNCTION reject_calendar_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.id LIKE 'external-sync:%' THEN RAISE EXCEPTION 'synthetic intent rollback'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_calendar_intent BEFORE INSERT OR UPDATE ON app_settings FOR EACH ROW EXECUTE FUNCTION reject_calendar_intent()`);
      try { expect(await call(`/events/${event.id}`, 0, 'PUT', { title: '合成修改' }), 503); }
      finally { await pool.query('DROP TRIGGER reject_calendar_intent ON app_settings'); }
      assert.deepEqual(await calendar(), beforeCalendar);
      assert.deepEqual(await document(), beforeIntent);
      expect(await call(`/events/${event.id}`, 0, 'PUT', { title: '合成修改' }));
      update = (await document()).intents.find(value => value.event.id === event.id);
      assert.equal(update.status, 'pending'); assert.equal(update.action, 'update');
      assert.equal(update.event.title, '合成修改');
      assert.equal((await calendar()).events.find(value => value.id === event.id).title, update.event.title);
      assert.equal(await jobFor(update), undefined);
      assert.equal(requests.length, 0);
    });
    await check('independent scheduler creates calendar job/outbox and worker PATCHes fixed identity once', async () => {
      await run(update);
      const saved = await document();
      assert.equal(saved.intents.find(value => value.id === update.id).receipts['mock-google'].status, 'succeeded');
      assert.equal((await calendar()).events.find(value => value.id === event.id).externalIds['mock-google'], 'synthetic-remote-event');
      assert.deepEqual(requests.map(value => value.method), ['PATCH']);
      assert.ok(requests[0].path.endsWith('/events/synthetic-remote-event'));
      assert.equal(JSON.parse(requests[0].body).summary, '合成修改');
    });
    await check('deleted local calendar retains target identity and worker DELETEs once without rescheduling success', async () => {
      expect(await call(`/events/${event.id}`, 0, 'DELETE'));
      assert.equal((await calendar()).events.some(value => value.id === event.id), false);
      const deletion = (await document()).intents.find(value => value.event.id === event.id && value.action === 'delete');
      assert.equal(deletion.status, 'pending');
      await run(deletion);
      assert.deepEqual(requests.map(value => value.method), ['PATCH', 'DELETE']);
      assert.equal(requests[1].path, requests[0].path);
      // A fresh scheduler scan is also exercised by the next create; assert counts afterward.
    });
    await check('lost calendar create response persists unknown and manual retry makes no second remote POST', async () => {
      const created = expect(await call('/events', 0, 'POST', { title: '合成未知创建',
        start: '2027-01-16T10:00:00+08:00', end: '2027-01-16T11:00:00+08:00' }));
      const intent = (await document()).intents.find(value => value.event.id === created.id);
      const job = await run(intent, 'failed');
      assert.equal((await jobFor(intent)).error.code, 'CALENDAR_RESULT_UNKNOWN');
      assert.equal((await document()).intents.find(value => value.id === intent.id).status, 'unknown');
      expect(await call(`/jobs/${job.id}/retry`, 0, 'POST', {}));
      worker = launch('calendar-worker-retry', [process.execPath, '--import', preload, 'server/worker.js'], calendarEnv);
      await until(async () => (await jobFor(intent)).status === 'failed', 'unknown retry blocked');
      await stop(worker);
      assert.equal((await jobFor(intent)).error.code, 'CALENDAR_RESULT_UNKNOWN');
      assert.deepEqual(requests.map(value => value.method), ['PATCH', 'DELETE', 'POST']);
      const saved = await document();
      assert.equal(saved.intents.find(value => value.id === intent.id).receipts['mock-google'].status, 'unknown');
      assert.equal(saved.targets[JSON.stringify([created.id, 'mock-google'])].status, 'unknown');
      assert.equal(saved.intents.length, 3, 'receipt writes must not generate more intents');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM daylight_jobs WHERE kind='calendar.sync'")).rows[0].n, 3);
    });
  } finally {
    await stop(worker);
    mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
    fs.writeFileSync(path.join(dir, 'calendar-requests.json'), JSON.stringify(requests, null, 2));
  }
}
