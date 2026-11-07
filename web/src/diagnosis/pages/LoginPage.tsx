import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  FileSearch,
  Fingerprint,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '../auth';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const from =
    (location.state as { from?: string } | null)?.from &&
    (location.state as { from?: string }).from !== '/login'
      ? (location.state as { from?: string }).from!
      : '/inbox';

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="diag-page grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="diag-grid-lines relative hidden flex-col justify-between overflow-hidden border-r border-gray-100 px-12 py-10 lg:flex">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-blue-600 text-white">
            <Activity className="size-4" />
          </div>
          <div>
            <div className="text-sm font-semibold text-gray-950">设备智诊</div>
            <div className="text-[10px] tracking-wider text-gray-400">
              INDUSTRIAL DIAGNOSIS
            </div>
          </div>
        </div>

        <div className="max-w-lg">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700">
            <ShieldCheck className="size-3" />
            只读诊断 · 人工复核 · 控制执行禁用
          </div>
          <h1 className="mt-5 text-[34px] leading-[1.2] font-semibold tracking-tight text-gray-950">
            从一条报警，
            <br />
            到一份可复核的诊断报告。
          </h1>
          <p className="mt-4 max-w-md text-sm leading-6 text-gray-500">
            统一设备查询、异常定位、假设生成与证据验证。每条结论都带来源、时间窗与原文定位，交给人做最后判断。
          </p>

          <div className="mt-8 space-y-3">
            {[
              {
                icon: FileSearch,
                title: '统一取证',
                text: 'SCADA、MES、工单、手册与案例，一次查询全部留痕。',
              },
              {
                icon: Fingerprint,
                title: '证据链完整',
                text: '支持与反证同时保留，引用校验不通过即转人工。',
              },
              {
                icon: ShieldCheck,
                title: '安全边界',
                text: '诊断工具只读；控制动作只生成审批建议，不触发真实设备。',
              },
            ].map((feature) => {
              const Icon = feature.icon;
              return (
                <div key={feature.title} className="flex items-start gap-3">
                  <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500">
                    <Icon className="size-3.5" />
                  </div>
                  <div>
                    <div className="text-xs font-medium text-gray-900">
                      {feature.title}
                    </div>
                    <div className="mt-0.5 text-xs leading-5 text-gray-500">
                      {feature.text}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="text-[11px] text-gray-400">
          演示数据为 Mock；真实企业数据源与模型需单独配置并标记。
        </div>
      </section>

      <section className="flex items-center justify-center bg-gray-50/60 px-5 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <div className="flex size-8 items-center justify-center rounded-lg bg-blue-600 text-white">
              <Activity className="size-4" />
            </div>
            <div className="text-sm font-semibold text-gray-950">设备智诊</div>
          </div>

          <div className="diag-card p-6">
            <h2 className="text-lg font-semibold tracking-tight text-gray-950">
              登录工作台
            </h2>
            <p className="mt-1 text-xs text-gray-500">
              使用工业诊断 Agent 账户登录，诊断数据按工作区隔离。
            </p>

            <form onSubmit={handleSubmit} className="mt-5 space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="username"
                  className="text-xs font-medium text-gray-700"
                >
                  用户名
                </label>
                <Input
                  id="username"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="例如 demo"
                  className="h-9 bg-white"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="password"
                  className="text-xs font-medium text-gray-700"
                >
                  密码
                </label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="输入密码"
                  className="h-9 bg-white"
                  required
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
                {submitting ? '正在登录…' : '登录'}
              </Button>
            </form>
          </div>

          <p className="mt-4 text-center text-[11px] leading-5 text-gray-400">
            首次部署请由管理员在初始化页面创建账户。
          </p>
        </div>
      </section>
    </div>
  );
}
