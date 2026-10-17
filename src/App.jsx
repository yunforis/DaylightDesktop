import React, { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { Toaster } from '@/components/ui/sonner';
import { AppShell } from '@/components/app-shell';
import { BootScreen } from '@/components/boot-screen';
import { ErrorBoundary } from '@/components/error-boundary';
import { EventDialog } from '@/components/event-dialog';
import { OnboardingHost } from '@/components/onboarding';
import { AttachmentViewerProvider } from '@/components/attachment-viewer-context';
import { ThemeProvider } from '@/components/theme-provider';
import { WorkspaceProvider, useWorkspace } from '@/context/workspace';
import { WorkbenchesProvider } from '@/context/workbenches';
import { getAuthToken } from '@/lib/auth-api';
import { AuthProvider, useAuthUser } from '@/lib/auth-session';
import { bootstrapDesktopSession } from '@/lib/desktop';
import WorkbenchesPage from '@/pages/workbenches-page';
import OverviewPage from '@/pages/overview';
import CalendarPage from '@/pages/calendar-page';
import MailPage from '@/pages/mail-page';
import InvoicesPage from '@/pages/invoices-page';
import RecruitmentPage from '@/pages/recruitment-page';
import SettingsPage from '@/pages/settings-page';
import TracesPage from '@/pages/traces-page';
import JobsPage from '@/pages/jobs-page';
import TodosPage from '@/pages/todos-page';
import AccountPage from '@/pages/account-page';
import { AppErrorPage, NotFoundPage, ServiceUnavailablePage } from '@/pages/error-page';

function BootGate({ children }) {
  const { state, loadError, reload } = useWorkspace();
  if (loadError && !state) {
    return (
      <ServiceUnavailablePage
        detail={loadError}
        onRetry={() => reload().catch(() => {})}
      />
    );
  }
  if (!state) {
    return <BootScreen label="正在加载工作区…" />;
  }
  return (
    <div className="animate-in fade-in duration-300 fill-mode-both">
      {children}
    </div>
  );
}

/**
 * [desktop patch] 桌面端没有登录页：token 由原生壳层通过 GET /desktop/session 注入。
 *
 * 与 Web 版的关键差异：这里绝不能 Navigate 到 /login 或 /app —— 两者都会和 /app
 * 形成重定向循环（旧实现即为此缺陷）。改为在本地服务或会话不可用时渲染明确、
 * 可重试的错误页。
 */
function RequireAuth({ children }) {
  const { user, loading, refresh } = useAuthUser();
  const [connecting, setConnecting] = useState(true);
  const [failure, setFailure] = useState(null);

  const connect = useCallback(async () => {
    setConnecting(true);
    setFailure(null);
    try {
      if (!getAuthToken()) await bootstrapDesktopSession();
      if (!getAuthToken()) {
        setFailure('本地后台服务尚未就绪。请稍候重试；若持续失败，请退出并重新打开 Daylight。');
        return;
      }
      const next = await refresh();
      if (!next) {
        setFailure('本地会话校验失败，可能是后台服务刚重启。请重试；若仍失败，请退出并重新打开 Daylight。');
      }
    } finally {
      setConnecting(false);
    }
  }, [refresh]);

  useEffect(() => { connect().catch(() => {}); }, [connect]);

  if (connecting || loading) return <BootScreen label="正在连接本地服务…" />;
  if (failure) {
    return <ServiceUnavailablePage detail={failure} onRetry={() => connect().catch(() => {})} />;
  }
  if (!user) {
    return (
      <ServiceUnavailablePage
        detail="无法读取本地账号信息。"
        onRetry={() => connect().catch(() => {})}
      />
    );
  }
  return children;
}

function AppWorkspace() {
  return (
    <RequireAuth>
      <WorkspaceProvider>
        <BootGate>
          <WorkbenchesProvider>
            <Outlet />
            <EventDialog />
            <OnboardingHost />
          </WorkbenchesProvider>
        </BootGate>
      </WorkspaceProvider>
    </RequireAuth>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AttachmentViewerProvider>
          <BrowserRouter>
            <ErrorBoundary>
              <Routes>
                {/* 桌面端直达工作区，没有 Landing / 登录 / 注册 / 法律页 / 管理端。 */}
                <Route path="/" element={<Navigate to="/app" replace />} />
                <Route path="/502" element={<ServiceUnavailablePage />} />
                <Route path="/500" element={<AppErrorPage />} />

                {/* 用户工作区 */}
                <Route path="/app" element={<AppWorkspace />}>
                  <Route element={<AppShell />}>
                    <Route index element={<OverviewPage />} />
                    <Route path="workbenches" element={<WorkbenchesPage />} />
                    <Route path="workbenches/:id" element={<WorkbenchesPage />} />
                    <Route path="calendar" element={<CalendarPage />} />
                    <Route path="todos" element={<TodosPage />} />
                    <Route path="mail" element={<MailPage />} />
                    <Route path="invoices" element={<InvoicesPage />} />
                    <Route path="recruitment" element={<RecruitmentPage />} />
                    <Route path="traces" element={<TracesPage />} />
                    <Route path="jobs" element={<JobsPage />} />
                    <Route path="settings" element={<SettingsPage />} />
                    <Route path="account" element={<AccountPage />} />
                    <Route path="*" element={<NotFoundPage embedded />} />
                  </Route>
                </Route>

                <Route path="/calendar" element={<Navigate to="/app/calendar" replace />} />
                <Route path="/mail" element={<Navigate to="/app/mail" replace />} />
                <Route path="/traces" element={<Navigate to="/app/traces" replace />} />
                <Route path="/settings" element={<Navigate to="/app/settings" replace />} />
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
              <Toaster richColors position="bottom-center" />
            </ErrorBoundary>
          </BrowserRouter>
        </AttachmentViewerProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
