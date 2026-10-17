import { createHash } from 'node:crypto';

const tokens = new Map();
const API = 'https://open.feishu.cn/open-apis/vc/v1/reserves';

function safeError(message, settings) {
  let text = String(message || '请求失败');
  for (const secret of [settings.appSecret, ...[...tokens.values()].map((token) => token.value)]) {
    if (secret) text = text.split(secret).join('[已隐藏]');
  }
  return text;
}

async function request(url, options, settings) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
    const body = await response.json();
    if (!response.ok || (body.code != null && body.code !== 0) || body.error) {
      throw new Error(body.msg || body.error_description || body.error || `HTTP ${response.status}`);
    }
    return body;
  } catch (error) {
    const message = error.name === 'TimeoutError' ? '请求超过 30 秒，请稍后重试' : safeError(error.message, settings);
    throw new Error(`飞书会议：${message}`);
  }
}

async function accessToken(settings) {
  const key = createHash('sha256').update(`${settings.appId}:${settings.appSecret}`).digest('hex');
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.value;
  const result = await request('https://accounts.feishu.cn/oauth/v3/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: settings.appId, client_secret: settings.appSecret }),
  }, settings);
  if (!result.access_token || !Number.isFinite(Number(result.expires_in))) throw new Error('飞书会议：未返回有效的应用凭证。');
  tokens.set(key, { value: result.access_token, expiresAt: Date.now() + Number(result.expires_in) * 1000 });
  return result.access_token;
}

// Reserve expiry controls how long the meeting link can be used. Interview times stay in Daylight.
export async function prepareMeeting(settings, { id, topic, start, end }) {
  const config = settings.feishu || {};
  if (!config.appId || !config.appSecret || !config.ownerId) {
    throw new Error('请先填写飞书 App ID、App Secret 和会议归属人的 Open ID，或手动填写会议链接。');
  }
  const startsAt = Date.parse(start);
  const endsAt = Date.parse(end);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
    throw new Error('请填写有效的面试开始和结束时间。');
  }
  const now = Date.now();
  if (endsAt <= now) throw new Error('面试结束时间已经过去，请重新选择时间。');
  const limit = now + 30 * 24 * 60 * 60 * 1000;
  if (endsAt > limit) throw new Error('飞书会议只支持预约未来 30 天内的会议，请调整时间或手动填写会议链接。');
  const expiresAt = Math.min(endsAt + 60 * 60 * 1000, limit - 60000);
  if (expiresAt < endsAt) throw new Error('面试时间已超出飞书 30 天预约范围，请调整时间或手动填写会议链接。');
  const token = await accessToken(config);
  const payload = { end_time: String(Math.floor(expiresAt / 1000)), meeting_settings: { topic: topic || '面试邀约' } };
  if (!id) Object.assign(payload, { owner_id: config.ownerId, meeting_settings: { ...payload.meeting_settings, meeting_initial_type: 1, auto_record: false } });
  const result = await request(`${API}/${id ? encodeURIComponent(id) : 'apply'}?user_id_type=open_id`, {
    method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, config);
  const reserve = result.data?.reserve;
  let url;
  try { url = new URL(reserve?.url); } catch { /* Report an invalid response below. */ }
  if (!reserve?.id || !url || url.protocol !== 'https:' || !Number.isFinite(Number(reserve.end_time))) {
    throw new Error('飞书会议未返回有效预约或真实入会链接，请检查飞书配置后重试。');
  }
  return { id: reserve.id, url: reserve.url, meetingNo: reserve.meeting_no || '', password: reserve.password || '',
    expiresAt: new Date(Number(reserve.end_time) * 1000).toISOString(), provider: 'feishu' };
}
