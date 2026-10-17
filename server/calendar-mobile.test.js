import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
fs.mkdirSync(new URL('../work/',import.meta.url),{recursive:true});
process.env.DAYLIGHT_DATA_DIR=fs.mkdtempSync(new URL('../work/calendar-mobile-',import.meta.url));
const {runWithRequestContext}=await import('./request-context.js');
const {saveCalendarSync,readCalendarSync,saveSettings,readSettings}=await import('./store.js');
const {createCalendarOAuthState,consumeCalendarOAuthState}=await import('./calendar-oauth-state.js');
test('calendar connection settings belong to the initiating user',async()=>{
 runWithRequestContext({userId:'alpha'},()=>saveCalendarSync({connections:[{id:'a',password:'synthetic-a'}]}));
 runWithRequestContext({userId:'beta'},()=>{assert.equal(readCalendarSync().connections.length,0);saveCalendarSync({connections:[{id:'b'}]});});
 runWithRequestContext({userId:'alpha'},()=>{saveSettings({...readSettings(),model:'updated'});assert.equal(readCalendarSync().connections[0].id,'a');});
});
test('OAuth state is opaque, owner-bound, single-use and rejects invented states',async()=>{
 const state=await runWithRequestContext({userId:'alpha'},()=>createCalendarOAuthState('google','https://api.example.invalid/callback',true));
 assert.equal(state.length,43);const value=await consumeCalendarOAuthState(state);assert.equal(value.userId,'alpha');assert.equal(value.native,true);assert.equal(value.redirectUri,'https://api.example.invalid/callback');
 await assert.rejects(consumeCalendarOAuthState(state),/过期或已使用/);
 await assert.rejects(consumeCalendarOAuthState('invented'),/无效/);
});
