import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpeechInput, speechSupport } from '../src/lib/little-d-speech.js';

function fixture(initialText = '') {
  let recognition;
  class Recognition {
    constructor() { recognition = this; }
    start() { this.starts = (this.starts || 0) + 1; }
    stop() { this.stops = (this.stops || 0) + 1; }
    abort() { this.aborted = true; }
  }
  const text = [];
  const states = [];
  const ended = [];
  const session = createSpeechInput({
    Recognition,
    initialText,
    onText: (value) => text.push(value),
    onStatus: (value) => states.push(value),
    onEnd: (value) => ended.push(value),
  });
  function result(...pieces) {
    recognition.onresult?.({
      resultIndex: pieces.length - 1,
      results: pieces.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })),
    });
  }
  return { session, recognition, text, states, ended, result };
}

test('speech support distinguishes secure pages, missing APIs, and Chromium prefixes', () => {
  const Recognition = () => {};
  assert.equal(speechSupport({ isSecureContext: true, webkitSpeechRecognition: Recognition }).Recognition, Recognition);
  assert.match(speechSupport({ isSecureContext: false, SpeechRecognition: Recognition }).message, /安全页面/);
  assert.match(speechSupport({ isSecureContext: true }).message, /不支持语音识别/);
});

test('interim revisions and repeated final results preserve the draft without duplication', () => {
  const f = fixture('新增待办：');
  f.session.start();
  f.recognition.onstart();
  f.result(['明', false]);
  f.result(['明天交周报', true]);
  f.result(['明天交周报', true], ['优先', false]);
  f.result(['明天交周报', true], ['优先级高', true]);
  assert.deepEqual(f.text, [
    '新增待办： 明', '新增待办： 明天交周报', '新增待办： 明天交周报优先', '新增待办： 明天交周报优先级高',
  ]);
  f.recognition.onend();
  assert.deepEqual(f.states, ['starting', 'listening', 'idle']);
  assert.deepEqual(f.ended, [{ transcript: '明天交周报优先级高', error: '' }]);
});

test('stopping waits for a final result before finishing', () => {
  const f = fixture();
  f.session.start();
  f.recognition.onstart();
  f.result(['明天', false]);
  f.session.stop();
  f.result(['明天上午十点', true]);
  f.recognition.onend();
  assert.equal(f.recognition.stops, 1);
  assert.equal(f.text.at(-1), '明天上午十点');
  assert.deepEqual(f.states, ['starting', 'listening', 'processing', 'idle']);
});

test('stop before the browser starts is retried when the microphone starts', () => {
  const f = fixture();
  f.session.start();
  f.recognition.stop = () => { throw Object.assign(new Error(), { name: 'InvalidStateError' }); };
  f.session.stop();
  f.recognition.stop = () => { f.recognition.stops = 1; };
  f.recognition.onstart();
  assert.equal(f.recognition.stops, 1);
  f.recognition.onend();
  assert.equal(f.states.at(-1), 'idle');
});

test('cancel ignores queued results and end events after send, edit, close, or unmount', () => {
  const f = fixture();
  f.session.start();
  f.result(['已有文字', false]);
  const lateResult = f.recognition.onresult;
  const lateEnd = f.recognition.onend;
  const lateError = f.recognition.onerror;
  f.session.cancel();
  lateResult({ results: [[{ transcript: '不该写回的文字' }]] });
  lateEnd();
  lateError({ error: 'aborted' });
  assert.equal(f.recognition.aborted, true);
  assert.deepEqual(f.text, ['已有文字']);
  assert.deepEqual(f.ended, []);
});

test('browser errors explain permission, network, device, and no-speech failures', () => {
  for (const [code, expected] of [
    ['not-allowed', /麦克风.*权限|权限.*麦克风/],
    ['network', /浏览器的语音识别服务/],
    ['audio-capture', /设备连接/],
    ['no-speech', /没有听清/],
  ]) {
    const f = fixture();
    f.session.start();
    f.recognition.onerror({ error: code });
    assert.match(f.ended[0].error, expected);
    assert.equal(f.states.at(-1), 'idle');
    assert.equal(f.recognition.onresult, null);
  }
});

test('a silent end and synchronous start denial are visible and leave manual input intact', () => {
  const silent = fixture('原来的草稿');
  silent.session.start();
  silent.recognition.onend();
  assert.match(silent.ended[0].error, /没有听清/);
  assert.deepEqual(silent.text, []);
  const denied = fixture();
  denied.recognition.start = () => { throw Object.assign(new Error(), { name: 'NotAllowedError' }); };
  denied.session.start();
  assert.match(denied.ended[0].error, /未获准/);
  assert.deepEqual(denied.states, ['starting', 'idle']);
});
