import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesWorkbench } from '../src/lib/workbench-match.js';

const live = [{ id: 'keep', name: '保研' }];

test('已删除工作台的日程和待办归入未归属，名单未载入时不误判', () => {
  const orphan = { workbenchId: 'gone', title: '旧待办' };
  const kept = { workbenchIds: ['keep'], title: '仍在的日程' };
  const plain = { title: '手动待办' };
  assert.equal(matchesWorkbench(orphan, 'none', live), true);
  assert.equal(matchesWorkbench(kept, 'none', live), false);
  assert.equal(matchesWorkbench(plain, 'none', live), true);
  assert.equal(matchesWorkbench(kept, 'keep', live), true);
  assert.equal(matchesWorkbench(orphan, 'none', null), false);
  assert.equal(matchesWorkbench(plain, 'none', null), true);
  assert.equal(matchesWorkbench(orphan, 'all', null), true);
});
