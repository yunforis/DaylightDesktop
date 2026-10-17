import { randomBytes } from 'node:crypto';
import { redisSet, redisGetDel } from './infra/redis.js';
import { getRequestUserId } from './request-context.js';
import { readSettings } from './store.js';
export async function createCalendarOAuthState(provider, redirectUri, native=false) {
  const state=randomBytes(32).toString('base64url');
  await redisSet(`calendar-oauth:${state}`,JSON.stringify({provider,redirectUri,native,userId:getRequestUserId(),mailboxId:readSettings().activeMailboxId}),600);
  return state;
}
export async function consumeCalendarOAuthState(state) {
  if(typeof state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(state)) throw Object.assign(new Error('授权请求无效，请重新连接日历。'),{status:400});
  const value=await redisGetDel(`calendar-oauth:${state}`);
  if(!value) throw Object.assign(new Error('授权请求已过期或已使用，请重新连接日历。'),{status:400});
  return JSON.parse(value);
}
