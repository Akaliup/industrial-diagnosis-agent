import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, ArrowRight, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '../auth';

export function SetupPage() {
  const { setup } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    if (password.length < 8) {
      setError('密码长度不能少于 8 位');
      return;
    }
    setSubmitting(true);
    try {
      await setup(username.trim(), password);
      navigate('/inbox', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '初始化失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="diag-page flex min-h-dvh items-center justify-center px-5 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-lg bg-blue-600 text-white">
            <Activity className="size-4.5" />
          </div>
          <div>
            <div className="text-sm font-semibold text-gray-950">设备智诊</div>
            <div className="text-[10px] tracking-wider text-gray-400">
              INDUSTRIAL DIAGNOSIS
            </div>
          </div>
        </div>

        <div className="diag-card p-6">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700">
            <ShieldCheck className="size-3" />
            首次初始化
          </div>
          <h1 className="mt-3 text-xl font-semibold tracking-tight text-gray-950">
            创建管理员账户
          </h1>
          <p className="mt-1 text-xs leading-5 text-gray-500">
            该账户用于登录工业诊断 Agent
            与诊断工作台。系统不会写入通用默认密码，请设置你自己的强密码。
          </p>

          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="setup-username"
                className="text-xs font-medium text-gray-700"
              >
                用户名
              </label>
              <Input
                id="setup-username"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="3-32 位字母、数字或下划线"
                className="h-9 bg-white"
                required
                minLength={3}
                maxLength={32}
                pattern="[a-zA-Z0-9_]{3,32}"
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="setup-password"
                className="text-xs font-medium text-gray-700"
              >
                密码
              </label>
              <Input
                id="setup-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="至少 8 位"
                className="h-9 bg-white"
                required
                minLength={8}
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="setup-confirm"
                className="text-xs font-medium text-gray-700"
              >
                确认密码
              </label>
              <Input
                id="setup-confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                placeholder="再次输入密码"
                className="h-9 bg-white"
                required
                minLength={8}
              />
            </div>

            {error ? (
              <div
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700"
              >
                {error}
              </div>
            ) : null}

            <Button
              type="submit"
              className="h-9 w-full bg-blue-600 text-white hover:bg-blue-700"
              disabled={submitting}
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowRight className="size-4" />
              )}
              {submitting ? '正在创建…' : '创建并进入工作台'}
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center text-[11px] text-gray-400">
          初始化仅在该实例尚无用户时可用。
        </p>
      </div>
    </div>
  );
}
