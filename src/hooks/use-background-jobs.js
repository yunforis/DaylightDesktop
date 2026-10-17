import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '@/lib/api';

export const isActiveJob = (job) => ['queued', 'running'].includes(job.status);

export function useBackgroundJobs(mailboxId, onComplete) {
  const [snapshot, setSnapshot] = useState({ mailboxId: '', jobs: [], loading: true, error: '', supported: true });
  const [revision, setRevision] = useState(0);
  const currentMailbox = useRef(mailboxId);
  currentMailbox.current = mailboxId;
  const complete = useRef(onComplete);
  const knownJobs = useRef(new Map());
  complete.current = onComplete;
  const refreshJobs = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!mailboxId) return;
    let stopped = false;
    let timer;
    let previous = knownJobs.current.get(mailboxId);
    async function poll() {
      let delay = 5000;
      try {
        const result = await request(`/jobs?mailbox=${encodeURIComponent(mailboxId)}`, 'GET', undefined, { mailboxId });
        if (stopped) return;
        const jobs = (result.jobs || []).filter((job) => job.mailboxId === mailboxId);
        const finished = previous && jobs.some((job) => previous.get(job.id) && isActiveJob(previous.get(job.id)) && !isActiveJob(job));
        previous = new Map(jobs.map((job) => [job.id, job]));
        knownJobs.current.set(mailboxId, previous);
        setSnapshot({ mailboxId, jobs, loading: false, error: '', supported: true });
        if (finished) complete.current?.();
        if (jobs.some(isActiveJob)) delay = 2000;
      } catch (error) {
        if (stopped) return;
        const supported = error.status !== 404;
        setSnapshot((value) => ({ mailboxId, jobs: value.mailboxId === mailboxId ? value.jobs : [], loading: false, supported, error: supported ? '任务状态暂时无法更新，正在自动重试。' : '' }));
        if (!supported) return;
        delay = 10000;
      }
      if (!stopped) timer = setTimeout(poll, delay);
    }
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [mailboxId, revision]);

  const trackJob = useCallback((job) => {
    if (!job?.id || job.mailboxId !== currentMailbox.current) return;
    const known = knownJobs.current.get(job.mailboxId) || new Map();
    known.set(job.id, job);
    knownJobs.current.set(job.mailboxId, known);
    if (!isActiveJob(job)) complete.current?.();
    setSnapshot((value) => ({ mailboxId: job.mailboxId, jobs: [job, ...(value.mailboxId === job.mailboxId ? value.jobs.filter((row) => row.id !== job.id) : [])], loading: false, error: '', supported: true }));
    refreshJobs();
  }, [refreshJobs]);

  const jobAction = useCallback(async (id, action) => {
    if (!['retry', 'cancel'].includes(action)) return;
    const result = await request(`/jobs/${encodeURIComponent(id)}/${action}`, 'POST', {}, { mailboxId });
    trackJob(result.job);
  }, [mailboxId, trackJob]);

  const visible = snapshot.mailboxId === mailboxId ? snapshot : { jobs: [], loading: Boolean(mailboxId), error: '', supported: true };
  return { jobs: visible.jobs, jobsLoading: visible.loading, jobsError: visible.error, jobsSupported: visible.supported, refreshJobs, trackJob, jobAction };
}
