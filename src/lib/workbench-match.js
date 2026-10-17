export function workbenchIdsOf(record) {
  const ids = [];
  if (record?.workbenchId) ids.push(record.workbenchId);
  for (const id of record?.workbenchIds || []) if (id && !ids.includes(id)) ids.push(id);
  return ids;
}

/** workbenches 为 null 表示名单尚未载入，有归属的记录先不当作已删除。 */
export function matchesWorkbench(record, filter, workbenches = null) {
  if (filter === 'all') return true;
  const ids = workbenchIdsOf(record);
  const live = Array.isArray(workbenches) ? new Set(workbenches.map((workbench) => workbench.id)) : null;
  if (filter === 'none') {
    if (!ids.length) return true;
    return Boolean(live) && ids.every((id) => !live.has(id));
  }
  return ids.includes(filter);
}
