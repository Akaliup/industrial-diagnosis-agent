import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { diagnosisApi, type MetaView } from './api';
import { useAuth } from './auth';

interface WorkspaceContextValue {
  meta: MetaView | null;
  workspaceId: string | undefined;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const [meta, setMeta] = useState<MetaView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const value = await diagnosisApi.meta();
      setMeta(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法读取诊断工作区');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status !== 'authenticated') {
      setMeta(null);
      return;
    }
    void refresh();
  }, [status, refresh]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      meta,
      workspaceId: meta?.workspace_id,
      loading,
      error,
      refresh,
    }),
    [meta, loading, error, refresh],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace 必须在 WorkspaceProvider 内使用');
  return value;
}
