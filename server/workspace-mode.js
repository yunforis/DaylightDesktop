/** Legacy storage normalization only. Account types no longer grant capabilities. */
export function normalizeWorkspaceMode(value) {
  return String(value || '').trim().toLowerCase() === 'hr' ? 'hr' : 'personal';
}

function parseChangeAt(entry) {
  if (!entry) return null;
  if (typeof entry === 'string' || typeof entry === 'number') {
    const ms = new Date(entry).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = new Date(entry.at || entry.changedAt || '').getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function normalizeWorkspaceModeChanges(raw) {
  if (!Array.isArray(raw)) return [];
  const items = [];
  for (const entry of raw) {
    const atMs = parseChangeAt(entry);
    if (atMs == null) continue;
    const from = normalizeWorkspaceMode(entry?.from);
    const to = normalizeWorkspaceMode(entry?.to ?? entry?.mode);
    items.push({
      at: new Date(atMs).toISOString(),
      from: typeof entry === 'object' && entry?.from != null ? from : (to === 'hr' ? 'personal' : 'hr'),
      to,
    });
  }
  items.sort((a, b) => a.at.localeCompare(b.at));
  return items;
}

// Keep old clients compatible without publishing identity or switching quotas.
export function workspaceModePublicMeta() {
  return { hasRecruitment: true };
}
