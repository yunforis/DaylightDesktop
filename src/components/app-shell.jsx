import { WorkbenchSidebar } from '@/components/workbench-sidebar';
import React, { useMemo } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  Activity, CalendarDays, ChevronsUpDown, Globe, Inbox, Languages, LayoutDashboard, ListTodo,
  LoaderCircle, LogOut, Mail, Moon, Plus, Search, Settings2, Sparkles, Sun, SwatchBook, UserRound,
} from 'lucide-react';
import { requestStartOnboarding } from '@/components/onboarding';
import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge,
  SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger,
} from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CommandPalette } from '@/components/command-palette';
import { EmailDetailSheet } from '@/components/email-detail-sheet';
import { HotkeyHost } from '@/components/hotkey-host';
import { LittleD } from '@/components/little-d';
import { GlobalContextMenu } from '@/components/global-context-menu';
import { useTheme } from '@/components/theme-provider';
import { useWorkspace } from '@/context/workspace';
import { useAuthUser } from '@/lib/auth-session';
import { formatHotkey, readHotkeys } from '@/lib/hotkeys';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
export function AppShell() {
  const navigate = useNavigate();
  const {
    state, isSyncing, setEventModal, sync, switchMailbox, viewMode, setViewMode, isMixedView, setCommandOpen, jobs,
  } = useWorkspace();
  const { mode, toggleMode, accent, setAccent, accents, locale, setLocale, locales } = useTheme();
  const { user, logout } = useAuthUser();
  const settings = state.settings;
  const mailboxes = settings.mailboxes || [];
  const conflictCount = state.emails.filter((email) => email.conflicts?.length).length;
  const pendingTasks = state.tasks.filter((task) => task.status !== 'done').length;
  const accountLabel = user?.username || user?.email || '';
  const mailboxLabel = isMixedView
    ? (settings.viewLabel || '全部邮箱（混合）')
    : (settings.email || '未配置工作邮箱');
  const mailboxTag = isMixedView ? '混合' : (settings.tagLabel || '工作');
  const searchHotkey = formatHotkey(readHotkeys().search.key);

  const tagOptions = useMemo(() => {
    const map = new Map();
    for (const mailbox of mailboxes) {
      const label = mailbox.tagLabel || '工作';
      if (!map.has(label)) map.set(label, mailbox.tag || 'work');
    }
    return [...map.entries()].map(([label, tag]) => ({ label, tag }));
  }, [mailboxes]);

  const nav = [
    { to: '/app', label: t(locale, 'overview'), icon: LayoutDashboard, end: true, tour: 'overview' },
    { to: '/app/calendar', label: t(locale, 'calendar'), icon: CalendarDays, tour: 'calendar' },
    { to: '/app/todos', label: t(locale, 'todos'), icon: ListTodo, badge: pendingTasks || null, tour: 'todos' },
    { to: '/app/mail', label: t(locale, 'mail'), icon: Inbox, badge: conflictCount || null, tour: 'mail' },
    { to: '/app/traces', label: t(locale, 'traces'), icon: Activity, tour: 'traces' },
    { to: '/app/jobs', label: '后台任务', icon: LoaderCircle, badge: jobs.filter((job) => ['queued', 'running'].includes(job.status)).length || null },
    { to: '/app/settings', label: t(locale, 'settings'), icon: Settings2, tour: 'settings' },
    { to: '/app/account', label: '账号', icon: UserRound, tour: 'account' },
  ].filter(Boolean);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="workspace-shell flex h-svh max-h-svh w-full overflow-hidden">
        <div className="workspace-atmosphere" aria-hidden />
        <SidebarProvider defaultOpen className="h-full min-h-0 overflow-hidden">
        <Sidebar collapsible="icon" variant="inset">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" asChild>
                  <NavLink to="/app">
                    <BrandMark className="size-8 rounded-lg" />
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-semibold">{t(locale, 'appName')}</span>
                      <span className="truncate text-xs text-muted-foreground">邮件工作空间</span>
                    </div>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <div className="flex gap-2 px-2 group-data-[collapsible=icon]:hidden">
              <Button data-tour="quick-create" className="flex-1" size="sm" onClick={() => setEventModal({ event: null, date: null })}>
                <Plus className="size-4" />Quick Create
              </Button>
              <Button data-tour="sync" size="icon-sm" variant="outline" disabled={isSyncing} onClick={() => sync('qq').then((r) => {
                if (r?.needSettings) navigate(`/app/settings?tab=${r.settingsTab || 'mailbox'}`);
              })}>
                {isSyncing ? <LoaderCircle className="size-4 animate-spin" /> : <Mail className="size-4" />}
              </Button>
            </div>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Workspace</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {nav.map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton asChild tooltip={item.label}>
                        <NavLink
                          to={item.to}
                          end={item.end}
                          data-tour={item.tour}
                          className={({ isActive }) => cn(isActive && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground')}
                        >
                          <item.icon />
                          <span>{item.label}</span>
                        </NavLink>
                      </SidebarMenuButton>
                      {item.badge ? <SidebarMenuBadge>{item.badge}</SidebarMenuBadge> : null}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          <WorkbenchSidebar />
            </SidebarContent>

          <SidebarFooter className="mt-auto">
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
                      <BrandMark className="aspect-square size-8 rounded-lg" />
                      <div className="grid flex-1 text-left text-sm leading-tight">
                        <span className="truncate font-medium">{accountLabel || '未登录账号'}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {mailboxTag} · {mailboxLabel}
                        </span>
                      </div>
                      <ChevronsUpDown className="ml-auto size-4 opacity-60" />
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start" className="w-72">
                    <DropdownMenuLabel>切换邮箱视图</DropdownMenuLabel>
                    <DropdownMenuItem
                      onClick={() => setViewMode('all')}
                      className={cn(viewMode === 'all' && 'bg-muted')}
                    >
                      全部邮箱（混合）
                    </DropdownMenuItem>
                    {tagOptions.map((item) => (
                      <DropdownMenuItem
                        key={item.label}
                        onClick={() => setViewMode(`tag:${item.tag}`)}
                        className={cn(viewMode === `tag:${item.tag}` && 'bg-muted')}
                      >
                        {item.label}（同类混合）
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>单个邮箱</DropdownMenuLabel>
                    {mailboxes.map((mailbox) => (
                      <DropdownMenuItem
                        key={mailbox.id}
                        disabled={isSyncing}
                        onClick={() => switchMailbox(mailbox.id)}
                        className={cn(!isMixedView && mailbox.id === settings.activeMailboxId && 'bg-muted')}
                      >
                        [{mailbox.tagLabel || '工作'}] {mailbox.email || mailbox.id}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => requestStartOnboarding()}>
                      <Sparkles className="size-4" />
                      新手指引
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => navigate('/app/account')}>账号信息</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => navigate('/app/settings')}>管理邮箱标签与设置</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => { logout(); navigate('/'); }}>
                  <LogOut />
                  <span>退出 / 回首页</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>

        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur-md">
            <SidebarTrigger className="-ml-1" />
            <div className="mx-auto hidden w-full max-w-lg md:block">
              <button
                type="button"
                data-tour="command"
                onClick={() => setCommandOpen(true)}
                className="flex h-9 w-full items-center gap-2 rounded-md border bg-background px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                <Search className="size-3.5 shrink-0" />
                <span className="truncate">搜索日程、待办、发票、邮件，或执行操作…</span>
                <kbd className="ml-auto hidden shrink-0 rounded border bg-muted px-1.5 text-[10px] lg:inline">{searchHotkey}</kbd>
              </button>
            </div>
            <div className="ml-auto flex min-w-0 items-center gap-1">
              <Button size="icon" variant="ghost" className="md:hidden" onClick={() => setCommandOpen(true)} title="搜索">
                <Search className="size-4" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" className="hidden sm:inline-flex" title={t(locale, 'theme')}>
                    <SwatchBook className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>{t(locale, 'theme')}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={accent} onValueChange={setAccent}>
                    {accents.map((item) => (
                      <DropdownMenuRadioItem key={item.id} value={item.id}>{item.label}</DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button size="icon" variant="ghost" onClick={toggleMode} title={mode === 'dark' ? t(locale, 'light') : t(locale, 'dark')}>
                {mode === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" className="hidden sm:inline-flex" title={t(locale, 'language')}>
                    <Languages className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel className="flex items-center gap-2">
                    <Globe className="size-3.5" />{t(locale, 'language')}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioGroup value={locale} onValueChange={setLocale}>
                    {locales.map((item) => (
                      <DropdownMenuRadioItem key={item.id} value={item.id}>{item.label}</DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button data-tour="sync" size="sm" variant="outline" disabled={isSyncing || isMixedView} onClick={() => sync('qq').then((r) => {
                if (r?.needSettings) navigate(`/app/settings?tab=${r.settingsTab || 'mailbox'}`);
              })}>
                {isSyncing ? <LoaderCircle className="size-4 animate-spin" /> : <Mail className="size-4 sm:hidden" />}
                <span className="hidden sm:inline">{t(locale, 'sync')}</span>
              </Button>
              <Button data-tour="quick-create" size="sm" onClick={() => setEventModal({ event: null, date: null })}>
                <Plus className="size-4" /><span className="hidden sm:inline">{t(locale, 'addEvent')}</span>
              </Button>
            </div>
          </header>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto p-4 md:p-6">
            <Outlet />
          </div>
        </SidebarInset>
        <EmailDetailSheet />
        <CommandPalette />
        <HotkeyHost />
        <GlobalContextMenu />
        <LittleD />
      </SidebarProvider>
      </div>
    </TooltipProvider>
  );
}
