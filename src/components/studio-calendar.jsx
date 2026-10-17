import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import { useCalendarController } from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/react/daygrid';
import timeGridPlugin from '@fullcalendar/react/timegrid';
import interactionPlugin from '@fullcalendar/react/interaction';
import classicThemePlugin from '@fullcalendar/react/themes/classic';
import zhCnLocale from '@fullcalendar/react/locales/zh-cn';
import { differenceInCalendarDays } from 'date-fns';
import { createPortal } from 'react-dom';
import {
  Calendar as CalendarIcon, ChevronLeft, ChevronRight, Download, Eye, LoaderCircle,
  MessageSquare, Pencil, Plus, Share2, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import '@fullcalendar/react/skeleton.css';
import '@fullcalendar/react/themes/classic/theme.css';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useTheme } from '@/components/theme-provider';
import { request } from '@/lib/api';
import { isCancelled, isDeclined } from '@/lib/domain';
import { t } from '@/lib/i18n';
import { clock, eventTime, shanghaiDate } from '@/lib/time';
import { cn } from '@/lib/utils';

const CALENDAR_VIEW_KEY = 'daylight-calendar-view';
const VIEW_KEYS = [
  { key: 'dayGridMonth', labelKey: 'month' },
  { key: 'timeGridWeek', labelKey: 'week' },
  { key: 'timeGridDay', labelKey: 'day' },
];
function initialCalendarView() {
  try {
    const saved = localStorage.getItem(CALENDAR_VIEW_KEY);
    if (VIEW_KEYS.some((item) => item.key === saved)) return saved;
  } catch { /* 无本地存储时使用月视图 */ }
  return 'dayGridMonth';
}

const FALLBACK_CATEGORIES = [
  { id: 'work', label: '工作安排', color: '#3d7a5c' },
  { id: 'personal', label: '生活日常', color: '#a66b3d' },
];

const PLUGINS = [dayGridPlugin, timeGridPlugin, interactionPlugin, classicThemePlugin];
const LOCALES = [zhCnLocale];
const EVENT_TIME_FORMAT = {
  hour: 'numeric',
  minute: '2-digit',
  meridiem: false,
  hour12: false,
  omitZeroMinute: false,
};
const VIEWS = {
  dayGridMonth: { dayMaxEventRows: 4 },
  timeGridWeek: {
    allDaySlot: true,
    slotMinTime: '06:00:00',
    slotMaxTime: '22:00:00',
    scrollTime: '07:00:00',
    slotDuration: '00:30:00',
    slotLabelInterval: '01:00:00',
  },
  timeGridDay: {
    allDaySlot: true,
    slotMinTime: '06:00:00',
    slotMaxTime: '22:00:00',
    scrollTime: '07:00:00',
    slotDuration: '00:30:00',
    slotLabelInterval: '01:00:00',
  },
};

function shortTime(date) {
  if (!date) return '';
  return clock(date);
}

function sameDateInfo(a, b) {
  return a.title === b.title && a.days === b.days && a.eventCount === b.eventCount;
}

function formatRangeLabel(start, end) {
  if (!start || !end) return '';
  const fmt = (date) => clock(date);
  return `${fmt(start)} – ${fmt(end)}`;
}

export function StudioCalendar({
  events, onEvent, onNew, onDelete, onAskLittleD, categories, onCategoriesChange,
}) {
  const { locale } = useTheme();
  const controller = useCalendarController();
  const [view, setView] = useState(initialCalendarView);
  const [exporting, setExporting] = useState(false);
  const [eventMenu, setEventMenu] = useState(null);
  const categoryList = useMemo(() => {
    const list = (categories || []).filter((item) => item && item.enabled !== false);
    return list.length ? list : FALLBACK_CATEGORIES;
  }, [categories]);
  const categoryMap = useMemo(() => Object.fromEntries(categoryList.map((item) => [item.id, item])), [categoryList]);
  const [visible, setVisible] = useState({});
  const [editingCategories, setEditingCategories] = useState(false);
  const [draftCategories, setDraftCategories] = useState([]);
  const [savingCategories, setSavingCategories] = useState(false);
  const [dayMore, setDayMore] = useState(null);
  const [dateInfo, setDateInfo] = useState(() => ({
    title: new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long' }),
    days: 31,
    eventCount: 0,
  }));

  const dateInfoRef = useRef(dateInfo);
  const viewRef = useRef(view);
  const rangeRef = useRef({ start: null, end: null });
  const calendarFrameRef = useRef(null);
  const onEventRef = useRef(onEvent);
  const onNewRef = useRef(onNew);
  const onDeleteRef = useRef(onDelete);
  const onAskLittleDRef = useRef(onAskLittleD);
  dateInfoRef.current = dateInfo;
  viewRef.current = view;
  onEventRef.current = onEvent;
  onNewRef.current = onNew;
  onDeleteRef.current = onDelete;
  onAskLittleDRef.current = onAskLittleD;

  useEffect(() => {
    setVisible((current) => {
      const next = { ...current };
      for (const item of categoryList) {
        if (next[item.id] === undefined) next[item.id] = true;
      }
      return next;
    });
  }, [categoryList]);

  const activeEvents = useMemo(() => events.filter((event) => !isCancelled(event)), [events]);
  const defaultCategoryId = categoryList[0]?.id || 'work';
  const counts = useMemo(() => {
    const map = Object.fromEntries(categoryList.map((item) => [item.id, 0]));
    for (const event of activeEvents) {
      const id = categoryMap[event.category] ? event.category : defaultCategoryId;
      map[id] = (map[id] || 0) + 1;
    }
    return map;
  }, [activeEvents, categoryList, categoryMap, defaultCategoryId]);

  const fcEvents = useMemo(() => (
    activeEvents
      .filter((event) => {
        const id = categoryMap[event.category] ? event.category : defaultCategoryId;
        return visible[id] !== false;
      })
      .map((event) => {
        const category = categoryMap[event.category] ? event.category : defaultCategoryId;
        const meta = categoryMap[category] || { color: 'var(--cal-work)' };
        return {
          id: event.id,
          title: isDeclined(event) ? `不参加 · ${event.title}` : event.title,
          start: event.start,
          end: event.end,
          allDay: Boolean(event.allDay),
          extendedProps: { event, category, color: meta.color },
          classNames: [
            event.allDay ? 'fc-daylight-allday' : 'fc-daylight-timed',
            `fc-daylight-${category}`,
            isDeclined(event) ? 'fc-daylight-declined' : '',
          ],
          // 苹果日/周：半透明底 + 左边色条；全天保留色条胶囊
          backgroundColor: event.allDay ? meta.color : 'transparent',
          borderColor: meta.color,
          textColor: event.allDay ? '#fff' : 'var(--foreground)',
        };
      })
  ), [activeEvents, visible, categoryMap, defaultCategoryId]);
  const fcEventsRef = useRef(fcEvents);
  fcEventsRef.current = fcEvents;

  // datesSet 在 FullCalendar 的 layout 阶段触发；禁止在这里同步 setState，
  // 否则会和 options 重算互相顶，触发 Maximum update depth。
  const onDatesSet = useCallback((info) => {
    rangeRef.current = { start: info.start, end: info.end };
    const eventCount = fcEventsRef.current.filter((event) => {
      const start = new Date(event.start);
      return start >= info.start && start < info.end;
    }).length;
    const nextInfo = {
      title: info.view.title,
      days: Math.max(1, differenceInCalendarDays(info.view.currentEnd, info.view.currentStart)),
      eventCount,
    };
    const nextView = info.view.type;
    const infoChanged = !sameDateInfo(dateInfoRef.current, nextInfo);
    const viewChanged = viewRef.current !== nextView;
    if (!infoChanged && !viewChanged) return;

    queueMicrotask(() => {
      if (infoChanged && !sameDateInfo(dateInfoRef.current, nextInfo)) {
        dateInfoRef.current = nextInfo;
        setDateInfo(nextInfo);
      }
      if (viewChanged && viewRef.current !== nextView) {
        viewRef.current = nextView;
        setView(nextView);
      }
    });
  }, []);

  const renderEventContent = useCallback((arg) => {
    const color = arg.event.extendedProps.color || '#3d7a5c';
    const timeText = arg.timeText || shortTime(arg.event.start);
    const rangeText = formatRangeLabel(arg.event.start, arg.event.end);
    if (arg.event.allDay) {
      return (
        <div
          className="fc-daylight-pill truncate px-1.5 py-0.5 text-[11px] font-medium text-white"
          style={{ background: color }}
        >
          {arg.event.title}
        </div>
      );
    }
    if (arg.view.type.startsWith('dayGrid')) {
      // 月视图：苹果风格色条（左边色 + 浅底），超出 dayMaxEvents 走「另外 N 个」
      return (
        <div
          className="fc-daylight-row flex w-full min-w-0 items-center gap-1 rounded-sm px-1 py-px text-[11px]"
          style={{
            color: 'var(--foreground)',
            background: `color-mix(in oklab, ${color} 16%, transparent)`,
            borderLeft: `2.5px solid ${color}`,
          }}
        >
          <span className="min-w-0 flex-1 truncate font-medium">{arg.event.title}</span>
          <span className="ml-auto shrink-0 tabular-nums opacity-70">{timeText}</span>
        </div>
      );
    }
    // 周/日：苹果风格半透明块 + 左边色条（不用全描边，避免 classic 灰环）
    return (
      <div
        className="fc-daylight-block h-full min-w-0 overflow-hidden text-[11px]"
        style={{
          background: `color-mix(in oklab, ${color} 22%, transparent)`,
          borderLeftColor: color,
          color: 'var(--foreground)',
        }}
      >
        <div className="truncate font-semibold leading-tight tracking-tight">{arg.event.title}</div>
        <div className="fc-daylight-block-time truncate text-[10px] font-medium leading-tight text-muted-foreground">
          {rangeText || timeText}
        </div>
      </div>
    );
  }, []);

  const openEventList = useCallback((events, dateHint) => {
    const list = (events || []).filter(Boolean);
    const date = dateHint instanceof Date ? dateHint : new Date(dateHint || list[0]?.start || Date.now());
    const dateKey = shanghaiDate(date);
    setDayMore({
      dateKey,
      title: date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric' }),
      items: list.map((raw) => {
        const category = categoryMap[raw.category] ? raw.category : defaultCategoryId;
        const color = categoryMap[category]?.color || '#3d7a5c';
        return {
          id: raw.id,
          title: raw.title || '未命名',
          timeLabel: eventTime(raw),
          color,
          event: raw,
        };
      }),
    });
  }, [categoryMap, defaultCategoryId]);

  const onMoreLinkClick = useCallback((info) => {
    const segs = [...(info.allSegs || [])];
    segs.sort((a, b) => {
      const as = a.start?.getTime?.() ?? 0;
      const bs = b.start?.getTime?.() ?? 0;
      return as - bs;
    });
    const date = info.date instanceof Date ? info.date : new Date(info.date);
    openEventList(segs.map((seg) => seg.event?.extendedProps?.event).filter(Boolean), date);
    // 返回非 popover 的真值，阻止 FullCalendar 默认丑陋弹层
    return true;
  }, [openEventList]);

  // 苹果日历：重叠日程全部列排布；右键弹出日程操作菜单（避开全局菜单）
  const onEventDidMount = useCallback((info) => {
    const el = info.el;
    if (!el) return;
    el.setAttribute('data-context-own', '1');
    const handler = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const data = info.event.extendedProps?.event;
      if (!data) return;
      const pad = 8;
      const width = 200;
      const height = 280;
      const x = Math.min(event.clientX, window.innerWidth - width - pad);
      const y = Math.min(event.clientY, window.innerHeight - height - pad);
      setEventMenu({
        x: Math.max(pad, x),
        y: Math.max(pad, y),
        event: data,
        dateKey: shanghaiDate(data.start),
      });
    };
    el.addEventListener('contextmenu', handler);
    el._daylightCtx = handler;
  }, []);

  const onEventWillUnmount = useCallback((info) => {
    const el = info.el;
    if (el?._daylightCtx) {
      el.removeEventListener('contextmenu', el._daylightCtx);
      delete el._daylightCtx;
    }
  }, []);

  useEffect(() => {
    if (!eventMenu) return undefined;
    function close() { setEventMenu(null); }
    function onKey(event) { if (event.key === 'Escape') close(); }
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [eventMenu]);

  const renderDayCellTop = useCallback((arg) => {
    const date = arg.date instanceof Date ? arg.date : new Date(arg.date);
    const dateKey = date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const dayNum = Number(dateKey.slice(-2));
    return (
      <div className={cn('fc-daylight-cell-top', arg.isOther && 'is-other')}>
        <span className={cn('fc-daylight-day-num', arg.isToday && 'is-today')}>
          {dayNum}
        </span>
        <button
          type="button"
          className="fc-daylight-add"
          aria-label={`添加 ${dateKey} 日程`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onNewRef.current(dateKey);
          }}
        >
          <Plus className="size-3.5" strokeWidth={2.25} />
        </button>
      </div>
    );
  }, []);

  const onEventClick = useCallback((info) => {
    info.jsEvent.preventDefault();
    const event = info.event.extendedProps.event;
    if (event) onEventRef.current(event);
  }, []);

  // 月视图要等格子尺寸回调才给日程定位。部分环境下 ResizeObserver 不会在
  // 首次观察时回调，日程会留在 visibility:hidden。日程或视图变化后轻推一像素，
  // 让已挂上的观察者重算行高。
  useEffect(() => {
    const root = calendarFrameRef.current;
    if (!root) return undefined;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      const parents = [...root.querySelectorAll('[data-date] [role="list"]')]
        .map((list) => list.parentElement)
        .filter(Boolean);
      parents.forEach((parent) => {
        parent.style.height = `${parent.getBoundingClientRect().height + 0.5}px`;
      });
      inner = requestAnimationFrame(() => {
        parents.forEach((parent) => {
          parent.style.height = '';
        });
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [fcEvents, view]);

  // 筛选变化时只更新当前可见范围内的计数
  useEffect(() => {
    const { start, end } = rangeRef.current;
    if (!start || !end) return;
    const eventCount = fcEvents.filter((event) => {
      const eventStart = new Date(event.start);
      return eventStart >= start && eventStart < end;
    }).length;
    if (eventCount === dateInfoRef.current.eventCount) return;
    const next = { ...dateInfoRef.current, eventCount };
    dateInfoRef.current = next;
    setDateInfo(next);
  }, [fcEvents]);

  const zh = locale === 'zh-CN' || !locale;

  async function saveDraftCategories() {
    setSavingCategories(true);
    try {
      await request('/calendar-categories', 'PUT', {
        categories: draftCategories.map((item) => ({
          ...item,
          keywords: String(item.keywordsText || '')
            .split(/[,，、\n]/)
            .map((part) => part.trim())
            .filter(Boolean),
        })),
      });
      toast.success('分类已更新');
      setEditingCategories(false);
      await onCategoriesChange?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSavingCategories(false);
    }
  }

  function downloadIcs() {
    window.open('/api/calendar.ics', '_blank', 'noopener,noreferrer');
  }

  async function exportToExternal() {
    setExporting(true);
    try {
      const result = await request('/calendar-sync/export', 'POST', {});
      toast.success(result.message || '已导出到外部日历');
      await onCategoriesChange?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="studio-calendar flex h-[calc(100svh-5.5rem)] min-h-[640px] flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{dateInfo.title}</h1>
          <p className="text-sm text-muted-foreground">
            {zh
              ? `${dateInfo.days} 天 · ${dateInfo.eventCount} 项日程`
              : `${dateInfo.days} days - ${dateInfo.eventCount} events`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value="mine" onValueChange={() => {}}>
            <SelectTrigger className="w-[150px]">
              <CalendarIcon className="size-4 text-muted-foreground" />
              <SelectValue placeholder={t(locale, 'myCalendars')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mine">{t(locale, 'myCalendars')}</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center rounded-md border">
            <Button size="icon-sm" variant="ghost" onClick={() => controller.prev()}>
              <ChevronLeft className="size-4" />
            </Button>
            <Button size="sm" variant="ghost" className="rounded-none px-3" onClick={() => controller.today()}>
              {t(locale, 'today')}
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={() => controller.next()}>
              <ChevronRight className="size-4" />
            </Button>
          </div>

          <Select
            value={view}
            onValueChange={(value) => {
              viewRef.current = value;
              setView(value);
              try { localStorage.setItem(CALENDAR_VIEW_KEY, value); } catch { /* 忽略无法写入的本地存储 */ }
              controller.changeView(value);
            }}
          >
            <SelectTrigger className="w-[96px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {VIEW_KEYS.map((item) => (
                <SelectItem key={item.key} value={item.key}>{t(locale, item.labelKey)}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={exporting}>
                {exporting ? <LoaderCircle className="size-4 animate-spin" /> : <Share2 className="size-4" />}
                导出到外部日历
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>导出日程</DropdownMenuLabel>
              <DropdownMenuItem onClick={exportToExternal}>
                <Share2 className="size-4" />
                推送到已连接日历
              </DropdownMenuItem>
              <DropdownMenuItem onClick={downloadIcs}>
                <Download className="size-4" />
                下载 ICS（订阅到 Mac / iOS）
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => { window.location.href = '/app/settings?tab=calendar'; }}>
                管理 Google / Outlook / CalDAV…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button size="sm" onClick={() => {
            const date = controller.getDate() || new Date();
            onNew(date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }));
          }}>
            <Plus className="size-4" />{t(locale, 'addEvent')}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        <aside className="hidden w-48 shrink-0 space-y-3 rounded-xl border bg-muted/20 p-3 lg:block">
          <div className="flex items-center justify-between text-sm font-medium">
            <span>{t(locale, 'myCalendars')}</span>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="管理分类"
              onClick={() => {
                setDraftCategories(categoryList.map((item) => ({
                  ...item,
                  keywordsText: (item.keywords || []).join('、'),
                })));
                setEditingCategories(true);
              }}
            >
              <Pencil className="size-3.5" />
            </Button>
          </div>
          {categoryList.map((meta) => (
            <label key={meta.id} className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={visible[meta.id] !== false}
                onCheckedChange={(checked) => setVisible((current) => ({ ...current, [meta.id]: Boolean(checked) }))}
                style={{
                  borderColor: meta.color,
                  ...(visible[meta.id] !== false ? { backgroundColor: meta.color, color: '#fff' } : {}),
                }}
              />
              <span className="flex-1 truncate">{meta.label}</span>
              <span className="text-xs text-muted-foreground">{counts[meta.id] || 0}</span>
            </label>
          ))}
          <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
            work / personal 只是默认分类的 id，显示名可改；也可新增自己的分类。同步邮件时会按关键词归类。
          </p>
        </aside>

        <div ref={calendarFrameRef} className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border bg-background">
          <FullCalendar
            controller={controller}
            plugins={PLUGINS}
            locales={LOCALES}
            locale={zh ? 'zh-cn' : 'en'}
            timeZone="Asia/Shanghai"
            initialView={view}
            headerToolbar={false}
            height="100%"
            nowIndicator
            editable={false}
            selectable={false}
            dayMaxEvents={4}
            dayMaxEventRows={4}
            slotEventOverlap={false}
            eventMinHeight={22}
            eventShortHeight={28}
            moreLinkClassNames="fc-daylight-more"
            moreLinkClass={() => 'fc-daylight-more'}
            moreLinkContent={(arg) => `另外 ${arg.num} 个`}
            moreLinkClick={onMoreLinkClick}
            events={fcEvents}
            eventDisplay="block"
            displayEventTime
            eventTimeFormat={EVENT_TIME_FORMAT}
            views={VIEWS}
            eventContent={renderEventContent}
            dayCellTopContent={renderDayCellTop}
            eventClick={onEventClick}
            eventDidMount={onEventDidMount}
            eventWillUnmount={onEventWillUnmount}
            datesSet={onDatesSet}
          />
        </div>
      </div>

      {eventMenu && createPortal(
        <div
          className="fixed z-[120] min-w-48 overflow-hidden rounded-xl border bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-xl"
          style={{ left: eventMenu.x, top: eventMenu.y }}
          data-context-own
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="truncate px-2.5 py-1.5 text-[10px] font-medium text-muted-foreground">
            {eventMenu.event.title || '日程'}
          </div>
          {[
            {
              id: 'view',
              label: '查看',
              icon: Eye,
              onSelect: () => onEventRef.current?.(eventMenu.event),
            },
            {
              id: 'edit',
              label: '编辑',
              icon: Pencil,
              onSelect: () => onEventRef.current?.(eventMenu.event),
            },
            {
              id: 'new',
              label: '新增日程',
              icon: Plus,
              onSelect: () => onNewRef.current?.(eventMenu.dateKey),
            },
            {
              id: 'ask',
              label: '询问小 D',
              icon: MessageSquare,
              onSelect: () => {
                if (onAskLittleDRef.current) {
                  onAskLittleDRef.current(eventMenu.event);
                } else {
                  const title = eventMenu.event.title || '该日程';
                  const when = eventTime(eventMenu.event);
                  window.dispatchEvent(new CustomEvent('daylight:open-little-d', {
                    detail: {
                      prompt: `请帮我看看日程「${title}」（${when}），有什么需要注意或可以调整的？`,
                    },
                  }));
                }
              },
            },
            { id: 'sep', separator: true },
            {
              id: 'delete',
              label: '删除',
              icon: Trash2,
              destructive: true,
              onSelect: async () => {
                if (!window.confirm(`确定删除日程「${eventMenu.event.title || '未命名'}」？`)) return;
                try {
                  await onDeleteRef.current?.(eventMenu.event);
                } catch (error) {
                  toast.error(error?.message || '删除失败');
                }
              },
            },
          ].map((item) => {
            if (item.separator) return <div key={item.id} className="my-1 border-t" />;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-muted',
                  item.destructive && 'text-destructive',
                )}
                onClick={() => {
                  setEventMenu(null);
                  item.onSelect?.();
                }}
              >
                {Icon ? <Icon className="size-3.5 opacity-70" /> : null}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}

      <Dialog open={Boolean(dayMore)} onOpenChange={(open) => { if (!open) setDayMore(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{dayMore?.title || '当日日程'}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[min(60vh,24rem)] space-y-1 overflow-y-auto pr-1">
            {(dayMore?.items || []).map((item) => (
              <button
                key={item.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/60"
                onClick={() => {
                  if (item.event) onEvent(item.event);
                  setDayMore(null);
                }}
              >
                <span className="size-2 shrink-0 rounded-full" style={{ background: item.color }} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.title}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{item.timeLabel}</span>
              </button>
            ))}
            {!dayMore?.items?.length && (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">这一天没有日程</p>
            )}
          </div>
          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const key = dayMore?.dateKey;
                setDayMore(null);
                if (key) onNew(key);
              }}
            >
              <Plus className="size-3.5" />新建
            </Button>
            <Button type="button" variant="secondary" onClick={() => setDayMore(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editingCategories} onOpenChange={setEditingCategories}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>管理日历分类</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {draftCategories.map((item, index) => (
              <div key={item.id} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <Input
                    className="h-8 w-20"
                    type="color"
                    value={/^#/.test(item.color) ? item.color : '#64748b'}
                    onChange={(e) => setDraftCategories((current) => current.map((row, i) => (
                      i === index ? { ...row, color: e.target.value } : row
                    )))}
                  />
                  <Input
                    className="h-8 flex-1"
                    value={item.label}
                    onChange={(e) => setDraftCategories((current) => current.map((row, i) => (
                      i === index ? { ...row, label: e.target.value } : row
                    )))}
                  />
                  <span className="font-mono text-[10px] text-muted-foreground">{item.id}</span>
                </div>
                <Input
                  className="h-8"
                  value={item.keywordsText || ''}
                  placeholder="归类关键词，逗号分隔"
                  onChange={(e) => setDraftCategories((current) => current.map((row, i) => (
                    i === index ? { ...row, keywordsText: e.target.value } : row
                  )))}
                />
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDraftCategories((current) => [...current, {
                id: `cat_${Math.random().toString(36).slice(2, 8)}`,
                label: '新分类',
                color: '#64748b',
                enabled: true,
                keywordsText: '',
              }])}
            >
              <Plus className="size-3.5" />添加分类
            </Button>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditingCategories(false)}>取消</Button>
            <Button type="button" disabled={savingCategories} onClick={saveDraftCategories}>
              {savingCategories ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
