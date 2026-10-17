import { randomBytes } from 'node:crypto';
import { redisSet, redisGet } from './infra/redis.js';
import { getRequestUserId } from './request-context.js';
import { readSettings } from './store.js';
import { findUserById } from './infra/postgres.js';
export async function createCalendarSubscription() {
  const userId=getRequestUserId();
  if(!userId) throw Object.assign(new Error('请登录后创建私密日历订阅。'),{status:401});
  const settings=readSettings(),user=await findUserById(userId);
  const token=randomBytes(32).toString('base64url');
  await redisSet(`calendar-subscription:${token}`,JSON.stringify({userId,mailboxId:settings.activeMailboxId,sv:Number(user.session_version||0)}),180*86400);
  return {path:`/api/calendar.ics?subscription=${token}`,expiresInDays:180};
}
export async function resolveCalendarSubscription(token) {
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const value=await redisGet(`calendar-subscription:${token}`);if(!value)return null;
  const record=JSON.parse(value),user=await findUserById(record.userId);
  if(!user||Number(user.session_version||0)!==record.sv)return null;
  return {user,mailboxId:record.mailboxId};
}
