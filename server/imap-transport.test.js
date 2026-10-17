import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { readMailboxEmails, testMailboxConnection } from './agent.js';

test('服务器不提供 STARTTLS 时，连通测试和同步均拒绝发送登录凭据', async (t) => {
  const commands = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] Synthetic IMAP ready\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(line);
        const [tag, command] = line.split(' ');
        if (command?.toUpperCase() === 'CAPABILITY') {
          socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK Capabilities\r\n`);
        } else {
          socket.write(`${tag} NO Unsupported command\r\n`);
        }
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const settings = {
    provider: 'shanghaitech', email: 'fixture@shanghaitech.edu.cn',
    authorizationCode: 'synthetic-starttls-password',
    imapHost: '127.0.0.1', imapPort: server.address().port,
  };
  for (const connect of [testMailboxConnection, readMailboxEmails]) {
    await assert.rejects(connect(settings), (error) => {
      assert.equal(error.cause.tlsFailed, true);
      assert.match(error.cause.message, /does not support STARTTLS/);
      return true;
    });
  }
  assert.ok(commands.every((line) => !/\bLOGIN\b|\bAUTHENTICATE\b/i.test(line)));
  assert.ok(commands.every((line) => !line.includes(settings.authorizationCode)));
});
