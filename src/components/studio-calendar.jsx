import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import { useCalendarController } from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/react/daygrid';
import timeGridPlugin from '@fullcalendar/react/timegrid';
import interactionPlugin from '@fullcalendar/react/interaction';
import classicThemePlugin from '@fullcalendar/react/themes/classic';
import zhCnLocale from '@fullcalendar/react/locales/zh-cn';
import { differenceInCalendarDays } from 'date-fns';
import {
  Calendar as CalendarIcon, ChevronLeft, ChevronRight, Download, LoaderCircle, Pencil, Plus, Share2,
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
import { isCancelled } from '@/lib/domain';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const VIEW_KEYS = [
  { key: 'dayGridMonth', labelKey: 'month' },
  { key: 'timeGridWeek', labelKey: 'week' },
  { key: 'timeGridDay', labelKey: 'day' },
];

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
  const h = date.getHours();
  const m = date.getMinutes();
  const suffix = h >= 12 ? 'p' : 'a';
  const hour12 = h % 12 || 12;
  return m ? `${hour12}:${String(m).padStart(2, '0')}${suffix}` : `${hour12}${suffix}`;
}

function sameDateInfo(a, b) {
  return a.title === b.title && a.days === b.days && a.eventCount === b.eventCount;
}

function formatRangeLabel(start, end) {
  if (!start || !end) return '';
  const fmt = (date) => {
    const h = date.getHours();
    const m = date.getMinutes();
    return `${h}:${String(m).padStart(2, '0')}`;
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

export function StudioCalendar({ events, onEvent, onNew, categories, onCategoriesChange }) {
  const { locale } = useTheme();
  const controller = useCalendarController();
  const [view, setView] = useState('timeGridWeek');
  const [exporting, setExporting] = useState(false);
  const categoryList = useMemo(() => {
    const list = (categories || []).filter((item) => item && item.enabled !== false);
    return list.length ? list : FALLBACK_CATEGORIES;
  }, [categories]);
  const categoryMap = useMemo(() => Object.fromEntries(categoryList.map((item) => [item.id, item])), [categoryList]);
  const [visible, setVisible] = useState({});
  const [editingCategories, setEditingCategories] = useState(false);
  const [draftCategories, setDraftCategories] = useState([]);
  const [savingCategories, setSavingCategories] = useState(false);
  const [dateInfo, setDateInfo] = useState(() => ({
    title: new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' }),
    days: 31,
    eventCount: 0,
  }));

  const dateInfoRef = useRef(dateInfo);
  const viewRef = useRef(view);
  const rangeRef = useRef({ start: null, end: null });
  const onEventRef = useRef(onEvent);
  const onNewRef = useRef(onNew);
  dateInfoRef.current = dateInfo;
  viewRef.current = view;
  onEventRef.current = onEvent;
  onNewRef.current = onNew;

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

  const fcEvents = useMemo(() => activeEvents
    .filter((event) => {
      const id = categoryMap[event.category] ? event.category : defaultCategoryId;
      return visible[id] !== false;
    })
    .map((event) => {
      const category = categoryMap[event.category] ? event.category : defaultCategoryId;
      const meta = categoryMap[category] || { color: 'var(--cal-work)' };
      return {
        id: event.id,
        title: event.title,
        start: event.start,
        end: event.end,
        allDay: Boolean(event.allDay),
        extendedProps: { event, category, color: meta.color },
        classNames: [
          event.allDay ? 'fc-daylight-allday' : 'fc-daylight-timed',
          `fc-daylight-${category}`,
        ],
        backgroundColor: event.allDay ? meta.color : 'transparent',
        borderColor: meta.color,
        textColor: event.allDay ? '#fff' : 'var(--foreground)',
      };
    }), [activeEvents, visible, categoryMap, defaultCategoryId]);
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
      return (
        <div className="fc-daylight-row flex w-full items-center gap-1 truncate px-1 text-[11px]" style={{ color }}>
          <span className="fc-daylight-dot size-1.5 shrink-0 rounded-full" style={{ background: color }} />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{arg.event.title}</span>
          <span className="shrink-0 text-muted-foreground">{timeText}</span>
        </div>
      );
    }
    // 周/日：对齐 studio-admin 的实心色块，时间在上、标题在下
    return (
      <div
        className="fc-daylight-block fc-daylight-solid h-full overflow-hidden rounded-md px-1.5 py-1 text-[11px] text-white"
        style={{ background: color }}
      >
        <div className="text-[10px] font-medium leading-tight opacity-90">{rangeText || timeText}</div>
        <div className="font-semibold leading-tight">{arg.event.title}</div>
      </div>
    );
  }, []);

  const renderDayCellTop = useCallback((arg) => {
    const date = arg.date instanceof Date ? arg.date : new Date(arg.date);
    const dateKey = date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const dayNum = Number.isNaN(date.getDate()) ? arg.text : date.getDate();
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

        <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border bg-background">
          <FullCalendar
            controller={controller}
            plugins={PLUGINS}
            locales={LOCALES}
            locale={zh ? 'zh-cn' : 'en'}
            initialView="timeGridWeek"
            headerToolbar={false}
            height="100%"
            nowIndicator
            editable={false}
            selectable={false}
            dayMaxEvents={3}
            events={fcEvents}
            eventDisplay="block"
            displayEventTime
            eventTimeFormat={EVENT_TIME_FORMAT}
            views={VIEWS}
            eventContent={renderEventContent}
            dayCellTopContent={renderDayCellTop}
            eventClick={onEventClick}
            datesSet={onDatesSet}
          />
        </div>
      </div>

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
