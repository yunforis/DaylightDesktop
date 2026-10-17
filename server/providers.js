/** Shared catalog for mailbox + model presets shown in settings. */

export const mailboxProviders = [
  { id: 'qq', name: 'QQ 邮箱', imapHost: 'imap.qq.com', smtpHost: 'smtp.qq.com', smtpPort: 465 },
  { id: 'foxmail', name: 'Foxmail / QQ 企业邮箱', imapHost: 'imap.exmail.qq.com', smtpHost: 'smtp.exmail.qq.com', smtpPort: 465 },
  { id: '163', name: '网易 163', imapHost: 'imap.163.com', smtpHost: 'smtp.163.com', smtpPort: 465 },
  { id: '126', name: '网易 126', imapHost: 'imap.126.com', smtpHost: 'smtp.126.com', smtpPort: 465 },
  { id: 'yeah', name: '网易 yeah.net', imapHost: 'imap.yeah.net', smtpHost: 'smtp.yeah.net', smtpPort: 465 },
  { id: 'gmail', name: 'Gmail', imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  { id: 'outlook', name: 'Outlook / Hotmail', imapHost: 'outlook.office365.com', smtpHost: 'smtp-mail.outlook.com', smtpPort: 587 },
  { id: 'office365', name: 'Microsoft 365 / Exchange', imapHost: 'outlook.office365.com', smtpHost: 'smtp.office365.com', smtpPort: 587 },
  { id: 'icloud', name: 'iCloud 邮箱', imapHost: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
  { id: 'yahoo', name: 'Yahoo Mail', imapHost: 'imap.mail.yahoo.com', smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465 },
  { id: 'zoho', name: 'Zoho Mail', imapHost: 'imap.zoho.com', smtpHost: 'smtp.zoho.com', smtpPort: 465 },
  // 部分接入网络的 993 会断连；143 强制 STARTTLS 已通过证书校验、登录及 INBOX 实连验证。
  { id: 'shanghaitech', name: '上海科技大学（Coremail）', imapHost: 'mail.shanghaitech.edu.cn', imapPort: 143, imapSecure: false, smtpHost: 'mail.shanghaitech.edu.cn', smtpPort: 465 },
  { id: 'custom', name: '其他邮箱 / 自定义 IMAP·SMTP', imapHost: '', smtpHost: '', smtpPort: 465 },
].map((provider) => ({
  ...provider,
  imapPort: provider.imapPort ?? 993,
  imapSecure: provider.imapSecure ?? true,
  smtpSecure: provider.smtpPort === 465,
}));

/** 根据注册/登录邮箱域名推断 IMAP 预设（仅作预填，用户仍可改）。 */
export function guessMailboxProvider(email) {
  const domain = String(email || '').split('@')[1]?.trim().toLowerCase() || '';
  if (!domain) return 'qq';
  const map = {
    'qq.com': 'qq',
    'foxmail.com': 'qq',
    '163.com': '163',
    '126.com': '126',
    'yeah.net': 'yeah',
    'gmail.com': 'gmail',
    'googlemail.com': 'gmail',
    'outlook.com': 'outlook',
    'hotmail.com': 'outlook',
    'live.com': 'outlook',
    'msn.com': 'outlook',
    'icloud.com': 'icloud',
    'me.com': 'icloud',
    'mac.com': 'icloud',
    'yahoo.com': 'yahoo',
    'yahoo.com.cn': 'yahoo',
    'zoho.com': 'zoho',
    'shanghaitech.edu.cn': 'shanghaitech',
    'alumni.shanghaitech.edu.cn': 'shanghaitech',
  };
  if (map[domain]) return map[domain];
  if (domain.endsWith('.exmail.qq.com') || domain.includes('exmail')) return 'foxmail';
  return 'custom';
}

function providerFamily(id) {
  if (id === 'qq' || id === 'foxmail') return 'qq';
  if (id === 'outlook' || id === 'office365') return 'outlook';
  if (id === '163' || id === '126' || id === 'yeah') return 'netease';
  return id;
}

/** 邮箱地址域名与所选类型明显不符时返回说明，否则 null。 */
export function providerEmailMismatch(email, providerId) {
  const expected = guessMailboxProvider(email);
  const current = String(providerId || '').trim() || 'custom';
  if (!email || !expected || expected === 'custom' || current === 'custom') return null;
  if (providerFamily(expected) === providerFamily(current)) return null;
  const expectedMeta = mailboxProviders.find((item) => item.id === expected);
  const currentMeta = mailboxProviders.find((item) => item.id === current);
  return {
    expected,
    current,
    message: `邮箱地址像是「${expectedMeta?.name || expected}」，但类型选成了「${currentMeta?.name || current}」。请把「邮箱类型」改成匹配的预设后再测，否则会连错服务器。`,
  };
}

/** tokenPrice* 为可选参考单价（元/百万 Token），随预设填入设置，可改；不是账单。 */
export const modelProviders = [
  {
    id: 'deepseek', name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    docs: 'https://platform.deepseek.com/api_keys',
    tokenPriceIn: 1, tokenPriceOut: 2, tokenPriceCachedIn: 0.1,
  },
  {
    id: 'openai', name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
    docs: 'https://platform.openai.com/api-keys',
    tokenPriceIn: 1.1, tokenPriceOut: 4.4,
  },
  {
    id: 'qwen', name: '通义千问（兼容模式）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',
    docs: 'https://help.aliyun.com/zh/model-studio/developer-reference/get-api-key',
    tokenPriceIn: 0.8, tokenPriceOut: 2,
  },
  {
    id: 'moonshot', name: 'Moonshot / Kimi',
    baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k',
    docs: 'https://platform.moonshot.cn/console/api-keys',
    tokenPriceIn: 12, tokenPriceOut: 12,
  },
  {
    id: 'zhipu', name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash',
    docs: 'https://open.bigmodel.cn/usercenter/apikeys',
    tokenPriceIn: 0.1, tokenPriceOut: 0.1,
  },
  {
    id: 'openrouter', name: 'OpenRouter 中转',
    baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini',
    docs: 'https://openrouter.ai/keys',
  },
  {
    id: 'siliconflow', name: '硅基流动中转',
    baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3',
    docs: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'custom', name: '自定义 / 其他 OpenAI 兼容中转',
    baseUrl: '', model: '',
    docs: '',
  },
];

export const FIELD_HELP = {
  email: '填写完整邮箱地址，例如 name@qq.com。该地址同时用于 IMAP 登录与 SMTP 发信。',
  authorizationCode: '不是网页登录密码。QQ/163 等需在邮箱设置里开启 IMAP/SMTP 并生成授权码；Gmail 使用应用专用密码；Outlook 需允许基本认证的账号。',
  imapHost: '收信服务器主机名，由邮箱服务商提供。选择预设后会自动填入，自定义邮箱请对照服务商文档。',
  smtpHost: '发信服务器主机名。回复草稿时使用，通常与 IMAP 同属一家服务商。',
  fetchLimit: '「最近 N 封」模式下每次同步只读取收件箱最近 N 封（1–200）。联调建议先设 3–5。',
  fetchMode: '最近 N 封按 UID 从新到旧截取；按日期范围则用 IMAP SINCE（及可选 BEFORE）筛选后再读取。',
  fetchRange: '预设会换算成北京时间的起始日。自定义时填写开始/结束日期。',
  syncStrategy: '定时轮询按间隔检查；IDLE 在支持的服务器上保持连接，有新邮件再同步，失败时自动退回轮询。',
  baseUrl: 'OpenAI 兼容接口的 Base URL，不要带完整 /chat/completions 也可以；程序会自动拼接。中转站填写其文档给出的地址。',
  apiKey: '模型服务商或中转站发放的密钥。页面不会回显已保存的 Key；留空保存表示继续使用原 Key。',
  model: '服务商控制台中的准确模型 ID，且账户需有调用权限。需支持 JSON Object 输出。',
  tokenPrice: '可选，与当前 API Key / 模型配置一起保存。单位：人民币元 / 百万 Token，用于估算费用，不是账单；改价不追溯历史调用。切换提供商预设会填入参考价，可按实际改。',
  extractionPrompt: '系统提示词会在每次模型提取时重新从本地读取。保存后无需重启服务即可用于下一封未处理邮件。',
};
