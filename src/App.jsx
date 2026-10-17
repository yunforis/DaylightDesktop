import React, { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from '@/components/ui/sonner';
import { AppShell } from '@/components/app-shell';
import { BootScreen } from '@/components/boot-screen';
import { ErrorBoundary } from '@/components/error-boundary';
import { EventDialog } from '@/components/event-dialog';
import { OnboardingHost } from '@/components/onboarding';
import { ThemeProvider } from '@/components/theme-provider';
import { WorkspaceProvider, useWorkspace } from '@/context/workspace';
import { getAuthToken } from '@/lib/auth-api';
import { AuthProvider, useAuthUser } from '@/lib/auth-session';
import OverviewPage from '@/pages/overview';
import CalendarPage from '@/pages/calendar-page';
import MailPage from '@/pages/mail-page';
import SettingsPage from '@/pages/settings-page';
import TracesPage from '@/pages/traces-page';
import TodosPage from '@/pages/todos-page';
import RecruitmentPage from '@/pages/recruitment-page';
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

function RequireAuth({ children }) {
  const location = useLocation();
  const { user, loading, refresh } = useAuthUser();
  const [ready, setReady] = useState(() => Boolean(user) || !getAuthToken());

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!getAuthToken()) {
        if (!cancelled) setReady(true);
        return;
      }
      if (user) {
        if (!cancelled) setReady(true);
        return;
      }
      await refresh();
      if (!cancelled) setReady(true);
    }
    run();
    return () => { cancelled = true; };
  }, [refresh, user]);

  if (loading || !ready) {
    return <BootScreen label="正在验证会话…" />;
  }
  if (!getAuthToken() || !user) {
    return <Navigate to="/app" replace state={{ from: location }} />;
  }
  return children;
}

function AppWorkspace() {
  return (
    <RequireAuth>
      <WorkspaceProvider>
        <BootGate>
          <Outlet />
          <EventDialog />
          <OnboardingHost />
        </BootGate>
      </WorkspaceProvider>
    </RequireAuth>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ErrorBoundary>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<Navigate to="/app" replace />} />
              <Route path="/502" element={<ServiceUnavailablePage />} />
              <Route path="/500" element={<AppErrorPage />} />

              {/* 工作区 */}
              <Route path="/app" element={<AppWorkspace />}>
                <Route element={<AppShell />}>
                  <Route index element={<OverviewPage />} />
                  <Route path="calendar" element={<CalendarPage />} />
                  <Route path="todos" element={<TodosPage />} />
                  <Route path="mail" element={<MailPage />} />
                  <Route path="recruitment" element={<RecruitmentPage />} />
                  <Route path="traces" element={<TracesPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="*" element={<NotFoundPage embedded />} />
                </Route>
              </Route>

              <Route path="*" element={<NotFoundPage />} />
            </Routes>
            <Toaster richColors position="bottom-center" />
          </BrowserRouter>
        </ErrorBoundary>
      </AuthProvider>
    </ThemeProvider>
  );
}
