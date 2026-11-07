import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { authApi, DiagnosisApiError, type AuthUser } from './api';

type AuthStatus = 'loading' | 'anonymous' | 'authenticated' | 'error';

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  initialized: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  setup: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [initialized, setInitialized] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const state = await authApi.status();
      setInitialized(state.initialized);
      if (!state.initialized) {
        setUser(null);
        setStatus('anonymous');
        return;
      }
      try {
        const me = await authApi.me();
        setUser(me.user);
        setStatus('authenticated');
      } catch (err) {
        if (err instanceof DiagnosisApiError && err.status === 401) {
          setUser(null);
          setStatus('anonymous');
          return;
        }
        throw err;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法连接诊断服务');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    setError(null);
    const result = await authApi.login(username, password);
    setUser(result.user);
    setInitialized(true);
    setStatus('authenticated');
  }, []);

  const setup = useCallback(async (username: string, password: string) => {
    setError(null);
    const result = await authApi.setup(username, password);
    setUser(result.user);
    setInitialized(true);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      initialized,
      error,
      login,
      setup,
      logout,
      refresh,
    }),
    [status, user, initialized, error, login, setup, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return value;
}
