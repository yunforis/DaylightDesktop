import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LoaderCircle, Mail, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useWorkspace } from '@/context/workspace';

const STORAGE_KEY = 'daylight.onboarding.v2';
const LEGACY_KEY = 'daylight.onboarding.v1';
const PENDING_KEY = 'daylight.pending-onboarding';

/** 具体用法向导：先配置 → 同步 → 查看结果 → 各模块怎么用 */
const TOUR_STEPS = [
  {
    id: 'settings',
    selector: '[data-tour="settings"]',
    path: '/app/settings',
    title: '第一步：配好邮箱与模型',
    text: '在设置里填写 QQ / 其他邮箱地址、IMAP 授权码，以及 OpenAI 兼容的模型接口与 API Key。保存后顶栏「同步」才可用。云存储与系统发信由管理员在 /admin 维护。',
    tips: ['授权码不是登录密码', '模型需支持 JSON Object 输出', '可给邮箱打「工作 / 个人」标签'],
  },
  {
    id: 'sync',
    selector: '[data-tour="sync"]',
    path: '/app',
    title: '第二步：同步最近邮件',
    text: '点顶栏「同步」拉取最近 N 封邮件。模型会识别新邀请、取消与改期，写入日历与待办；已成功处理过的邮件 ID 不会重复提取。',
    tips: ['也可 ⌘J / 配置的快捷键打开命令面板同步', '演示数据可先导入示例，不连真实邮箱'],
  },
  {
    id: 'overview',
    selector: '[data-tour="overview-stats"]',
    path: '/app',
    title: '总览：一眼看到今天',
    text: '总览汇总今日安排、待办、冲突与已处理邮件。有冲突时点进「邮件」处理；也可从这里导入演示数据体验完整流程。',
    tips: ['数字卡片可点击跳转', '首次建议先跑一遍「导入示例邮件」'],
  },
  {
    id: 'calendar',
    selector: '[data-tour="calendar"]',
    path: '/app/calendar',
    title: '日历：查看与新建安排',
    text: '用日 / 周 / 月视图浏览日程。月视图里悬停日期格出现 ➕，只点 ➕ 新建（不会误触整格）。取消的日程会保留并标为已取消；改期会关联新旧事件。',
    tips: ['侧栏可筛选工作 / 生活分类', '点日程可打开详情与关联邮件'],
  },
  {
    id: 'mail',
    selector: '[data-tour="mail"]',
    path: '/app/mail',
    title: '邮件：读原文与处理结果',
    text: '按会议 / 任务 / 通知 / 求职等分类筛选。打开一封邮件可看完整元数据、模型摘要与冲突提示；需要时采纳草稿并经当前邮箱 SMTP 真实回信。',
    tips: ['冲突数量会显示在侧栏角标', '求职简历不会创建普通日程'],
  },
  {
    id: 'todos',
    selector: '[data-tour="todos"]',
    path: '/app/todos',
    title: '待办：跟进邮件里的行动项',
    text: '邮件提取出的待办会出现在这里。勾选完成、右键快捷操作，或跳回来源邮件核对上下文。',
    tips: ['待办与当前邮箱视图隔离', '混合邮箱视图可看全部'],
  },
  {
    id: 'recruitment',
    selector: '[data-tour="recruitment"]',
    path: '/app/recruitment',
    title: '智能招聘：简历与邀约',
    text: '求职类邮件会走 PDF/OCR 入库。左侧人才池筛选，右侧用自然语言对话（如「上海、硕士、有实习」）；生成面试邀约后先审核，再 SMTP 发送，可选飞书建会。',
    tips: ['打开候选人可看多版简历与原 PDF', '示例导入不会发真实邮件'],
  },
  {
    id: 'traces',
    selector: '[data-tour="traces"]',
    path: '/app/traces',
    title: '执行日志：回放证据链',
    text: '每次同步与模型调用都会留下 trace。出了问题可在这里看决策、用量与失败原因，区分真实同步与示例导入。',
    tips: ['可按真实 / 示例筛选', '便于核对「为什么进了日历」'],
  },
  {
    id: 'assistant',
    selector: '[data-tour="little-d"]',
    path: '/app',
    title: '小 D 与全局搜索',
    text: '右下角「小 D」可用自然语言查改当前邮箱的日程 / 待办 / 邮件（需已配模型）。顶栏搜索或快捷键打开命令面板，快速跳转与执行同步等操作。',
    tips: ['支持语音输入（浏览器权限）', '设置里可改搜索快捷键'],
  },
];

function readProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const old = JSON.parse(legacy);
      // 旧版已完成则视为完成，避免老用户刷新再弹
      if (old.tourDone && old.syncPromptDone) {
        const migrated = { syncPromptDone: true, tourDone: true, tourActive: false, tourStep: 0 };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    }
  } catch { /* ignore */ }
  return {};
}

function writeProgress(patch) {
  const next = { ...readProgress(), ...patch };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

function clearPendingFlag() {
  try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
}

function hasPendingFlag() {
  try { return localStorage.getItem(PENDING_KEY) === '1'; } catch { return false; }
}

function resolveInitialPhase(progress) {
  if (progress.tourDone && progress.syncPromptDone) return 'idle';
  if (progress.tourActive && !progress.tourDone) return 'boot'; // 等 state 再恢复 tour，避免闪对话框
  return 'boot';
}

export function OnboardingHost() {
  const navigate = useNavigate();
  const { state, sync, isSyncing } = useWorkspace();
  const initialProgress = useRef(readProgress()).current;
  const [phase, setPhase] = useState(() => resolveInitialPhase(initialProgress));
  const [stepIndex, setStepIndex] = useState(() => Number(initialProgress.tourStep || 0) || 0);
  const [spotlight, setSpotlight] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const bootedRef = useRef(false);

  const mailboxEmail = state?.settings?.email
    || state?.settings?.mailboxes?.find((m) => m.id === state.settings.activeMailboxId)?.email;
  const mailboxReady = Boolean(state?.settings?.mailboxReady);

  useEffect(() => {
    if (!state || bootedRef.current) return;
    bootedRef.current = true;
    const pending = hasPendingFlag();
    const current = readProgress();

    if (current.tourDone && current.syncPromptDone && !pending) {
      setPhase('idle');
      return;
    }
    if (current.tourActive && !current.tourDone) {
      setStepIndex(Number(current.tourStep || 0) || 0);
      setPhase('tour');
      return;
    }
    if (!current.syncPromptDone || pending) {
      setPhase('sync');
      return;
    }
    if (!current.tourDone) {
      setPhase('tour-ask');
      return;
    }
    setPhase('idle');
  }, [state]);

  const step = TOUR_STEPS[stepIndex];

  useEffect(() => {
    if (phase !== 'tour' || !step) return undefined;
    writeProgress({
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
        if (tries < 12) {
          window.setTimeout(locate, 80);
          return;
        }
        setSpotlight(null);
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
    const timer = window.setTimeout(locate, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [phase, step, stepIndex, navigate]);

  useEffect(() => {
    if (phase !== 'tour') return undefined;
    function onResize() {
      const el = document.querySelector(TOUR_STEPS[stepIndex]?.selector);
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
  }, [phase, stepIndex]);

  const progressLabel = useMemo(
    () => (phase === 'tour' ? `${stepIndex + 1} / ${TOUR_STEPS.length}` : ''),
    [phase, stepIndex],
  );

  async function onSyncNow() {
    setSyncing(true);
    try {
      if (!mailboxReady) {
        writeProgress({ syncPromptDone: true, tourActive: false });
        clearPendingFlag();
        toast.message('邮箱尚未配置完成，请先到设置填写授权码');
        setPhase('tour-ask');
        navigate('/app/settings');
        return;
      }
      const result = await sync('qq');
      if (result?.needSettings) {
        toast.message('请先完善邮箱或模型配置');
        navigate('/app/settings');
      } else {
        toast.success('已开始拉取邮件');
      }
      writeProgress({ syncPromptDone: true, tourActive: false });
      clearPendingFlag();
      setPhase('tour-ask');
    } catch (error) {
      toast.error(error.message || '同步失败');
      writeProgress({ syncPromptDone: true, tourActive: false });
      clearPendingFlag();
      setPhase('tour-ask');
    } finally {
      setSyncing(false);
    }
  }

  function onSyncLater() {
    writeProgress({ syncPromptDone: true, tourActive: false });
    clearPendingFlag();
    setPhase('tour-ask');
  }

  function startTour() {
    setStepIndex(0);
    writeProgress({ syncPromptDone: true, tourActive: true, tourDone: false, tourStep: 0 });
    setPhase('tour');
  }

  function skipTour() {
    writeProgress({ syncPromptDone: true, tourDone: true, tourActive: false, tourStep: 0 });
    clearPendingFlag();
    setPhase('idle');
    setSpotlight(null);
  }

  function nextStep() {
    if (stepIndex >= TOUR_STEPS.length - 1) {
      skipTour();
      toast.success('指引完成。从设置配邮箱，再同步，就能开始用了。');
      return;
    }
    const next = stepIndex + 1;
    setStepIndex(next);
    writeProgress({ tourActive: true, tourDone: false, tourStep: next });
  }

  function prevStep() {
    const next = Math.max(0, stepIndex - 1);
    setStepIndex(next);
    writeProgress({ tourActive: true, tourDone: false, tourStep: next });
  }

  // boot：工作区尚未就绪或尚未判定阶段 — 不渲染任何弹层，避免刷新闪一下
  if (!state || phase === 'boot' || phase === 'idle') return null;

  return (
    <>
      {phase === 'sync' ? (
        <Dialog open onOpenChange={(open) => { if (!open) onSyncLater(); }}>
          <DialogContent className="sm:max-w-md animate-in fade-in zoom-in-95 duration-300" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Mail className="size-5" />
                是否立即拉取邮件？
              </DialogTitle>
              <DialogDescription className="text-left leading-relaxed break-keep text-pretty">
                {mailboxEmail
                  ? <>检测到当前工作邮箱 <span className="font-medium text-foreground">{mailboxEmail}</span>。首次进入时可同步最近邮件，由模型提取日程与待办。</>
                  : '建议先完成邮箱与模型配置，再同步最近邮件。也可以稍后再说，随时在顶栏点「同步」。'}
                {!mailboxReady && (
                  <span className="mt-2 block text-amber-700 dark:text-amber-300">
                    当前邮箱尚未配置完整（授权码等），选择「立即拉取」将引导你去设置页。
                  </span>
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:justify-between">
              <Button variant="ghost" onClick={onSyncLater} disabled={syncing || isSyncing}>稍后再说</Button>
              <Button onClick={onSyncNow} disabled={syncing || isSyncing}>
                {(syncing || isSyncing) ? <LoaderCircle className="size-4 animate-spin" /> : null}
                立即拉取
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {phase === 'tour-ask' ? (
        <Dialog open onOpenChange={(open) => { if (!open) skipTour(); }}>
          <DialogContent className="sm:max-w-md animate-in fade-in zoom-in-95 duration-300" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Sparkles className="size-5" />
                开始使用指引？
              </DialogTitle>
              <DialogDescription className="text-left leading-relaxed break-keep text-pretty">
                约 2 分钟：从配置邮箱、同步邮件，到日历、招聘与小 D 的具体操作。可随时跳过，进度会记住，刷新不会反复弹出。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:justify-between">
              <Button variant="ghost" onClick={skipTour}>跳过</Button>
              <Button onClick={startTour}>开始指引</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {phase === 'tour' && (
        <div className="fixed inset-0 z-[80] animate-in fade-in duration-200">
          <div className="absolute inset-0 bg-black/55" />
          {spotlight && (
            <div
              className="pointer-events-none absolute rounded-xl ring-2 ring-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] transition-all duration-300 ease-out"
              style={{
                top: spotlight.top,
                left: spotlight.left,
                width: spotlight.width,
                height: spotlight.height,
              }}
            />
          )}
          <div className="absolute bottom-8 left-1/2 z-[81] w-[min(92vw,440px)] -translate-x-1/2 rounded-2xl border bg-background/95 p-5 shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                使用指引 · {progressLabel}
              </div>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={skipTour}>跳过</Button>
            </div>
            <h3 className="mt-2 text-lg font-semibold">{step?.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground break-keep text-pretty">{step?.text}</p>
            {step?.tips?.length ? (
              <ul className="mt-3 space-y-1.5 border-t pt-3">
                {step.tips.map((tip) => (
                  <li key={tip} className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary" />
                    <span className="text-pretty">{tip}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-5 flex items-center justify-between gap-2">
              <Button variant="outline" size="sm" disabled={stepIndex === 0} onClick={prevStep}>上一步</Button>
              <div className="flex max-w-[40%] flex-wrap justify-center gap-1">
                {TOUR_STEPS.map((item, index) => (
                  <span
                    key={item.id}
                    className={`size-1.5 rounded-full ${index === stepIndex ? 'bg-foreground' : 'bg-muted-foreground/30'}`}
                  />
                ))}
              </div>
              <Button size="sm" onClick={nextStep}>
                {stepIndex >= TOUR_STEPS.length - 1 ? '完成' : '下一步'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
