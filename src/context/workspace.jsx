import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { getRequestMailboxId, request, setRequestMailboxId } from '@/lib/api';
import { syncChanges, withConflicts } from '@/lib/domain';

const WorkspaceContext = createContext(null);
const VIEW_KEY = 'daylight.mailbox-view';

function viewQuery(viewMode) {
  if (viewMode === 'all') return { state: '/state?scope=all', traces: '/traces?scope=all' };
  if (String(viewMode).startsWith('tag:')) {
    const tag = encodeURIComponent(viewMode.slice(4));
    return { state: `/state?tag=${tag}`, traces: '/traces?scope=all' };
  }
  return { state: '/state', traces: '/traces' };
}

export function WorkspaceProvider({ children }) {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [traceData, setTraceData] = useState({ traces: [], sync: {} });
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [selectedEmailId, setSelectedEmailId] = useState(() => new URLSearchParams(window.location.search).get('email'));
  const [selectedTraceId, setSelectedTraceId] = useState(null);
  const [eventModal, setEventModal] = useState(null);
  const [viewMode, setViewModeState] = useState(() => localStorage.getItem(VIEW_KEY) || 'active');
  const [commandOpen, setCommandOpen] = useState(false);
  const mailboxEpoch = useRef(0);
  const notifiedAutoSyncId = useRef(null);
  const initialMailboxChecked = useRef(false);
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  const isSyncing = syncing || Boolean(traceData.sync?.running || state?.sync?.running);
  const events = useMemo(() => withConflicts(state?.events), [state?.events]);
  const tasks = state?.tasks || [];
  const emails = state?.emails || [];
  const selectedEmail = emails.find((email) => email.id === selectedEmailId);
  const isMixedView = viewMode === 'all' || String(viewMode).startsWith('tag:');

  const applyData = useCallback((calendar, logs) => {
    const writeMailboxId = calendar.settings?.activeMailboxId || '';
    const viewMailboxId = calendar.mailboxId || writeMailboxId;
    if (
      getRequestMailboxId()
      && writeMailboxId
      && writeMailboxId !== getRequestMailboxId()
      && viewMailboxId !== 'all'
      && !String(calendar.viewScope || '').startsWith('tag:')
    ) {
      mailboxEpoch.current += 1;
    }
    if (writeMailboxId) setRequestMailboxId(writeMailboxId);
    setState(calendar);
    setLoadError('');
    if (logs.status === 'fulfilled') {
      const logBox = logs.value.mailboxId;
      if (!logBox || logBox === viewMailboxId || logBox === 'all' || viewMailboxId === 'all') {
        setTraceData(logs.value);
      }
    } else if (logs.status === 'rejected') {
      toast.error(logs.reason.message);
    } else {
      setTraceData({ traces: [], sync: {} });
    }
  }, []);

  const reload = useCallback(async () => {
    const epoch = mailboxEpoch.current;
    const urls = viewQuery(viewModeRef.current);
    const [calendar, logs] = await Promise.allSettled([request(urls.state), request(urls.traces)]);
    if (calendar.status === 'rejected') {
      if (epoch === mailboxEpoch.current) setLoadError(calendar.reason.message);
      throw calendar.reason;
    }
    // Still apply when this call is the latest; ignore only if a newer mailbox switch started.
    if (epoch !== mailboxEpoch.current) return;
    applyData(calendar.value, logs);
  }, [applyData]);

  async function setViewMode(mode) {
    const next = mode || 'active';
    localStorage.setItem(VIEW_KEY, next);
    viewModeRef.current = next;
    setViewModeState(next);
    mailboxEpoch.current += 1;
    setSelectedEmailId(null);
    await reload();
  }

  function resetMailboxContext(mailboxId) {
    mailboxEpoch.current += 1;
    setRequestMailboxId(mailboxId);
    setState(null);
    setSelectedEmailId(null);
    setSelectedTraceId(null);
    setSyncResult(null);
    setEventModal(null);
    setTraceData({ traces: [], sync: {} });
    const url = new URL(window.location.href);
    url.searchParams.delete('email');
    if (mailboxId) url.searchParams.set('mailbox', mailboxId);
    window.history.replaceState({}, '', url);
  }

  async function switchMailbox(mailboxId, emailId = null) {
    setSyncing(true);
    try {
      const settings = await request(`/mailboxes/${encodeURIComponent(mailboxId)}/activate`, 'POST');
      localStorage.setItem(VIEW_KEY, 'active');
      viewModeRef.current = 'active';
      setViewModeState('active');
      resetMailboxContext(settings.activeMailboxId);
      await reload();
      if (emailId) {
        setSelectedEmailId(emailId);
        const url = new URL(window.location.href);
        url.searchParams.set('email', emailId);
        window.history.replaceState({}, '', url);
      }
      toast.success(settings.syncStarted
        ? `已切换到 ${settings.email}，正在同步`
        : `已切换到 ${settings.email || '当前邮箱'}`);
    } finally {
      setSyncing(false);
    }
  }

  function openEmail(id) {
    if (!emails.some((email) => email.id === id)) {
      toast.error('本地没有找到这封邮件');
      return;
    }
    setSelectedEmailId(id);
    const url = new URL(window.location.href);
    url.searchParams.set('email', id);
    if (state?.settings.activeMailboxId) url.searchParams.set('mailbox', state.settings.activeMailboxId);
    if (window.location.href !== url.href) window.history.pushState({}, '', url);
  }

  function closeEmail() {
    setSelectedEmailId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('email');
    window.history.replaceState({}, '', url);
  }

  async function sync(mode) {
    if (mode === 'qq' && (!state.settings.mailboxReady || !state.settings.modelReady)) {
      toast.message('请先完成邮箱与模型配置');
      return { needSettings: true };
    }
    setSyncing(true);
    setSelectedTraceId(null);
    try {
      const result = await request(`/sync/${mode}`, 'POST');
      setSyncResult(result);
      await reload();
      const changes = syncChanges(result);
      if (result.errors.length) toast.error(`${changes ? `${changes}。` : ''}${result.errors.length} 封处理失败`);
      else if (changes) toast.success(changes);
      else toast.message(result.duplicate ? `${result.duplicate} 封已处理，已跳过` : '没有新增日程或待办');
      return result;
    } catch (error) {
      toast.error(error.message);
      await reload().catch(() => {});
      throw error;
    } finally {
      setSyncing(false);
    }
  }

  async function saveEvent(modal, data) {
    await request(`/events${modal.event ? `/${modal.event.id}` : ''}`, modal.event ? 'PUT' : 'POST', data);
    await reload();
    toast.success(modal.event ? '日程已更新' : '日程已创建');
  }

  async function deleteEvent(id) {
    await request(`/events/${id}`, 'DELETE');
    await reload();
    toast.success('日程已删除');
  }

  async function changeTaskStatus(id, status) {
    await request(`/tasks/${encodeURIComponent(id)}`, 'PUT', { status });
    await reload();
    toast.success(status === 'done' ? '待办已完成' : '待办已恢复');
  }

  async function saveSettings(data) {
    const settings = await request('/settings', 'PUT', data);
    if (settings.activeMailboxId !== getRequestMailboxId()) resetMailboxContext(settings.activeMailboxId);
    await reload();
    toast.success(settings.syncStarted ? `已保存并切换到 ${settings.email}` : '配置已保存');
    return settings;
  }

  async function clearDemo() {
    await request('/demo', 'DELETE');
    await reload();
    toast.success('已清除示例数据');
  }

  async function feedbackTrace(traceId, action, draft) {
    const epoch = mailboxEpoch.current;
    const sending = action === 'accepted' && traceData.traces.find((trace) => trace.trace_id === traceId)?.mode === 'qq';
    const updated = sending
      ? await request(`/traces/${encodeURIComponent(traceId)}/send`, 'POST')
      : await request(`/traces/${encodeURIComponent(traceId)}/feedback`, 'PUT', { action, ...(draft === undefined ? {} : { draft }) });
    if (epoch !== mailboxEpoch.current) return;
    setTraceData((current) => ({
      ...current,
      traces: current.traces.map((trace) => (trace.trace_id === traceId ? updated : trace)),
    }));
    if (action === 'modified') {
      setState((current) => current
        ? { ...current, emails: current.emails.map((email) => (email.trace_id === traceId ? { ...email, userDraft: draft } : email)) }
        : current);
    }
    toast.success(sending ? '回复已发送' : action === 'accepted' ? '已记录采纳' : action === 'modified' ? '草稿已保存' : '已拒绝草稿');
  }

  useEffect(() => {
    setRequestMailboxId('');
    reload().catch((error) => setLoadError(error.message || '加载失败'));
    // 仅首屏拉取；reload 身份变化时不重置，避免打断进行中的请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const followUrl = () => {
      const params = new URLSearchParams(window.location.search);
      if (params.get('mailbox') && params.get('mailbox') !== getRequestMailboxId()) {
        switchMailbox(params.get('mailbox'), params.get('email')).catch((error) => toast.error(error.message));
      } else setSelectedEmailId(params.get('email'));
    };
    window.addEventListener('popstate', followUrl);
    return () => window.removeEventListener('popstate', followUrl);
  }, []);

  useEffect(() => {
    if (!state || initialMailboxChecked.current) return;
    initialMailboxChecked.current = true;
    const mailboxId = new URLSearchParams(window.location.search).get('mailbox');
    if (mailboxId && mailboxId !== state.settings.activeMailboxId) {
      switchMailbox(mailboxId, new URLSearchParams(window.location.search).get('email'))
        .catch(async (error) => {
          resetMailboxContext(getRequestMailboxId());
          await reload().catch(() => {});
          toast.error(error.message);
        });
    }
  }, [state]);

  useEffect(() => {
    const mailboxId = new URLSearchParams(window.location.search).get('mailbox');
    if (state && selectedEmailId && !selectedEmail && (!mailboxId || mailboxId === state.settings.activeMailboxId)) {
      toast.error('本地没有找到这封邮件');
      closeEmail();
    }
  }, [state, selectedEmailId, selectedEmail]);

  useEffect(() => {
    let stopped = false;
    let timer;
    async function poll() {
      const epoch = mailboxEpoch.current;
      const urls = viewQuery(viewModeRef.current);
      const [calendar, logs] = await Promise.allSettled([request(urls.state), request(urls.traces)]);
      if (stopped) return;
      if (epoch === mailboxEpoch.current && calendar.status === 'fulfilled') applyData(calendar.value, logs);
      timer = setTimeout(poll, isSyncing ? 700 : 5000);
    }
    timer = setTimeout(poll, isSyncing ? 100 : 5000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [isSyncing, state?.settings.activeMailboxId, viewMode, applyData]);

  useEffect(() => {
    const current = traceData.sync;
    if (!current?.id || current.running || !['auto', 'mailbox-switch'].includes(current.trigger) || current.id === notifiedAutoSyncId.current) return;
    notifiedAutoSyncId.current = current.id;
    setSyncResult(current.result || null);
    if (current.error) toast.error(`${current.trigger === 'auto' ? '自动同步' : '切换同步'}失败：${current.error}`);
    else if (current.result) {
      const changes = syncChanges(current.result);
      if (changes) toast.success(changes);
    }
  }, [traceData.sync]);

  const value = {
    state, loadError, reload, events, tasks, emails, selectedEmail, selectedEmailId,
    traceData, selectedTraceId, setSelectedTraceId, syncResult, isSyncing,
    eventModal, setEventModal, openEmail, closeEmail, switchMailbox, sync,
    saveEvent, deleteEvent, changeTaskStatus, saveSettings, clearDemo, feedbackTrace,
    viewMode, setViewMode, isMixedView, commandOpen, setCommandOpen,
  };

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return value;
}
