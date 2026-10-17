import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findMatchingFilter, matchCondition, matchFilterRule } from './mail-filters.js';

describe('mail filters', () => {
  it('matches subject contains', () => {
    const email = { subject: '【限时秒杀】今日特惠', sender: 'a@b.com', body: '' };
    assert.equal(matchCondition(email, { field: 'subject', op: 'contains', value: '限时秒杀' }), true);
    assert.equal(matchCondition(email, { field: 'subject', op: 'contains', value: '会议' }), false);
  });

  it('matches sender domain', () => {
    const email = { subject: 'Hi', sender: 'News <promo@mail.mailchimp.com>', body: '' };
    assert.equal(matchCondition(email, { field: 'from', op: 'domain', value: 'mailchimp.com' }), true);
    assert.equal(matchCondition(email, { field: 'from', op: 'domain', value: 'qq.com' }), false);
  });

  it('supports all vs any', () => {
    const email = { subject: '发票报销', sender: 'boss@corp.com', body: '请本周提交' };
    const ruleAll = {
      enabled: true,
      match: 'all',
      conditions: [
        { field: 'subject', op: 'contains', value: '发票' },
        { field: 'from', op: 'contains', value: 'boss@' },
      ],
    };
    const ruleAny = {
      enabled: true,
      match: 'any',
      conditions: [
        { field: 'subject', op: 'contains', value: '秒杀' },
        { field: 'from', op: 'contains', value: 'boss@' },
      ],
    };
    assert.equal(matchFilterRule(email, ruleAll), true);
    assert.equal(matchFilterRule(email, ruleAny), true);
    assert.equal(matchFilterRule(email, { ...ruleAll, conditions: [...ruleAll.conditions, { field: 'subject', op: 'contains', value: '不存在' }] }), false);
  });

  it('finds first enabled matching filter', () => {
    const email = { subject: '请退订本邮件', sender: 'noreply@ads.com', body: '' };
    const hit = findMatchingFilter(email, [
      { id: '1', name: '推广', enabled: true, match: 'any', conditions: [{ field: 'subject', op: 'contains', value: '退订' }] },
    ]);
    assert.equal(hit?.id, '1');
  });

  it('supports wildcard and regex', () => {
    const email = { subject: 'Weekly Digest #42', sender: 'x@y.com', body: '' };
    assert.equal(matchCondition(email, { field: 'subject', op: 'wildcard', value: 'Weekly*' }), true);
    assert.equal(matchCondition(email, { field: 'subject', op: 'regex', value: 'Digest\\s+#\\d+' }), true);
  });
});
