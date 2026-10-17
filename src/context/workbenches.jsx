import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ReceiptText, Users } from 'lucide-react';
import { request } from '@/lib/api';
import { useWorkspace } from '@/context/workspace';

export const WORKBENCH_FEATURES = [
  {
    id: 'invoices',
    name: '发票助手',
    description: '集中核对邮件附件中的发票，复制票据信息并查看原件。',
    path: '/app/invoices',
    icon: ReceiptText,
    keywords: '发票 报销 invoice',
  },
  {
    id: 'recruitment',
    name: '智能招聘',
    description: '管理候选人和简历，自然语言筛选人才，审核并发送面试邀约。',
    path: '/app/recruitment',
    icon: Users,
    keywords: '招聘 人才 候选人 简历 面试 HR recruitment',
  },
];

export function isRecruitmentTemplate(template) {
  return template?.id === 'recruitment' || Boolean(template?.capabilities?.includes('recruitment.use'));
}

const WorkbenchesContext = createContext(null);

export function WorkbenchesProvider({ children }) {
  const { jobsVersion } = useWorkspace();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const requestEpoch = useRef(0);
  const location = useLocation();
  const workbenchLocation = location.pathname.startsWith('/app/workbenches') ? `${location.pathname}${location.search}` : '';
  const reload = useCallback(async () => {
    const epoch = ++requestEpoch.current;
    setLoading(true);
    try {
      const result = await request('/scenarios');
      if (epoch === requestEpoch.current) {
        setData(result);
        setError('');
      }
      return result;
    } catch (error) {
      if (epoch === requestEpoch.current) setError(error.message);
      throw error;
    } finally {
      if (epoch === requestEpoch.current) setLoading(false);
    }
  }, []);

  useEffect(() => { reload().catch(() => {}); }, [reload, workbenchLocation, jobsVersion]);
  useEffect(() => {
    const refresh = () => { reload().catch(() => {}); };
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('focus', refresh); };
  }, [reload]);

  const value = useMemo(() => {
    const scenarioWorkbenches = data?.workbenches || [];
    return {
      data,
      error,
      loading,
      reload,
      scenarioWorkbenches,
      visibleFeatures: data ? WORKBENCH_FEATURES.filter((feature) => !data.navigation?.hiddenFeatureIds?.includes(feature.id)) : [],
      visibleWorkbenches: scenarioWorkbenches.filter((workbench) => !workbench.archived && !data.navigation?.hiddenWorkbenchIds?.includes(workbench.id)),
    };
  }, [data, error, loading, reload]);

  return <WorkbenchesContext.Provider value={value}>{children}</WorkbenchesContext.Provider>;
}

export function useWorkbenches() {
  const value = useContext(WorkbenchesContext);
  if (!value) throw new Error('useWorkbenches must be used within WorkbenchesProvider');
  return value;
}
