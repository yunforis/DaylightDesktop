import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useWorkspace } from '@/context/workspace';
import { isActiveJob } from '@/hooks/use-background-jobs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const statusLabels = { queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消' };
const kindLabels = { 'mailbox.sync': '邮件同步', 'calendar.sync': '外部日历同步', 'mail-sync': '邮件同步', mail_sync: '邮件同步', 'mail.sync': '邮件同步', 'scenario-plan': '场景分析', scenario_plan: '场景分析', 'scenario.plan': '场景分析' };
const resultPath = kind => kind === 'calendar.sync' ? '/app/calendar' : ['mailbox.sync', 'mail-sync', 'mail_sync', 'mail.sync'].includes(kind) ? '/app/mail' : '/app/workbenches';
function time(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return '—';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

export default function JobsPage() {
  const { state, jobs, jobsLoading, jobsError, jobsSupported, refreshJobs, jobAction } = useWorkspace();
  const [pending, setPending] = useState('');
  async function act(job, action) {
    setPending(job.id);
    try {
      await jobAction(job.id, action);
      toast.success(action === 'retry' ? '已重新排队' : '任务已取消，已保存的结果仍保留');
    } catch {
      toast.error('操作未完成，任务状态可能已变化，请刷新后重试。');
      refreshJobs();
    } finally { setPending(''); }
  }
  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-2xl font-semibold tracking-tight">后台任务</h1><p className="mt-1 text-sm text-muted-foreground">当前邮箱：{state.settings.email || '尚未配置'}。刷新页面后自动恢复进度，时间为北京时间。</p></div>
      <Button variant="outline" onClick={refreshJobs}><RefreshCw className="size-4" />刷新状态</Button>
    </div>
    {jobsError && <Alert role="status"><AlertDescription>{jobsError}</AlertDescription></Alert>}
    <Card><CardHeader><CardTitle>最近任务</CardTitle><CardDescription>仅显示当前活动邮箱的最近 50 项任务。切换顶栏邮箱可查看对应记录。完成场景分析后，回工作台核验建议。</CardDescription></CardHeader>
      <CardContent className="space-y-4" aria-live="polite">
        {jobsLoading && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取任务…</p>}
        {!jobsLoading && !jobs.length && <p className="text-sm text-muted-foreground">{jobsSupported ? '当前邮箱暂无后台任务。' : '当前服务未启用后台任务，邮件同步结果请在邮件与执行记录中查看。'}</p>}
        {jobs.map((job) => <article key={job.id} className="space-y-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="flex items-center gap-2 font-medium">{isActiveJob(job) && <LoaderCircle className="size-4 animate-spin" />}{kindLabels[job.kind] || '后台处理'}</h2><Badge variant={job.status === 'failed' ? 'destructive' : 'secondary'}>{statusLabels[job.status] || '状态待更新'}</Badge></div>
          <p className="break-all text-xs text-muted-foreground">任务编号：{job.id}</p>
          <dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">创建时间</dt><dd>{time(job.createdAt)}</dd></div><div><dt className="text-muted-foreground">更新时间</dt><dd>{time(job.updatedAt)}</dd></div><div><dt className="text-muted-foreground">执行次数</dt><dd>{job.attempts} / {job.maxAttempts}</dd></div><div><dt className="text-muted-foreground">{job.finishedAt ? '结束时间' : '可执行时间'}</dt><dd>{time(job.finishedAt || job.availableAt)}</dd></div></dl>
          {(job.error || job.status === 'failed') && <p className="text-sm text-destructive">任务未完成，请核对配置与执行记录后重试。</p>}
          <div className="flex flex-wrap gap-2">
            {['failed', 'cancelled'].includes(job.status) && <Button size="sm" variant="outline" disabled={Boolean(pending)} onClick={() => act(job, 'retry')}>重试</Button>}
            {isActiveJob(job) && <Button size="sm" variant="outline" disabled={Boolean(pending)} onClick={() => act(job, 'cancel')}>取消任务</Button>}
            <Button size="sm" variant="ghost" asChild><Link to="/app/traces">执行记录</Link></Button>
            {job.status === 'succeeded' && <Button size="sm" variant="ghost" asChild><Link to={resultPath(job.kind)}>查看结果</Link></Button>}
          </div>
        </article>)}
      </CardContent>
    </Card>
  </div>;
}
