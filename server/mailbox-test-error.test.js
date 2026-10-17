import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessMailboxProvider, mailboxProviders, providerEmailMismatch } from './providers.js';
import { formatMailboxTestError, formatModelFetchError, readMailboxEmails, testMailboxConnection } from './agent.js';

test('模型 fetch failed 翻译为可读中文', () => {
  const err = Object.assign(new Error('fetch failed'), {
    cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
  });
  const message = formatModelFetchError(err, { baseUrl: 'https://apimaster.ai/v1' });
  assert.match(message, /apimaster\.ai/);
  assert.match(message, /中转|断开|不可用/);
  assert.notEqual(message, 'fetch failed');
});

test('模型 upstream eof 翻译为可读中文', () => {
  const message = formatModelFetchError(
    new Error('upstream stream ended abnormally: reason=eof'),
    { baseUrl: 'https://apimaster.ai/v1' },
  );
  assert.match(message, /中转|断开|EOF|代理/);
  assert.doesNotMatch(message, /^upstream stream ended abnormally/);
});

test('Login is disabled 翻译为可读中文', () => {
  const message = formatMailboxTestError(new Error('Login is disabled'), {
    email: 'user@outlook.com',
    imapHost: 'outlook.office365.com',
  });
  assert.match(message, /Login is disabled/);
  assert.match(message, /OAuth|应用密码|QQ/);
  assert.doesNotMatch(message, /^Login is disabled$/i);
});

test('authenticationFailed 布尔值不会变成字面量 true', () => {
  const error = Object.assign(new Error('Login is disabled'), { authenticationFailed: true });
  const message = formatMailboxTestError(error, {
    email: 'user@outlook.com',
    imapHost: 'outlook.office365.com',
  });
  assert.notEqual(message, 'true');
  assert.match(message, /Login is disabled|OAuth|QQ/);
});

test('Outlook 地址配 QQ 类型时连通测试直接给出中文提示', async () => {
  const mismatch = providerEmailMismatch('yunfeng-yu@outlook.com', 'qq');
  assert.match(mismatch.message, /Outlook/);
  assert.match(mismatch.message, /QQ/);

  await assert.rejects(
    () => testMailboxConnection({
      email: 'yunfeng-yu@outlook.com',
      authorizationCode: 'fake-app-password',
      provider: 'qq',
      imapHost: 'imap.qq.com',
      imapPort: 993,
      imapSecure: true,
    }),
    (error) => /Outlook|邮箱类型/.test(error.message),
  );
});

test('Command failed 会被翻译成可读中文', async () => {
  await assert.rejects(
    () => testMailboxConnection({
      email: 'someone@qq.com',
      authorizationCode: 'wrong',
      provider: 'qq',
      imapHost: 'imap.qq.com',
      imapPort: 993,
      imapSecure: true,
    }, {
      clientFactory: () => ({
        async connect() { throw new Error('Command failed'); },
        async logout() {},
      }),
    }),
    (error) => /邮箱类型|授权码|IMAP/.test(error.message) && !/^Command failed$/i.test(error.message),
  );
});

test('TLS 握手前的 ECONNRESET 显示网络断连，学校邮箱提示可用入口', () => {
  const error = Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), {
    code: 'ECONNRESET',
  });
  const message = formatMailboxTestError(error, { imapHost: 'imap.shanghaitech.edu.cn' });
  assert.match(message, /连接被中断/);
  assert.match(message, /代理分流/);
  assert.match(message, /mail\.shanghaitech\.edu\.cn/);
  assert.match(message, /:143.*强制 STARTTLS/);
  assert.doesNotMatch(message, /证书校验失败/);

  const currentHost = formatMailboxTestError(error, { imapHost: 'mail.shanghaitech.edu.cn', imapPort: 993 });
  assert.match(currentHost, /:143.*强制 STARTTLS/);
  const starttlsHost = formatMailboxTestError(error, { imapHost: 'mail.shanghaitech.edu.cn', imapPort: 143 });
  assert.doesNotMatch(starttlsHost, /可尝试/);

  const wrapped = formatMailboxTestError(new Error('Connection failed', { cause: error }), { imapHost: 'imap.example.invalid' });
  assert.match(wrapped, /连接被中断/);
  assert.doesNotMatch(wrapped, /证书校验失败|shanghaitech/);
});

test('证书过期、域名不匹配、信任链与 TLS 协议错误给出各自的处理方式', () => {
  const settings = { imapHost: 'imap.example.invalid' };
  const expired = formatMailboxTestError(Object.assign(new Error('Connection failed'), { code: 'CERT_HAS_EXPIRED' }), settings);
  assert.match(expired, /证书已过期/);
  const mismatch = formatMailboxTestError(Object.assign(new Error('Connection failed'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), settings);
  assert.match(mismatch, /主机名不匹配/);
  const untrusted = formatMailboxTestError(Object.assign(new Error('Connection failed'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }), settings);
  assert.match(untrusted, /证书链|受信任证书/);
  const protocol = formatMailboxTestError(Object.assign(new Error('wrong version number'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }), settings);
  assert.match(protocol, /TLS 握手失败/);
  assert.match(protocol, /993.*直接 TLS.*143.*STARTTLS/);
  for (const message of [expired, mismatch, untrusted]) assert.doesNotMatch(message, /直接 TLS|关闭.*校验/);
});

test('底层错误只有 code 时也能识别 DNS、超时和拒绝连接', () => {
  for (const [code, pattern] of [['ENOTFOUND', /DNS/], ['EAI_AGAIN', /DNS/], ['ETIMEDOUT', /超时/], ['ECONNREFUSED', /被拒绝/]]) {
    const error = Object.assign(new Error('Connection failed'), { code });
    assert.match(formatMailboxTestError(error, { imapHost: 'imap.example.invalid' }), pattern);
  }
});

test('学校邮箱和校友邮箱可识别预设，其他学校仍使用自定义配置', () => {
  assert.equal(guessMailboxProvider('fixture@SHANGHAITECH.EDU.CN'), 'shanghaitech');
  assert.equal(guessMailboxProvider('fixture@alumni.shanghaitech.edu.cn'), 'shanghaitech');
  assert.equal(guessMailboxProvider('fixture@other.edu.cn'), 'custom');
  assert.equal(guessMailboxProvider('fixture@shanghaitech.edu.cn.example.invalid'), 'custom');
  assert.equal(providerEmailMismatch('fixture@shanghaitech.edu.cn', 'shanghaitech'), null);
  assert.equal(providerEmailMismatch('fixture@shanghaitech.edu.cn', 'custom'), null);
  assert.equal(providerEmailMismatch('fixture@shanghaitech.edu.cn', 'qq').expected, 'shanghaitech');
  const provider = mailboxProviders.find(({ id }) => id === 'shanghaitech');
  assert.equal(provider.smtpHost, 'mail.shanghaitech.edu.cn');
  assert.equal(provider.smtpPort, 465);
  assert.equal(provider.smtpSecure, true);
});

test('学校邮箱连通性测试与同步均强制 STARTTLS，连接失败仍保留原因', async () => {
  const settings = { provider: 'shanghaitech', email: 'fixture@shanghaitech.edu.cn', authorizationCode: 'synthetic-client-password' };
  const connections = [];
  const clientFactory = (options) => {
    connections.push(options);
    return {
      mailbox: { exists: 0 }, async connect() {},
      async getMailboxLock() { return { release() {} }; }, async logout() {},
    };
  };
  assert.equal((await testMailboxConnection(settings, { clientFactory })).ok, true);
  assert.deepEqual(await readMailboxEmails(settings, { clientFactory }), []);
  for (const options of connections) {
    assert.equal(options.host, 'mail.shanghaitech.edu.cn');
    assert.equal(options.port, 143);
    assert.equal(options.secure, false);
    assert.notEqual(options.tls?.rejectUnauthorized, false);
    assert.equal(options.doSTARTTLS, true, '不允许降级为明文登录');
    assert.deepEqual(options.auth, { user: settings.email, pass: settings.authorizationCode });
  }
  const reset = Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' });
  const failingFactory = () => ({ async connect() { throw reset; }, close() {} });
  for (const connect of [testMailboxConnection, readMailboxEmails]) {
    await assert.rejects(connect(settings, { clientFactory: failingFactory }), (error) => {
      assert.match(error.message, /连接被中断/);
      assert.equal(error.cause, reset);
      assert.equal(error.status, 400);
      return true;
    });
  }
});
