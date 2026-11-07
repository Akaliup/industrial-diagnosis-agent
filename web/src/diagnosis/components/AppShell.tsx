import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  ClipboardCheck,
  Cpu,
  Database,
  FlaskConical,
  Inbox,
  Lock,
  LogOut,
  Menu,
  PlusCircle,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useAuth } from '../auth';
import { useWorkspace } from '../workspace';
import { ModeBadge } from './common';

const NAV_ITEMS = [
  {
    to: '/inbox',
    label: '报警收件箱',
    icon: Inbox,
    hint: '待处置报警与诊断入口',
  },
  {
    to: '/runs/new',
    label: '发起诊断',
    icon: PlusCircle,
    hint: '按设备与时间窗诊断',
  },
  { to: '/equipment', label: '设备台账', icon: Cpu, hint: '设备、测点与历史' },
  {
    to: '/sources',
    label: '数据与知识',
    icon: Database,
    hint: '来源适配器与手册',
  },
  {
    to: '/reviews',
    label: '复核与审批',
    icon: ClipboardCheck,
    hint: '人工结论与控制申请',
  },
  {
    to: '/eval',
    label: '评测与回放',
    icon: FlaskConical,
    hint: '50 例回归与轨迹',
  },
];

function pageTitle(pathname: string): string {
  if (pathname.startsWith('/inbox')) return '报警收件箱';
  if (pathname.startsWith('/runs/new')) return '发起诊断';
  if (pathname.startsWith('/runs/')) return '诊断工作台';
  if (pathname.startsWith('/equipment')) return '设备台账';
  if (pathname.startsWith('/sources')) return '数据与知识';
  if (pathname.startsWith('/reviews')) return '复核与审批';
  if (pathname.startsWith('/eval')) return '评测与回放';
  return '设备智诊';
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5 px-3" aria-label="诊断导航">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/runs/new'}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                isActive
                  ? 'bg-blue-50 font-medium text-blue-700'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-950',
              )
            }
          >
            {({ isActive }) => (
              <>
                <span
                  aria-hidden
                  className={cn(
                    'absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-blue-600 transition-opacity',
                    isActive ? 'opacity-100' : 'opacity-0',
                  )}
                />
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-5 py-4">
      <div className="flex size-8 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm">
        <Activity className="size-4" />
      </div>
      <div className="min-w-0">
        <div className="text-sm leading-tight font-semibold text-gray-950">
          设备智诊
        </div>
        <div className="mt-0.5 truncate text-[10px] tracking-wide text-gray-400">
          INDUSTRIAL DIAGNOSIS
        </div>
      </div>
    </div>
  );
}

export function AppShell() {
  const { user, logout } = useAuth();
  const { meta, loading: metaLoading, error: metaError } = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="diag-page min-h-dvh">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[228px] flex-col border-r border-gray-100 bg-white/95 backdrop-blur lg:flex">
        <Brand />
        <div className="mt-2 flex-1 overflow-y-auto diag-scroll">
          <NavList />
          <div className="mx-5 mt-6 border-t border-gray-100 pt-4">
            <div className="text-[10px] font-medium tracking-wider text-gray-400 uppercase">
              安全边界
            </div>
            <div className="mt-2 flex items-start gap-2 rounded-lg bg-gray-50 px-2.5 py-2 text-[11px] leading-4 text-gray-500">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-gray-400" />
              <span>只读诊断；控制动作仅生成审批建议，不执行真实控制。</span>
            </div>
          </div>
        </div>
        <div className="border-t border-gray-100 p-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <div className="flex size-7 items-center justify-center rounded-full bg-blue-50 text-[11px] font-semibold text-blue-700">
              {(user?.display_name || user?.username || '?')
                .slice(0, 1)
                .toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-gray-900">
                {user?.display_name || user?.username}
              </div>
              <div className="text-[10px] text-gray-400">
                {user?.role === 'admin' ? '管理员' : '成员'}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleLogout}
              aria-label="退出登录"
              title="退出登录"
            >
              <LogOut className="size-3.5 text-gray-400" />
            </Button>
          </div>
        </div>
      </aside>

      <div className="lg:pl-[228px]">
        <header className="sticky top-0 z-20 border-b border-gray-100 bg-white/85 backdrop-blur">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
            <Button
              variant="ghost"
              size="icon-sm"
              className="lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="打开导航"
            >
              <Menu className="size-4" />
            </Button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
                <span className="hidden sm:inline">设备智诊</span>
                <span className="hidden sm:inline">/</span>
                <span className="truncate font-medium text-gray-700">
                  {pageTitle(location.pathname)}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {meta ? (
                <>
                  <span className="hidden sm:inline-flex">
                    <ModeBadge mode={meta.data_mode} kind="data" />
                  </span>
                  <span className="hidden md:inline-flex">
                    <ModeBadge mode={meta.model_mode} kind="model" />
                  </span>
                </>
              ) : metaLoading ? (
                <span className="text-[11px] text-gray-400">读取模式…</span>
              ) : null}
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                <Lock className="size-3" />
                控制执行禁用
              </span>
            </div>
          </div>
          {metaError ? (
            <div className="border-t border-amber-100 bg-amber-50/70 px-4 py-1.5 text-[11px] text-amber-800 sm:px-6">
              {metaError}
            </div>
          ) : null}
        </header>

        <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-[280px] p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>诊断导航</SheetTitle>
            <SheetDescription>设备智诊页面导航</SheetDescription>
          </SheetHeader>
          <Brand />
          <NavList onNavigate={() => setMobileOpen(false)} />
          <div className="mt-auto p-4">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={handleLogout}
            >
              <LogOut className="size-3.5" />
              退出登录
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export function ShellFallback() {
  return (
    <div className="diag-page flex min-h-dvh items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-gray-400">
        <Wrench className="size-6 animate-pulse" />
        <span className="text-xs">正在连接诊断服务…</span>
      </div>
    </div>
  );
}
