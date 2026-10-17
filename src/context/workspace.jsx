import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { getRequestMailboxId, request, setRequestMailboxId } from '@/lib/api';
import { syncChanges, withConflicts } from '@/lib/domain';
import { isActiveJob, useBackgroundJobs } from '@/hooks/use-background-jobs';

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
  const [selectedEmailMailboxId, setSelectedEmailMailboxId] = useState(() => new URLSearchParams(window.location.search).get('mailbox'));
  const [highlightQuote, setHighlightQuote] = useState('');
  const [invoiceExtracting, setInvoiceExtracting] = useState('');
  const [selectedTraceId, setSelectedTraceId] = useState(null);
  const [eventModal, setEventModal] = useState(null);
  const [viewMode, setViewModeState] = useState(() => localStorage.getItem(VIEW_KEY) || 'active');
  const [commandOpen, setCommandOpen] = useState(false);
  const mailboxEpoch = useRef(0);
  const notifiedAutoSyncId = useRef(null);
  const initialMailboxChecked = useRef(false);
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  const [jobsVersion, setJobsVersion] = useState(0);
  const events = useMemo(() => withConflicts(state?.events), [state?.events]);
  const tasks = state?.tasks || [];
  const emails = state?.emails || [];
  const selectedEmail = emails.find((email) => email.id === selectedEmailId
    && (!selectedEmailMailboxId || !email.mailboxId || email.mailboxId === selectedEmailMailboxId));
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

  const backgroundJobs = useBackgroundJobs(state?.settings.activeMailboxId || '', () => {
    setJobsVersion((value) => value + 1);
    reload().catch(() => {});
  });
  const isSyncing = syncing || Boolean(traceData.sync?.running || state?.sync?.running)
    || backgroundJobs.jobs.some((job) => ['mail-sync', 'mail_sync', 'mail.sync'].includes(job.kind) && isActiveJob(job));

  async function setViewMode(mode) {
    const next = mode || 'active';
    localStorage.setItem(VIEW_KEY, next);
    viewModeRef.current = next;
    setViewModeState(next);
    mailboxEpoch.current += 1;
    setSelectedEmailId(null);
    setSelectedEmailMailboxId(null);
    await reload();
  }

  function resetMailboxContext(mailboxId) {
    mailboxEpoch.current += 1;
    setRequestMailboxId(mailboxId);
    setState(null);
    setSelectedEmailId(null);
    setSelectedEmailMailboxId(null);
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
        setSelectedEmailMailboxId(settings.activeMailboxId);
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

  function openEmail(id, mailboxId = null, quote = '') {
    const email = emails.find((item) => item.id === id && (!mailboxId || !item.mailboxId || item.mailboxId === mailboxId));
    if (!email) {
      toast.error('本地没有找到这封邮件');
      return;
    }
    setSelectedEmailId(id);
    setHighlightQuote(typeof quote === 'string' ? quote : '');
    const sourceMailboxId = email.mailboxId || mailboxId || state?.settings.activeMailboxId;
    setSelectedEmailMailboxId(sourceMailboxId || null);
    const url = new URL(window.location.href);
    url.searchParams.set('email', id);
    if (sourceMailboxId) url.searchParams.set('mailbox', sourceMailboxId);
    if (window.location.href !== url.href) window.history.pushState({}, '', url);
  }

  function closeEmail() {
    setSelectedEmailId(null);
    setSelectedEmailMailboxId(null);
    setHighlightQuote('');
    const url = new URL(window.location.href);
    url.searchParams.delete('email');
    window.history.replaceState({}, '', url);
  }

  async function sync(mode) {
    if (mode === 'qq') {
      const mailboxReady = Boolean(state.settings.mailboxReady);
      const modelReady = Boolean(state.settings.modelReady);
      if (!mailboxReady || !modelReady) {
        const tip = !mailboxReady && !modelReady
          ? '请先完成邮箱与模型配置'
          : !mailboxReady
            ? '邮箱尚未配置完整（地址、授权码、收发服务器），请到设置 → 邮箱填写并保存'
            : '模型尚未配置：请到设置 → 模型填写 API Key 并保存（仅配邮箱不能同步）';
        toast.message(tip);
        return {
          needSettings: true,
          needMailbox: !mailboxReady,
          needModel: !modelReady,
          settingsTab: !mailboxReady ? 'mailbox' : 'model',
        };
      }
    }
    setSyncing(true);
    setSelectedTraceId(null);
    const epoch = mailboxEpoch.current;
    try {
      const result = await request(`/sync/${mode}`, 'POST', undefined, { idempotencyKey: crypto.randomUUID() });
      if (epoch !== mailboxEpoch.current) return result;
      if (result.job) {
        backgroundJobs.trackJob(result.job);
        setSyncResult(null);
        toast.message('同步任务已提交，可在「后台任务」查看进度');
        return result;
      }
      setSyncResult(result);
      await reload();
      const changes = syncChanges(result);
      if (result.errors?.length) toast.error(`${changes ? `${changes}。` : ''}${result.errors.length} 封处理失败`);
      else if (changes) toast.success(changes);
      else toast.message(result.duplicate ? `${result.duplicate} 封已处理，已跳过` : '没有新增日程、待办或发票');
      return result;
    } catch (error) {
      toast.error('同步未完成，请检查邮箱与模型配置后重试。');
      await reload().catch(() => {});
      throw error;
    } finally {
      setSyncing(false);
    }
  }

  async function extractInvoices(email) {
    const mailboxId = email.mailboxId || state?.settings.activeMailboxId || '';
    setInvoiceExtracting(`${mailboxId}:${email.id}`);
    try {
      const result = await request(`/emails/${encodeURIComponent(email.id)}/extract-invoices`, 'POST', {}, { mailboxId });
      await reload();
      const updated = result.email || result;
      const count = updated.extraction?.invoices?.length || 0;
      if (updated.invoiceStatus === 'failed') toast.error('发票提取失败，可查看原件并重试');
      else if (updated.invoiceStatus === 'partial') toast.message(`已提取 ${count} 张发票，部分附件待重试`);
      else if (count) toast.success(`已提取 ${count} 张发票`);
      else toast.message('未在附件中识别到发票，请查看原件');
      return updated;
    } catch (error) {
      toast.error(error.message);
      await reload().catch(() => {});
      throw error;
    } finally {
      setInvoiceExtracting('');
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

  async function changeTaskStatus(id, status, extra = {}) {
    try {
      await request(`/tasks/${encodeURIComponent(id)}`, 'PUT', { status, ...extra });
      await reload();
      toast.success(status === 'done' ? '待办已完成' : '待办已恢复');
    } catch (error) {
      toast.error(error.message);
      throw error;
    }
  }

  async function updateTask(id, patch) {
    try {
      await request(`/tasks/${encodeURIComponent(id)}`, 'PUT', patch);
      await reload();
      toast.success('待办已更新');
    } catch (error) {
      toast.error(error.message);
      throw error;
    }
  }

  async function saveSettings(data) {
    const settings = await request('/settings', 'PUT', data);
    if (settings.activeMailboxId !== getRequestMailboxId()) resetMailboxContext(settings.activeMailboxId);
    await reload();
    if (settings.mailboxReady && !settings.modelReady) {
      toast.message('邮箱已保存。同步还需要模型 API Key：请打开「模型」页填写并保存');
    } else if (!settings.mailboxReady && settings.modelReady) {
      toast.message('模型已保存。同步还需要完善邮箱授权码与服务器');
    } else if (settings.syncStarted) {
      toast.success(`已保存并切换到 ${settings.email || '当前邮箱'}`);
    } else {
      toast.success('配置已保存');
    }
    return settings;
  }

  async function clearDemo() {
    await request('/demo', 'DELETE');
    await reload();
    toast.success('已清除示例数据');
  }

  async function feedbackTrace(traceId, action, draft) {
    const epoch = mailboxEpoch.current;
    const trace = traceData.traces.find((item) => item.trace_id === traceId);
    const sending = action === 'accepted' && trace?.mode === 'qq';
    if (sending) {
      const recipient = emails.find((email) => email.trace_id === traceId);
      const body = draft ?? recipient?.userDraft ?? trace?.user_draft ?? recipient?.draftReply ?? trace?.draft_reply ?? '';
      const ok = window.confirm(
        `确认发送回复？\n\n收件人：${recipient?.replyTo || recipient?.sender || '来信者'}\n主题：Re: ${recipient?.subject || trace?.subject || ''}\n\n正文预览：\n${String(body).slice(0, 280)}${String(body).length > 280 ? '…' : ''}`,
      );
      if (!ok) return;
    }
    const updated = sending
      ? await request(`/traces/${encodeURIComponent(traceId)}/send`, 'POST')
      : await request(`/traces/${encodeURIComponent(traceId)}/feedback`, 'PUT', { action, ...(draft === undefined ? {} : { draft }) });
    if (epoch !== mailboxEpoch.current) return;
    setTraceData((current) => ({
      ...current,
      traces: current.traces.map((item) => (item.trace_id === traceId ? updated : item)),
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
      } else {
        setSelectedEmailId(params.get('email'));
        setSelectedEmailMailboxId(params.get('mailbox'));
      }
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
    state, loadError, reload, events, tasks, emails, selectedEmail, selectedEmailId, highlightQuote,
    traceData, selectedTraceId, setSelectedTraceId, syncResult, isSyncing,
    eventModal, setEventModal, openEmail, closeEmail, switchMailbox, sync,
    saveEvent, deleteEvent, changeTaskStatus, updateTask, saveSettings, clearDemo, feedbackTrace,
    viewMode, setViewMode, isMixedView, commandOpen, setCommandOpen,
    invoiceExtracting, extractInvoices,
    ...backgroundJobs, jobsVersion,
  };

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return value;
}
