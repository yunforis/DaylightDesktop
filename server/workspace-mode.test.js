import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWorkspaceMode, normalizeWorkspaceModeChanges, workspaceModePublicMeta } from './workspace-mode.js';
import { hasRecruitmentAccess } from '../src/lib/workspace-mode.js';

test('旧个人与 HR 账号均可使用招聘，不受历史次数限制', () => {
  for (const mode of ['personal', 'hr', undefined]) {
    const user = { id: 'user', workspaceMode: mode, hasRecruitment: false, workspace_mode_changes: Array(10).fill({ at: new Date().toISOString() }) };
    assert.equal(hasRecruitmentAccess(user), true);
    assert.deepEqual(workspaceModePublicMeta(user), { hasRecruitment: true });
  }
  assert.equal(hasRecruitmentAccess(null), false);
});

test('旧存储字段仍可读取，历史记录不迁移或清空', () => {
  assert.equal(normalizeWorkspaceMode('HR'), 'hr');
  assert.equal(normalizeWorkspaceMode(undefined), 'personal');
  const changes = [{ at: '2026-01-01T00:00:00.000Z', from: 'personal', to: 'hr' }];
  assert.deepEqual(normalizeWorkspaceModeChanges(changes), changes);
});
