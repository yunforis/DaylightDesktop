import React, { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Users } from 'lucide-react';
import Recruitment from '@/Recruitment.jsx';
import { useWorkspace } from '@/context/workspace';
import { request } from '@/lib/api';

/**
 * 智能招聘工作区页。
 * 布局：指标卡 → 操作条 → 左人才/面试 + 右助手（桌面并排）。
 * 业务能力完整保留；视觉统一为本分支 shadcn 组件。
 */
export default function RecruitmentPage({ embedded = false, mailboxId: boundMailboxId = '' } = {}) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { state, isSyncing, sync, reload, openEmail } = useWorkspace();
  const settings = state?.settings || {};
  const mailboxId = boundMailboxId || settings.activeMailboxId || '';

  const selectedCandidateId = params.get('candidate') || null;
  const interviewId = params.get('interview') || null;

  const boxedRequest = useMemo(() => (
    (url, method, data) => request(url, method, data, mailboxId ? { mailboxId } : {})
  ), [mailboxId]);

  function setCandidate(id) {
    const next = new URLSearchParams(params);
    if (id) next.set('candidate', id);
    else next.delete('candidate');
    setParams(next, { replace: true });
  }

  function setInterview(id) {
    const next = new URLSearchParams(params);
    if (id) next.set('interview', id);
    else next.delete('interview');
    setParams(next, { replace: true });
  }

  return (
    <div className={embedded ? 'min-w-0 space-y-4' : 'mx-auto w-full max-w-5xl min-w-0 space-y-4'}>
      {!embedded && (
        <>
          <Link to="/app/workbenches" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />我的工作台</Link>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <Users className="size-6 text-muted-foreground" />
              智能招聘
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              PDF 简历入库、自然语言筛选候选人，面试邀约经审核后发送
            </p>
          </div>
        </>
      )}

      <Recruitment
        key={mailboxId}
        mailboxId={mailboxId}
        settings={settings}
        request={boxedRequest}
        selectedCandidateId={selectedCandidateId}
        onSelectCandidate={setCandidate}
        interviewId={interviewId}
        onSelectInterview={setInterview}
        onEmail={(emailId) => openEmail(emailId, mailboxId)}
        onSync={!boundMailboxId || boundMailboxId === (settings.activeMailboxId || '') ? () => sync('qq') : undefined}
        syncing={isSyncing}
        onSettings={() => navigate('/app/settings')}
        onUpdated={reload}
        refreshKey={state?.lastSync}
      />
    </div>
  );
}
