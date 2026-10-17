/** 可配置全局快捷键（存 localStorage）。 */

export const HOTKEY_DEFAULTS = {
  search: { label: '打开搜索', key: 'mod+j' },
  newEvent: { label: '新建日程', key: 'mod+n' },
  sync: { label: '同步邮箱', key: 'mod+shift+s' },
  goOverview: { label: '前往总览', key: 'g o' },
  goCalendar: { label: '前往日历', key: 'g c' },
  goTodos: { label: '前往待办', key: 'g t' },
  goMail: { label: '前往邮件', key: 'g m' },
  goSettings: { label: '前往设置', key: 'g s' },
};

const STORAGE_KEY = 'daylight.hotkeys.v1';

export function readHotkeys() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return Object.fromEntries(
      Object.entries(HOTKEY_DEFAULTS).map(([id, item]) => [
        id,
        { ...item, key: String(raw[id]?.key || item.key).toLowerCase() },
      ]),
    );
  } catch {
    return structuredClone(HOTKEY_DEFAULTS);
  }
}

export function saveHotkeys(next) {
  const payload = Object.fromEntries(
    Object.entries(next).map(([id, item]) => [id, { key: String(item.key || '').toLowerCase() }]),
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  return readHotkeys();
}

export function resetHotkeys() {
  localStorage.removeItem(STORAGE_KEY);
  return readHotkeys();
}

export function formatHotkey(hotkey) {
  return String(hotkey || '')
    .replaceAll('mod', /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl')
    .replaceAll('shift', '⇧')
    .replaceAll('alt', '⌥')
    .replaceAll('+', ' + ')
    .toUpperCase();
}

function eventMatches(hotkey, event, sequence) {
  const parts = String(hotkey || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    const next = [...sequence, eventKey(event)].slice(-parts.length);
    return next.join(' ') === parts.join(' ');
  }
  const chord = parts[0] || '';
  const wantMod = chord.includes('mod');
  const wantShift = chord.includes('shift');
  const wantAlt = chord.includes('alt');
  const key = chord.split('+').filter((part) => !['mod', 'shift', 'alt', 'ctrl', 'meta'].includes(part)).pop();
  const modPressed = event.metaKey || event.ctrlKey;
  if (Boolean(wantMod) !== Boolean(modPressed)) return false;
  if (Boolean(wantShift) !== Boolean(event.shiftKey)) return false;
  if (Boolean(wantAlt) !== Boolean(event.altKey)) return false;
  return eventKey(event) === key;
}

function eventKey(event) {
  const key = String(event.key || '').toLowerCase();
  if (key === ' ') return 'space';
  if (key === 'escape') return 'esc';
  return key.length === 1 ? key : key;
}

export function matchHotkey(hotkeys, event, sequence = []) {
  if (event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) {
    // allow search chord even in inputs only for Escape
    if (event.key !== 'Escape') return null;
  }
  for (const [id, item] of Object.entries(hotkeys)) {
    if (eventMatches(item.key, event, sequence)) return id;
  }
  return null;
}
