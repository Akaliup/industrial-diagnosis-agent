import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AuthProvider, useAuth } from './auth';
import { WorkspaceProvider } from './workspace';
import { AppShell, ShellFallback } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { InboxPage } from './pages/InboxPage';
import { NewRunPage } from './pages/NewRunPage';
import { WorkbenchPage } from './pages/WorkbenchPage';
import { EquipmentPage } from './pages/EquipmentPage';
import { EquipmentDetailPage } from './pages/EquipmentDetailPage';
import { SourcesPage } from './pages/SourcesPage';
import { ReviewsPage } from './pages/ReviewsPage';
import { EvalPage } from './pages/EvalPage';

function ConnectionError() {
  const { error, refresh } = useAuth();
  return (
    <div className="diag-page flex min-h-dvh items-center justify-center px-6">
      <div className="diag-card w-full max-w-md p-6 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-red-50 text-red-600">
          <AlertTriangle className="size-5" />
        </div>
        <h1 className="mt-4 text-base font-semibold text-gray-900">
          无法连接诊断服务
        </h1>
        <p className="mt-1 text-xs leading-5 text-gray-500">
          {error ?? '请确认诊断服务已启动，且浏览器可以访问当前地址。'}
        </p>
        <Button className="mt-4" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="size-3.5" />
          重新连接
        </Button>
      </div>
    </div>
  );
}

function RequireAuth() {
  const { status, user, initialized } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <ShellFallback />;
  if (status === 'error') return <ConnectionError />;
  if (!initialized) return <Navigate to="/setup" replace />;
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <AppShell />;
}

function LoginGate() {
  const { status, user, initialized } = useAuth();
  if (status === 'loading') return <ShellFallback />;
  if (status === 'error') return <ConnectionError />;
  if (!initialized) return <Navigate to="/setup" replace />;
  if (user) return <Navigate to="/inbox" replace />;
  return <LoginPage />;
}

function SetupGate() {
  const { status, user, initialized } = useAuth();
  if (status === 'loading') return <ShellFallback />;
  if (status === 'error') return <ConnectionError />;
  if (initialized) return <Navigate to={user ? '/inbox' : '/login'} replace />;
  return <SetupPage />;
}

export function DiagnosisApp() {
  return (
    <AuthProvider>
      <WorkspaceProvider>
        <Routes>
          <Route path="/login" element={<LoginGate />} />
          <Route path="/setup" element={<SetupGate />} />
          <Route element={<RequireAuth />}>
            <Route index element={<Navigate to="/inbox" replace />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/runs/new" element={<NewRunPage />} />
            <Route path="/runs/:runId" element={<WorkbenchPage />} />
            <Route path="/equipment" element={<EquipmentPage />} />
            <Route
              path="/equipment/:equipmentId"
              element={<EquipmentDetailPage />}
            />
            <Route path="/sources" element={<SourcesPage />} />
            <Route path="/reviews" element={<ReviewsPage />} />
            <Route path="/eval" element={<EvalPage />} />
            <Route path="*" element={<Navigate to="/inbox" replace />} />
          </Route>
        </Routes>
      </WorkspaceProvider>
    </AuthProvider>
  );
}
