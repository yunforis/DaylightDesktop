import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LoaderCircle, Mail, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useWorkspace } from '@/context/workspace';
import { request } from '@/lib/api';
import { useAuthUser } from '@/lib/auth-session';

const STORAGE_PREFIX = 'daylight.onboarding.v3';
const LEGACY_KEYS = ['daylight.onboarding.v2', 'daylight.onboarding.v1'];
const PENDING_KEY = 'daylight.pending-onboarding';
export const START_ONBOARDING_EVENT = 'daylight:start-onboarding';

/** 离线/接口失败时的兜底步骤（与 server/onboarding-guide.js 默认一致） */
const FALLBACK_STEPS = [
  {
    id: 'settings', audience: 'all', selector: '[data-tour="settings"]', path: '/app/settings',
    title: '第一步：配好邮箱与模型',
    text: '注册成功后会用你的注册邮箱预填收信地址。请到邮箱后台生成 IMAP 授权码并保存，再配置模型 API Key。保存后顶栏「同步」才可用。',
    tips: ['授权码不是网页登录密码', '模型需支持 JSON Object 输出', '可给邮箱打「工作 / 个人」标签'],
  },
  {
    id: 'sync', audience: 'all', selector: '[data-tour="sync"]', path: '/app',
    title: '第二步：同步最近邮件',
    text: '点顶栏「同步」拉取最近 N 封邮件。模型会识别新邀请、取消与改期，写入日历与待办；已成功处理过的邮件 ID 不会重复提取。',
    tips: ['也可 ⌘J / 配置的快捷键打开命令面板同步', '演示数据可先导入示例，不连真实邮箱'],
  },
  {
    id: 'overview', audience: 'all', selector: '[data-tour="overview-stats"]', path: '/app',
    title: '总览：一眼看到今天',
    text: '总览汇总今日安排、待办、冲突与已处理邮件。有冲突时点进「邮件」处理；也可从这里导入演示数据体验完整流程。',
    tips: ['数字卡片可点击跳转', '首次建议先跑一遍「导入示例邮件」'],
  },
  {
    id: 'calendar', audience: 'all', selector: '[data-tour="calendar"]', path: '/app/calendar',
    title: '日历：查看与新建安排',
    text: '用日 / 周 / 月视图浏览日程。月视图里悬停日期格出现 ➕，只点 ➕ 新建（不会误触整格）。取消的日程会保留并标为已取消；改期会关联新旧事件。',
    tips: ['侧栏可筛选工作 / 生活分类', '点日程可打开详情与关联邮件'],
  },
  {
    id: 'mail', audience: 'all', selector: '[data-tour="mail"]', path: '/app/mail',
    title: '邮件：读原文与处理结果',
    text: '按会议 / 任务 / 通知 / 求职等分类筛选。打开一封邮件可看完整元数据、模型摘要与冲突提示；需要时采纳草稿并经当前邮箱 SMTP 真实回信。',
    tips: ['冲突数量会显示在侧栏角标', '求职简历不会创建普通日程'],
  },
  {
    id: 'todos', audience: 'all', selector: '[data-tour="todos"]', path: '/app/todos',
    title: '待办：跟进邮件里的行动项',
    text: '邮件提取出的待办会出现在这里。勾选完成、右键快捷操作，或跳回来源邮件核对上下文。',
    tips: ['待办与当前邮箱视图隔离', '混合邮箱视图可看全部'],
  },
  {
    id: 'workbenches', audience: 'all', selector: '[data-tour="workbenches"]', path: '/app/workbenches',
    title: '工作台：按场景处理邮件',
    text: '在「我的工作台」使用发票助手、智能招聘和场景工作台。点击侧栏「管理工作台」可以移除已添加入口，或从官方与社区模板继续添加。',
    tips: ['隐藏入口会保留已有数据', '同一模板可以建多个工作台', '确认关联邮件不会自动发信'],
  },
  {
    id: 'traces', audience: 'all', selector: '[data-tour="traces"]', path: '/app/traces',
    title: '执行日志：回放证据链',
    text: '每次同步与模型调用都会留下 trace。出了问题可在这里看决策、用量与失败原因，区分真实同步与示例导入。',
    tips: ['可按真实 / 示例筛选', '便于核对「为什么进了日历」'],
  },
  {
    id: 'assistant', audience: 'all', selector: '[data-tour="little-d"]', path: '/app',
    title: '小 D 与全局搜索',
    text: '右下角「小 D」可以起草邮件并在你审核后真实发送、安排飞书会议和日程、整理过去几天已保存邮件的简报，也能管理日程待办与检索简历。打开「能做什么」体验预设提示，写入类提示会先放进输入框供你核对。',
    tips: ['模型需支持工具调用；发信需当前邮箱 SMTP，建会需飞书配置', '邮件在审核卡点击确认后才发出', '支持语音转文字；可在设置里改搜索快捷键'],
  },
];

export function requestStartOnboarding() {
  window.dispatchEvent(new CustomEvent(START_ONBOARDING_EVENT));
}

function storageKey(userId) {
  return userId ? `${STORAGE_PREFIX}.${userId}` : STORAGE_PREFIX;
}

function readProgress(userId) {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

function writeProgress(userId, patch) {
  const next = { ...readProgress(userId), ...patch, version: 3 };
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(next));
  } catch { /* ignore */ }
  return next;
}

function clearPendingFlag() {
  try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
}

function hasPendingFlag() {
  try { return localStorage.getItem(PENDING_KEY) === '1'; } catch { return false; }
}

function clearLegacyProgress() {
  for (const key of LEGACY_KEYS) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
}

function filterSteps(steps) {
  return steps || [];
}

export function OnboardingHost() {
  const navigate = useNavigate();
  const { state, sync, isSyncing } = useWorkspace();
  const { user } = useAuthUser();
  const userId = user?.id || '';
  const [remoteSteps, setRemoteSteps] = useState(null);
  const tourSteps = useMemo(
    () => filterSteps(remoteSteps?.length ? remoteSteps : FALLBACK_STEPS, user),
    [user, remoteSteps],
  );
  const [phase, setPhase] = useState('boot');
  const [stepIndex, setStepIndex] = useState(0);
  const [spotlight, setSpotlight] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const bootedForUserRef = useRef('');

  const mailboxEmail = state?.settings?.email
    || state?.settings?.mailboxes?.find((m) => m.id === state.settings.activeMailboxId)?.email
    || user?.email
    || state?.settings?.accountEmail
    || '';
  const mailboxReady = Boolean(state?.settings?.mailboxReady);
  const needsMailboxSetup = Boolean(state?.settings?.needsMailboxSetup) || !mailboxReady;

  useEffect(() => {
    let cancelled = false;
    request('/onboarding/guide')
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data?.steps) && data.steps.length) setRemoteSteps(data.steps);
      })
      .catch(() => { /* 用本地兜底 */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!state || !userId) return;
    if (bootedForUserRef.current === userId) return;
    bootedForUserRef.current = userId;

    const pending = hasPendingFlag();
    if (pending) clearLegacyProgress();

    const current = readProgress(userId);
    if (pending) {
      writeProgress(userId, {
        syncPromptDone: false, tourDone: false, tourActive: false, tourStep: 0,
      });
      setStepIndex(0);
      setPhase(needsMailboxSetup ? 'mailbox-setup' : 'sync');
      return;
    }
    if (current.tourDone && current.syncPromptDone) {
      setPhase('idle');
      return;
    }
    if (current.tourActive && !current.tourDone) {
      const idx = Math.min(Number(current.tourStep || 0) || 0, Math.max(0, tourSteps.length - 1));
      setStepIndex(idx);
      setPhase('tour');
      return;
    }
    if (needsMailboxSetup && !current.mailboxSetupDone) {
      setPhase('mailbox-setup');
      return;
    }
    if (!current.syncPromptDone) {
      setPhase('sync');
      return;
    }
    if (!current.tourDone) {
      setPhase('tour-ask');
      return;
    }
    setPhase('idle');
  }, [state, userId, tourSteps.length, needsMailboxSetup]);

  useEffect(() => {
    if (stepIndex >= tourSteps.length) setStepIndex(Math.max(0, tourSteps.length - 1));
  }, [tourSteps.length, stepIndex]);

  const step = tourSteps[stepIndex];

  const startTour = useCallback(() => {
    if (!userId) {
      toast.error('请先登录');
      return;
    }
    setStepIndex(0);
    writeProgress(userId, { syncPromptDone: true, tourActive: true, tourDone: false, tourStep: 0 });
    setPhase('tour');
    toast.message('已开始新手指引，可随时跳过');
  }, [userId]);

  useEffect(() => {
    function onStart() { startTour(); }
    window.addEventListener(START_ONBOARDING_EVENT, onStart);
    return () => window.removeEventListener(START_ONBOARDING_EVENT, onStart);
  }, [startTour]);

  useEffect(() => {
    if (phase !== 'tour' || !step || !userId) return undefined;
    writeProgress(userId, {
      syncPromptDone: true,
      tourActive: true,
      tourDone: false,
      tourStep: stepIndex,
    });
    navigate(step.path, { replace: true });

    let cancelled = false;
    let tries = 0;
    const locate = () => {
      if (cancelled) return;
      const el = document.querySelector(step.selector);
      if (!el) {
        tries += 1;
        if (tries < 25) {
          window.setTimeout(locate, 120);
          return;
        }
        if (stepIndex < tourSteps.length - 1) {
          setStepIndex((value) => value + 1);
        } else {
          setSpotlight(null);
        }
        return;
      }
      const rect = el.getBoundingClientRect();
      setSpotlight({
        top: Math.max(8, rect.top - 8),
        left: Math.max(8, rect.left - 8),
        width: Math.min(rect.width + 16, window.innerWidth - 16),
        height: Math.min(rect.height + 16, window.innerHeight - 16),
      });
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    const timer = window.setTimeout(locate, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [phase, step, stepIndex, navigate, userId, tourSteps.length]);

  useEffect(() => {
    if (phase !== 'tour') return undefined;
    function onResize() {
      const el = document.querySelector(tourSteps[stepIndex]?.selector);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setSpotlight({
        top: Math.max(8, rect.top - 8),
        left: Math.max(8, rect.left - 8),
        width: Math.min(rect.width + 16, window.innerWidth - 16),
        height: Math.min(rect.height + 16, window.innerHeight - 16),
      });
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [phase, stepIndex, tourSteps]);

  const progressLabel = useMemo(
    () => (phase === 'tour' ? `${stepIndex + 1} / ${tourSteps.length}` : ''),
    [phase, stepIndex, tourSteps.length],
  );

  function goFillAuthCode() {
    writeProgress(userId, { mailboxSetupDone: true, syncPromptDone: false, tourActive: false });
    try { localStorage.removeItem('daylight.pending-mailbox-setup'); } catch { /* ignore */ }
    clearPendingFlag();
    navigate('/app/settings?tab=mailbox&focus=auth');
    toast.message(`已用注册邮箱预填 ${mailboxEmail || user?.email || ''}，请填写授权码后保存`);
    setPhase('idle');
  }

  function skipMailboxSetup() {
    writeProgress(userId, { mailboxSetupDone: true });
    try { localStorage.removeItem('daylight.pending-mailbox-setup'); } catch { /* ignore */ }
    setPhase('sync');
  }

  async function onSyncNow() {
    setSyncing(true);
    try {
      if (!mailboxReady) {
        writeProgress(userId, { syncPromptDone: true, tourActive: false, mailboxSetupDone: true });
        clearPendingFlag();
        toast.message('请先填写邮箱授权码并保存，再同步邮件');
        setPhase('idle');
        navigate('/app/settings?tab=mailbox&focus=auth');
        return;
      }
      const result = await sync('qq');
      if (result?.needSettings) {
        navigate(`/app/settings?tab=${result.settingsTab || 'mailbox'}`);
      } else {
        toast.success('已开始拉取邮件');
      }
      writeProgress(userId, { syncPromptDone: true, tourActive: false });
      clearPendingFlag();
      setPhase('tour-ask');
    } catch (error) {
      toast.error(error.message || '同步失败');
      writeProgress(userId, { syncPromptDone: true, tourActive: false });
      clearPendingFlag();
      setPhase('tour-ask');
    } finally {
      setSyncing(false);
    }
  }

  function onSyncLater() {
    writeProgress(userId, { syncPromptDone: true, tourActive: false });
    clearPendingFlag();
    setPhase('tour-ask');
  }

  function skipTour() {
    writeProgress(userId, { syncPromptDone: true, tourDone: true, tourActive: false, tourStep: 0 });
    clearPendingFlag();
    setPhase('idle');
    setSpotlight(null);
  }

  function nextStep() {
    if (stepIndex >= tourSteps.length - 1) {
      skipTour();
      toast.success('指引完成。可随时在账号页或侧栏再次打开。');
      return;
    }
    const next = stepIndex + 1;
    setStepIndex(next);
    writeProgress(userId, { tourActive: true, tourDone: false, tourStep: next });
  }

  function prevStep() {
    const next = Math.max(0, stepIndex - 1);
    setStepIndex(next);
    writeProgress(userId, { tourActive: true, tourDone: false, tourStep: next });
  }

  if (!state || !userId || phase === 'boot' || phase === 'idle') return null;

  return (
    <>
      {phase === 'mailbox-setup' ? (
        <Dialog open onOpenChange={(open) => { if (!open) skipMailboxSetup(); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Mail className="size-5" />
                填写邮箱授权码
              </DialogTitle>
              <DialogDescription className="text-pretty">
                已用你的注册邮箱 <span className="font-medium text-foreground">{mailboxEmail || user?.email || ''}</span> 预填收信地址，并选好常见服务商预设。
                请到邮箱后台开启 IMAP，生成<strong>授权码</strong>（不是网页登录密码），填入设置后保存，才能同步邮件。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={skipMailboxSetup}>稍后再说</Button>
              <Button onClick={goFillAuthCode}>去填写授权码</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {phase === 'sync' ? (
        <Dialog open onOpenChange={(open) => { if (!open) onSyncLater(); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Mail className="size-5" />
                要先拉取邮件吗？
              </DialogTitle>
              <DialogDescription className="text-pretty">
                {mailboxReady
                  ? `当前工作邮箱 ${mailboxEmail || ''}。可以立刻同步，或稍后再说。`
                  : '尚未填写授权码，同步前请先完成邮箱配置。'}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={onSyncLater}>稍后再说</Button>
              <Button disabled={syncing || isSyncing} onClick={onSyncNow}>
                {(syncing || isSyncing) ? <LoaderCircle className="size-4 animate-spin" /> : null}
                {mailboxReady ? '同步邮件' : '去填授权码'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {phase === 'tour-ask' ? (
        <Dialog open onOpenChange={(open) => { if (!open) skipTour(); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Sparkles className="size-5" />
                要不要看一遍用法指引？
              </DialogTitle>
              <DialogDescription className="text-pretty">
                大约 2 分钟，共 {tourSteps.length} 步。随时可跳过；以后也可在「账号」或侧栏再次打开。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={skipTour}>跳过</Button>
              <Button onClick={startTour}>开始指引</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {phase === 'tour' && step ? (
        <div className="pointer-events-none fixed inset-0 z-[80]">
          <div className="absolute inset-0 bg-black/45" />
          {spotlight ? (
            <div
              className="absolute rounded-xl ring-2 ring-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] transition-all duration-200"
              style={{
                top: spotlight.top,
                left: spotlight.left,
                width: spotlight.width,
                height: spotlight.height,
              }}
            />
          ) : null}
          <div className="pointer-events-auto absolute bottom-6 left-1/2 z-[81] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border bg-background p-4 shadow-2xl">
            <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>新手指引</span>
              <span>{progressLabel}</span>
            </div>
            <h3 className="text-base font-semibold tracking-tight">{step.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground text-pretty">{step.text}</p>
            {step.tips?.length ? (
              <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                {step.tips.map((tip) => (
                  <li key={tip} className="flex gap-2">
                    <span className="text-foreground/40">·</span>
                    <span className="text-pretty">{tip}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-5 flex items-center justify-between gap-2">
              <Button variant="outline" size="sm" disabled={stepIndex === 0} onClick={prevStep}>上一步</Button>
              <div className="flex max-w-[40%] flex-wrap justify-center gap-1">
                {tourSteps.map((item, index) => (
                  <span
                    key={item.id}
                    className={`size-1.5 rounded-full ${index === stepIndex ? 'bg-foreground' : 'bg-muted-foreground/30'}`}
                  />
                ))}
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={skipTour}>跳过</Button>
                <Button size="sm" onClick={nextStep}>
                  {stepIndex >= tourSteps.length - 1 ? '完成' : '下一步'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
