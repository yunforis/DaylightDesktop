import React, { useMemo, useState } from 'react';
import { LoaderCircle, Mail, Trash2 } from 'lucide-react';
import { EventAftermathPanel } from '@/components/event-aftermath-panel';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useWorkspace } from '@/context/workspace';
import { createdIds, findManualConflicts, isCancelled, eventStatus } from '@/lib/domain';
import { clock, eventRange, shanghaiDate, shiftDay, today } from '@/lib/time';

function linkedMails(event, emails) {
  if (!event) return [];
  const byId = new Map();

  function push(item) {
    if (!item?.id || byId.has(item.id)) return;
    const email = emails.find((entry) => entry.id === item.id);
    byId.set(item.id, {
      ...item,
      subject: email?.subject || item.subject || item.id,
      sender: email?.sender || item.sender || '',
      available: Boolean(email),
      bodyPreview: email?.body ? String(email.body).slice(0, 120) : '',
    });
  }

  push(event.emailId && {
    id: event.emailId,
    role: '来源邮件',
    subject: event.emailSubject,
    sender: event.emailSender,
  });
  push((event.changeEmailId || event.cancelledByEmailId) && {
    id: event.changeEmailId || event.cancelledByEmailId,
    role: isCancelled(event) ? '取消通知' : '变更邮件',
    subject: event.changeEmailSubject,
    sender: event.changeEmailSender,
  });

  for (const email of emails || []) {
    const related = createdIds(email).includes(event.id)
      || (email.cancelledEventIds || []).includes(event.id)
      || (email.rescheduledEventIds || []).includes(event.id)
      || (email.eventIds || []).includes(event.id);
    if (related) {
      push({
        id: email.id,
        role: email.status === 'filtered' ? '已过滤邮件' : '关联邮件',
        subject: email.subject,
        sender: email.sender,
      });
    }
  }

  return [...byId.values()];
}

export function EventDialog() {
  const {
    eventModal, setEventModal, events, emails, saveEvent, deleteEvent, openEmail, state, reload,
  } = useWorkspace();
  const categories = useMemo(() => {
    const list = (state?.settings?.calendarCategories || []).filter((item) => item && item.enabled !== false);
    return list.length ? list : [
      { id: 'work', label: '工作安排' },
      { id: 'personal', label: '生活日常' },
    ];
  }, [state?.settings?.calendarCategories]);
  const event = eventModal ? events.find((item) => item.id === eventModal.event?.id) || eventModal.event : null;
  const open = Boolean(eventModal);
  const cancelled = event && isCancelled(event);
  const related = useMemo(() => linkedMails(event, emails), [event, emails]);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflicts, setConflicts] = useState([]);
  const [forceSave, setForceSave] = useState(false);
  // 只在打开/切换目标时灌入表单；冲突提示等本地状态变化不得清空已填名称
  const openKey = eventModal
    ? (eventModal.event?.id || `new:${eventModal.date || ''}`)
    : '';

  React.useEffect(() => {
    if (!eventModal || !openKey) {
      setForm(null);
      setError('');
      setConflicts([]);
      setForceSave(false);
      return;
    }
    const current = events.find((item) => item.id === eventModal.event?.id) || eventModal.event;
    const fallbackCategory = categories[0]?.id || 'work';
    const category = categories.some((item) => item.id === current?.category) ? current.category : fallbackCategory;
    setForm({
      title: current?.title || '',
      startDate: current ? shanghaiDate(current.start) : eventModal.date || today,
      endDate: current ? shanghaiDate(current.allDay ? Date.parse(current.end) - 1 : current.end) : eventModal.date || today,
      startTime: current ? clock(current.start) : '09:00',
      endTime: current ? clock(current.end) : '10:00',
      allDay: current?.allDay || false,
      category,
      location: current?.location || '',
      description: current?.description || '',
    });
    setError('');
    setConflicts([]);
    setForceSave(false);
  }, [openKey]); // eslint-disable-line react-hooks/exhaustive-deps -- 刻意不跟 event/categories 重同步，避免冲突提示后清空输入

  if (!form) return null;
  const change = (key, value) => {
    setForceSave(false);
    setConflicts([]);
    setForm((current) => ({ ...current, [key]: value }));
  };

  function buildPayload() {
    const start = `${form.startDate}T${form.allDay ? '00:00' : form.startTime}:00+08:00`;
    const end = `${form.allDay ? shiftDay(form.endDate, 1) : form.endDate}T${form.allDay ? '00:00' : form.endTime}:00+08:00`;
    return {
      title: form.title.trim(), start, end, allDay: form.allDay,
      category: form.category, location: form.location, description: form.description,
    };
  }

  async function persist(payload) {
    setBusy(true); setError('');
    try {
      await saveEvent(eventModal, payload);
      setEventModal(null);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (cancelled) return;
    if (!form.title.trim()) { setError('请填写日程名称'); return; }
    const payload = buildPayload();
    if (Date.parse(payload.end) <= Date.parse(payload.start)) {
      setError('结束时间需要晚于开始时间');
      return;
    }
    if (!forceSave) {
      const hits = findManualConflicts(payload, events, event?.id);
      if (hits.length) {
        setConflicts(hits);
        setError('该时段已有其他日程，请确认是否仍要保存。');
        return;
      }
    }
    await persist(payload);
  }

  async function onForceSave() {
    if (cancelled || busy) return;
    if (!form.title.trim()) { setError('请填写日程名称'); return; }
    const payload = buildPayload();
    if (Date.parse(payload.end) <= Date.parse(payload.start)) {
      setError('结束时间需要晚于开始时间');
      return;
    }
    setForceSave(true);
    await persist(payload);
  }

  const eventEnded = Boolean(event?.end && Date.parse(event.end) <= Date.now());

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) setEventModal(null); }}>
      <DialogContent className={event ? 'sm:max-w-2xl max-h-[90vh] overflow-y-auto' : 'sm:max-w-lg'}>
        <DialogHeader>
          <DialogTitle>{cancelled ? `${eventStatus(event)}的原日程` : event ? '编辑日程' : '新建日程'}</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="title">名称</Label>
            <Input id="title" disabled={cancelled || busy} value={form.title} onChange={(e) => change('title', e.target.value)} placeholder="例如：产品评审" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>开始日期</Label>
              <Input type="date" disabled={cancelled || busy} value={form.startDate} onChange={(e) => {
                change('startDate', e.target.value);
                if (e.target.value > form.endDate) change('endDate', e.target.value);
              }} />
            </div>
            <div className="space-y-2">
              <Label>结束日期</Label>
              <Input type="date" disabled={cancelled || busy} min={form.startDate} value={form.endDate} onChange={(e) => change('endDate', e.target.value)} />
            </div>
          </div>
          {!form.allDay && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>开始时间</Label>
                <Input type="time" disabled={cancelled || busy} value={form.startTime} onChange={(e) => change('startTime', e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>结束时间</Label>
                <Input type="time" disabled={cancelled || busy} value={form.endTime} onChange={(e) => change('endTime', e.target.value)} />
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Checkbox id="allDay" checked={form.allDay} disabled={cancelled || busy} onCheckedChange={(checked) => change('allDay', Boolean(checked))} />
            <Label htmlFor="allDay">全天</Label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>分类</Label>
              <Select disabled={cancelled || busy} value={form.category} onValueChange={(value) => change('category', value)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {categories.map((item) => (
                    <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>地点</Label>
              <Input disabled={cancelled || busy} value={form.location} onChange={(e) => change('location', e.target.value)} placeholder="地点或会议链接" />
            </div>
          </div>
          <div className="space-y-2">
            <Label>备注</Label>
            <Textarea disabled={cancelled || busy} rows={3} value={form.description} onChange={(e) => change('description', e.target.value)} />
          </div>

          {event && (
            <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Mail className="size-3.5 text-muted-foreground" />
                关联邮件
              </div>
              {related.length ? (
                <div className="space-y-2">
                  {related.map((mail) => (
                    <button
                      key={`${mail.role}-${mail.id}`}
                      type="button"
                      disabled={!mail.available}
                      className="flex w-full flex-col gap-0.5 rounded-md border bg-background px-3 py-2 text-left transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => {
                        if (!mail.available) return;
                        setEventModal(null);
                        // 等弹窗关闭后再打开邮件，避免焦点冲突
                        queueMicrotask(() => openEmail(mail.id));
                      }}
                    >
                      <span className="text-[11px] text-muted-foreground">{mail.role}</span>
                      <span className="truncate text-sm font-medium">{mail.subject}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {mail.available
                          ? (mail.sender || '点击查看原文')
                          : '本地未找到该邮件原文'}
                      </span>
                      {mail.bodyPreview && (
                        <span className="mt-1 line-clamp-2 text-[11px] text-muted-foreground/80">{mail.bodyPreview}</span>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  暂无关联邮件。从邮箱同步生成的日程会出现在这里；手动新建的日程不会自动挂邮件。
                </p>
              )}
            </div>
          )}

          {event?.id && (
            <EventAftermathPanel
              eventId={event.id}
              ended={eventEnded}
              onChanged={() => reload().catch(() => {})}
            />
          )}

          {conflicts.length > 0 && (
            <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
              <p className="font-medium text-amber-900 dark:text-amber-100">时段冲突 · {conflicts.length} 项</p>
              <ul className="space-y-1.5">
                {conflicts.slice(0, 5).map((item) => (
                  <li key={item.id} className="text-xs leading-relaxed text-amber-950/80 dark:text-amber-50/80">
                    <span className="font-medium">{item.title || '未命名'}{item.workbenchName ? ` · ${item.workbenchName}` : ''}</span>
                    <span className="mt-0.5 block text-muted-foreground">{eventRange(item)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">可改时间后重试，或确认仍要保存（日程会照常写入）。</p>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="gap-2 sm:justify-between">
            {event ? (
              <Button type="button" variant="destructive" disabled={busy} onClick={async () => {
                setBusy(true);
                try { await deleteEvent(event.id); setEventModal(null); }
                catch (err) { setError(err.message); setBusy(false); }
              }}>
                <Trash2 className="size-4" />删除
              </Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setEventModal(null)}>关闭</Button>
              {!cancelled && conflicts.length > 0 && (
                <Button type="button" variant="secondary" disabled={busy} onClick={onForceSave}>
                  {busy && <LoaderCircle className="size-4 animate-spin" />}仍要保存
                </Button>
              )}
              {!cancelled && conflicts.length === 0 && (
                <Button type="submit" disabled={busy}>
                  {busy && <LoaderCircle className="size-4 animate-spin" />}保存
                </Button>
              )}
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
