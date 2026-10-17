import React from 'react';
import { Link, useInRouterContext, useNavigate } from 'react-router-dom';
import { ArrowLeft, Home, RefreshCw, ServerCrash, ShieldAlert, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PublicThemeControls } from '@/components/public-theme-controls';

const PRESETS = {
  404: {
    code: '404',
    title: '找不到这个页面',
    detail: '链接可能写错了，或内容已经挪走。你可以回到首页，或进入工作区继续安排。',
    icon: ShieldAlert,
  },
  502: {
    code: '502',
    title: '服务暂时不可用',
    detail: '本地服务没有正常响应。请确认已运行 npm run dev，稍后再试；若刚改过配置，重启一次服务通常就能恢复。',
    icon: ServerCrash,
  },
  500: {
    code: '500',
    title: '出了一点问题',
    detail: '页面渲染或请求过程中出错了。可以刷新重试；若反复出现，请查看终端日志。',
    icon: ServerCrash,
  },
  offline: {
    code: 'OFF',
    title: '网络已断开',
    detail: '当前无法连上 Daylight 服务。检查本机网络与服务进程后刷新页面。',
    icon: WifiOff,
  },
};

function NavLink({ to, className, children }) {
  const inRouter = useInRouterContext();
  if (inRouter) {
    return <Link to={to} className={className}>{children}</Link>;
  }
  return <a href={to} className={className}>{children}</a>;
}

function ErrorActionsPlain({ showBack, homeTo, onRetry }) {
  function goBack() {
    if (window.history.length > 1) window.history.back();
    else window.location.assign(homeTo);
  }
  return (
    <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
      {showBack && (
        <Button variant="outline" onClick={goBack}>
          <ArrowLeft className="size-4" />
          返回上页
        </Button>
      )}
      <Button variant="outline" asChild>
        <a href={homeTo}>
          <Home className="size-4" />
          回首页
        </a>
      </Button>
      <Button asChild>
        <a href="/app">进入工作区</a>
      </Button>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          <RefreshCw className="size-4" />
          重试
        </Button>
      )}
      {!onRetry && (
        <Button variant="secondary" onClick={() => window.location.reload()}>
          <RefreshCw className="size-4" />
          刷新页面
        </Button>
      )}
    </div>
  );
}

function ErrorActionsRouted({ showBack, homeTo, onRetry }) {
  const navigate = useNavigate();
  return (
    <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
      {showBack && (
        <Button variant="outline" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-4" />
          返回上页
        </Button>
      )}
      <Button variant="outline" asChild>
        <Link to={homeTo}>
          <Home className="size-4" />
          回首页
        </Link>
      </Button>
      <Button asChild>
        <Link to="/app">进入工作区</Link>
      </Button>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          <RefreshCw className="size-4" />
          重试
        </Button>
      )}
      {!onRetry && (
        <Button variant="secondary" onClick={() => window.location.reload()}>
          <RefreshCw className="size-4" />
          刷新页面
        </Button>
      )}
    </div>
  );
}

function ErrorActions(props) {
  const inRouter = useInRouterContext();
  return inRouter ? <ErrorActionsRouted {...props} /> : <ErrorActionsPlain {...props} />;
}

export function ErrorPage({
  code = '404',
  title,
  detail,
  onRetry,
  homeTo = '/',
  showBack = true,
  embedded = false,
}) {
  const preset = PRESETS[code] || PRESETS[500];
  const Icon = preset.icon;
  const heading = title || preset.title;
  const body = detail || preset.detail;
  const displayCode = PRESETS[code] ? preset.code : String(code);

  return (
    <div className={embedded
      ? 'relative flex min-h-[60vh] flex-col items-center justify-center px-6 py-16 text-center animate-in fade-in duration-300'
      : 'relative flex min-h-svh flex-col overflow-hidden bg-background text-foreground'}
    >
      {!embedded && (
        <>
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(1000px 560px at 50% -8%, var(--atmosphere-a, oklch(0.92 0.03 210 / 0.45)), transparent 56%), linear-gradient(180deg, var(--atmosphere-base, var(--background)) 0%, var(--background) 70%)',
            }}
          />
          <header className="relative z-[1] flex items-center justify-between px-5 py-4">
            <NavLink to={homeTo} className="font-[family-name:var(--font-display)] text-sm font-semibold tracking-tight">
              Daylight
            </NavLink>
            <PublicThemeControls />
          </header>
        </>
      )}
      <main className={embedded
        ? 'mx-auto w-full max-w-lg'
        : 'relative z-[1] mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center px-6 pb-16 text-center animate-in fade-in slide-in-from-bottom-2 duration-500'}
      >
        <div className="mb-5 mx-auto flex size-14 items-center justify-center rounded-2xl border bg-card shadow-sm">
          <Icon className="size-6 text-muted-foreground" />
        </div>
        <p className="font-[family-name:var(--font-display)] text-5xl font-semibold tracking-tight tabular-nums text-muted-foreground/80">
          {displayCode}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{heading}</h1>
        <p className="mt-3 text-pretty text-sm leading-relaxed text-muted-foreground">{body}</p>
        <ErrorActions showBack={showBack} homeTo={homeTo} onRetry={onRetry} />
      </main>
    </div>
  );
}

export function NotFoundPage({ embedded = false }) {
  return <ErrorPage code="404" embedded={embedded} />;
}

export function ServiceUnavailablePage({ detail, onRetry }) {
  return <ErrorPage code="502" detail={detail} onRetry={onRetry} showBack={false} />;
}

export function AppErrorPage({ detail, onRetry }) {
  return <ErrorPage code="500" detail={detail} onRetry={onRetry} />;
}
