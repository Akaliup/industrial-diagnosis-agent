import { useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Database,
  FileText,
  FlaskConical,
  Loader2,
  Plus,
  RefreshCw,
  ShieldQuestion,
  Upload,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { diagnosisApi } from '../api';
import type { DiagnosisSource } from '../contracts.generated';
import { useAuth } from '../auth';
import { useWorkspace } from '../workspace';
import { useAsync } from '../hooks/useAsync';
import {
  EmptyState,
  ErrorState,
  LoadingBlock,
  ModeBadge,
  PageHeader,
  SectionTitle,
  formatTime,
} from '../components/common';

const KIND_LABELS: Record<string, string> = {
  scada: 'SCADA',
  rootcloud: '根云平台',
  mes: 'MES',
  work_order: '工单系统',
  manual: '手册库',
  case: '案例库',
  alarm: '报警源',
};

const STATUS_CONFIG: Record<
  string,
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  mock: {
    label: 'Mock',
    className: 'border-blue-200 bg-blue-50 text-blue-700',
    icon: FlaskConical,
  },
  configured: {
    label: '已配置',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    icon: CheckCircle2,
  },
  unconfigured: {
    label: '未配置',
    className: 'border-amber-200 bg-amber-50 text-amber-700',
    icon: ShieldQuestion,
  },
};

const DOC_STATUS: Record<string, string> = {
  indexed: '已索引',
  withdrawn: '已撤版',
  OCR_REQUIRED: '需要 OCR',
  imported: '已导入',
};

export function SourcesPage() {
  const { workspaceId } = useWorkspace();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [tab, setTab] = useState<'sources' | 'documents'>('sources');

  const { data, loading, error, reload } = useAsync(async () => {
    const [sourceResult, documentResult] = await Promise.all([
      diagnosisApi.sources(workspaceId),
      diagnosisApi.documents(workspaceId),
    ]);
    return {
      sources: sourceResult.sources,
      documents: documentResult.documents,
      tokenizer: documentResult.fts_tokenizer,
    };
  }, [workspaceId]);

  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; message: string }>
  >({});

  const [addOpen, setAddOpen] = useState(false);
  const [sourceForm, setSourceForm] = useState({
    id: '',
    kind: 'scada',
    name: '',
    data_mode: 'mock',
    auth_kind: 'none',
    notes: '',
  });
  const [sourceSubmitting, setSourceSubmitting] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);

  const [importOpen, setImportOpen] = useState(false);
  const [importForm, setImportForm] = useState({
    document_id: '',
    file_path: '',
    title: '',
    vendor: '',
    model: '',
    manual_version: '',
    effective_date: '',
  });
  const [importSubmitting, setImportSubmitting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [withdrawArmed, setWithdrawArmed] = useState<string | null>(null);

  const sourceStats = useMemo(() => {
    const sources = data?.sources ?? [];
    return {
      mock: sources.filter((source) => source.status === 'mock').length,
      configured: sources.filter((source) => source.status === 'configured')
        .length,
      unconfigured: sources.filter((source) => source.status === 'unconfigured')
        .length,
    };
  }, [data]);

  const handleTest = async (source: DiagnosisSource) => {
    setTesting(source.id);
    try {
      const result = await diagnosisApi.testSource(source.id, workspaceId);
      setTestResults((previous) => ({
        ...previous,
        [source.id]: { ok: result.ok, message: result.message },
      }));
      reload();
    } catch (err) {
      setTestResults((previous) => ({
        ...previous,
        [source.id]: {
          ok: false,
          message: err instanceof Error ? err.message : '测试失败',
        },
      }));
    } finally {
      setTesting(null);
    }
  };

  const handleAddSource = async (event: FormEvent) => {
    event.preventDefault();
    setSourceError(null);
    setSourceSubmitting(true);
    try {
      await diagnosisApi.addSource({
        workspace_id: workspaceId,
        id: sourceForm.id.trim(),
        kind: sourceForm.kind,
        name: sourceForm.name.trim(),
        data_mode: sourceForm.data_mode as 'mock' | 'replay' | 'live',
        auth_kind: sourceForm.auth_kind.trim() || 'none',
        notes: sourceForm.notes.trim(),
      });
      setAddOpen(false);
      setSourceForm({
        id: '',
        kind: 'scada',
        name: '',
        data_mode: 'mock',
        auth_kind: 'none',
        notes: '',
      });
      reload();
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : '新增来源失败');
    } finally {
      setSourceSubmitting(false);
    }
  };

  const handleImport = async (event: FormEvent) => {
    event.preventDefault();
    setImportError(null);
    setImportNotice(null);
    setImportSubmitting(true);
    try {
      const result = await diagnosisApi.importDocument({
        workspace_id: workspaceId,
        document_id: importForm.document_id.trim(),
        file_path: importForm.file_path.trim(),
        title: importForm.title.trim(),
        vendor: importForm.vendor.trim(),
        model: importForm.model.trim(),
        manual_version: importForm.manual_version.trim(),
        effective_date: importForm.effective_date || null,
      });
      setImportNotice(
        `已导入 ${result.result.documentId}：${result.result.chunks} 个片段，${result.result.pages} 页${
          result.result.error ? `；${result.result.error}` : ''
        }`,
      );
      reload();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : '导入手册失败');
    } finally {
      setImportSubmitting(false);
    }
  };

  const handleWithdraw = async (documentId: string) => {
    if (withdrawArmed !== documentId) {
      setWithdrawArmed(documentId);
      window.setTimeout(() => setWithdrawArmed(null), 4000);
      return;
    }
    try {
      await diagnosisApi.withdrawDocument(documentId, workspaceId);
      setWithdrawArmed(null);
      reload();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : '撤版失败');
    }
  };

  return (
    <div className="diag-fade-up">
      <PageHeader
        title="数据与知识"
        description="企业来源未配置时保持 UNCONFIGURED，不会静默回退 Mock。手册与案例进入本地索引，报告引用必须命中原文定位。"
        actions={
          isAdmin ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setImportOpen((value) => !value)}
              >
                <Upload className="size-3.5" />
                导入手册
              </Button>
              <Button
                size="sm"
                className="bg-blue-600 text-white hover:bg-blue-700"
                onClick={() => setAddOpen((value) => !value)}
              >
                <Plus className="size-3.5" />
                新增来源
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={reload}>
              <RefreshCw className="size-3.5" />
              刷新
            </Button>
          )
        }
      />

      <div className="mb-4 grid grid-cols-3 gap-3">
        {[
          {
            label: 'Mock 来源',
            value: sourceStats.mock,
            tone: 'text-blue-700',
          },
          {
            label: '已配置',
            value: sourceStats.configured,
            tone: 'text-emerald-700',
          },
          {
            label: '未配置',
            value: sourceStats.unconfigured,
            tone: 'text-amber-700',
          },
        ].map((item) => (
          <Card key={item.label} className="diag-card px-4 py-3">
            <div className="text-[11px] text-gray-500">{item.label}</div>
            <div className={cn('mt-1 text-2xl font-semibold', item.tone)}>
              {item.value}
            </div>
          </Card>
        ))}
      </div>

      {addOpen && isAdmin ? (
        <Card className="diag-card mb-4 p-4 diag-fade-in">
          <SectionTitle
            title="新增来源"
            hint="只登记连接元数据，不写入令牌或密钥。Live 来源初始状态为未配置。"
          />
          <form
            onSubmit={handleAddSource}
            className="grid gap-3 sm:grid-cols-2"
          >
            <Input
              value={sourceForm.id}
              onChange={(event) =>
                setSourceForm((form) => ({ ...form, id: event.target.value }))
              }
              placeholder="来源 ID，例如 src-plant-scada"
              className="h-8 bg-white text-xs"
              required
            />
            <Input
              value={sourceForm.name}
              onChange={(event) =>
                setSourceForm((form) => ({ ...form, name: event.target.value }))
              }
              placeholder="显示名称"
              className="h-8 bg-white text-xs"
              required
            />
            <select
              value={sourceForm.kind}
              onChange={(event) =>
                setSourceForm((form) => ({ ...form, kind: event.target.value }))
              }
              className="h-8 rounded-lg border border-gray-200 bg-white px-2 text-xs"
            >
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              value={sourceForm.data_mode}
              onChange={(event) =>
                setSourceForm((form) => ({
                  ...form,
                  data_mode: event.target.value,
                }))
              }
              className="h-8 rounded-lg border border-gray-200 bg-white px-2 text-xs"
            >
              <option value="mock">Mock</option>
              <option value="replay">回放</option>
              <option value="live">实时（未配置）</option>
            </select>
            <Input
              value={sourceForm.auth_kind}
              onChange={(event) =>
                setSourceForm((form) => ({
                  ...form,
                  auth_kind: event.target.value,
                }))
              }
              placeholder="认证方式，例如 token / signature / none"
              className="h-8 bg-white text-xs"
            />
            <Input
              value={sourceForm.notes}
              onChange={(event) =>
                setSourceForm((form) => ({
                  ...form,
                  notes: event.target.value,
                }))
              }
              placeholder="说明（不要填写密钥）"
              className="h-8 bg-white text-xs"
            />
            {sourceError ? (
              <div className="text-[11px] text-red-600 sm:col-span-2">
                {sourceError}
              </div>
            ) : null}
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setAddOpen(false)}
              >
                取消
              </Button>
              <Button
                type="submit"
                size="sm"
                className="bg-blue-600 text-white hover:bg-blue-700"
                disabled={sourceSubmitting}
              >
                {sourceSubmitting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Plus className="size-3.5" />
                )}
                保存来源
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {importOpen && isAdmin ? (
        <Card className="diag-card mb-4 p-4 diag-fade-in">
          <SectionTitle
            title="导入手册（服务器路径）"
            hint="文件必须位于服务端允许的知识目录。扫描 PDF 需要文字层，否则标记 OCR_REQUIRED。"
          />
          <form onSubmit={handleImport} className="grid gap-3 sm:grid-cols-2">
            <Input
              value={importForm.document_id}
              onChange={(event) =>
                setImportForm((form) => ({
                  ...form,
                  document_id: event.target.value,
                }))
              }
              placeholder="文档 ID，例如 DOC-NP300-V2"
              className="h-8 bg-white text-xs"
              required
            />
            <Input
              value={importForm.file_path}
              onChange={(event) =>
                setImportForm((form) => ({
                  ...form,
                  file_path: event.target.value,
                }))
              }
              placeholder="服务器文件路径，例如 fixtures/diagnosis/manuals/np300.pdf"
              className="h-8 bg-white text-xs"
              required
            />
            <Input
              value={importForm.title}
              onChange={(event) =>
                setImportForm((form) => ({
                  ...form,
                  title: event.target.value,
                }))
              }
              placeholder="文档标题"
              className="h-8 bg-white text-xs"
              required
            />
            <Input
              value={importForm.vendor}
              onChange={(event) =>
                setImportForm((form) => ({
                  ...form,
                  vendor: event.target.value,
                }))
              }
              placeholder="厂商"
              className="h-8 bg-white text-xs"
              required
            />
            <Input
              value={importForm.model}
              onChange={(event) =>
                setImportForm((form) => ({
                  ...form,
                  model: event.target.value,
                }))
              }
              placeholder="适用型号"
              className="h-8 bg-white text-xs"
              required
            />
            <Input
              value={importForm.manual_version}
              onChange={(event) =>
                setImportForm((form) => ({
                  ...form,
                  manual_version: event.target.value,
                }))
              }
              placeholder="手册版本"
              className="h-8 bg-white text-xs"
              required
            />
            <Input
              type="date"
              value={importForm.effective_date}
              onChange={(event) =>
                setImportForm((form) => ({
                  ...form,
                  effective_date: event.target.value,
                }))
              }
              className="h-8 bg-white text-xs"
            />
            {importError ? (
              <div className="text-[11px] text-red-600 sm:col-span-2">
                {importError}
              </div>
            ) : null}
            {importNotice ? (
              <div className="text-[11px] text-emerald-700 sm:col-span-2">
                {importNotice}
              </div>
            ) : null}
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setImportOpen(false)}
              >
                关闭
              </Button>
              <Button
                type="submit"
                size="sm"
                className="bg-blue-600 text-white hover:bg-blue-700"
                disabled={importSubmitting}
              >
                {importSubmitting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Upload className="size-3.5" />
                )}
                导入并索引
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      <div className="mb-4 flex items-center gap-1 rounded-lg bg-gray-50 p-0.5 sm:w-fit">
        {[
          { key: 'sources' as const, label: '数据来源', icon: Database },
          { key: 'documents' as const, label: '知识手册', icon: BookOpen },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors',
                tab === item.key
                  ? 'bg-white font-medium text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-800',
              )}
            >
              <Icon className="size-3.5" />
              {item.label}
            </button>
          );
        })}
      </div>

      {loading && !data ? (
        <LoadingBlock rows={4} />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : tab === 'sources' ? (
        <div className="diag-stagger grid gap-3 lg:grid-cols-2">
          {(data?.sources ?? []).map((source) => {
            const config =
              STATUS_CONFIG[source.status] ?? STATUS_CONFIG.unconfigured;
            const StatusIcon = config.icon;
            const result = testResults[source.id];
            return (
              <Card key={source.id} className="diag-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium text-gray-900">
                        {source.name}
                      </span>
                      <Badge
                        variant="outline"
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[10px]',
                          config.className,
                        )}
                      >
                        <StatusIcon className="mr-0.5 size-2.5" />
                        {config.label}
                      </Badge>
                      {source.status === 'unconfigured' ? (
                        <Badge
                          variant="outline"
                          className="rounded-full border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700"
                        >
                          未连接企业系统
                        </Badge>
                      ) : (
                        <ModeBadge mode={source.data_mode} kind="source" />
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-gray-400">
                      <span className="diag-code">{source.id}</span>
                      <span>{KIND_LABELS[source.kind] ?? source.kind}</span>
                      <span>认证 {source.auth_kind}</span>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="xs"
                    className="shrink-0"
                    onClick={() => handleTest(source)}
                    disabled={testing === source.id}
                  >
                    {testing === source.id ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3" />
                    )}
                    测试
                  </Button>
                </div>

                <p className="mt-2 text-[11px] leading-5 text-gray-500">
                  {source.notes}
                </p>

                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-gray-100 pt-2 text-[10px] text-gray-400">
                  <span>
                    最近测试 {formatTime(source.last_test_at)}
                    {source.last_test_ok === null
                      ? ''
                      : source.last_test_ok
                        ? ' · 成功'
                        : ' · 失败'}
                  </span>
                </div>

                {result ? (
                  <div
                    className={cn(
                      'mt-2 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[10px] diag-fade-in',
                      result.ok
                        ? 'border-emerald-100 bg-emerald-50 text-emerald-700'
                        : 'border-amber-200 bg-amber-50 text-amber-800',
                    )}
                  >
                    {result.ok ? (
                      <CheckCircle2 className="mt-0.5 size-3 shrink-0" />
                    ) : (
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                    )}
                    {result.message}
                  </div>
                ) : null}
              </Card>
            );
          })}
          {(data?.sources.length ?? 0) === 0 ? (
            <div className="lg:col-span-2">
              <EmptyState
                icon={<Database className="size-5" />}
                title="还没有数据来源"
                description="在报警收件箱载入演示数据，或由管理员新增只读来源。"
              />
            </div>
          ) : null}
        </div>
      ) : (
        <Card className="diag-card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
            <div className="text-xs font-medium text-gray-800">
              知识手册与版本
            </div>
            <div className="text-[10px] text-gray-400">
              FTS 分词器 {data?.tokenizer ?? '不可用'}
            </div>
          </div>
          {(data?.documents.length ?? 0) === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<FileText className="size-5" />}
                title="还没有手册"
                description="载入演示数据会导入 4 份设备手册（含中文摘要与英文原版）。"
              />
            </div>
          ) : (
            <div className="diag-stagger divide-y divide-gray-100">
              {(data?.documents ?? []).map((document) => (
                <div
                  key={document.document_id}
                  className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center"
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-gray-400">
                    <FileText className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium text-gray-900">
                        {document.title}
                      </span>
                      <Badge
                        variant="outline"
                        className={cn(
                          'rounded-full text-[9px]',
                          document.status === 'withdrawn'
                            ? 'border-gray-200 bg-gray-50 text-gray-500'
                            : document.status === 'OCR_REQUIRED'
                              ? 'border-amber-200 bg-amber-50 text-amber-700'
                              : 'border-emerald-200 bg-emerald-50 text-emerald-700',
                        )}
                      >
                        {DOC_STATUS[document.status] ?? document.status}
                      </Badge>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-gray-400">
                      <span className="diag-code">{document.document_id}</span>
                      <span>
                        {document.vendor} {document.model}
                      </span>
                      <span>版本 {document.manual_version}</span>
                      <span>生效 {document.effective_date ?? '—'}</span>
                      <span className="diag-code">
                        {document.file_hash.slice(0, 12)}…
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button variant="outline" size="xs" asChild>
                      <a
                        href={diagnosisApi.documentUrl(
                          document.document_id,
                          workspaceId,
                        )}
                        target="_blank"
                        rel="noreferrer"
                      >
                        预览
                      </a>
                    </Button>
                    {isAdmin && document.status !== 'withdrawn' ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        className={cn(
                          withdrawArmed === document.document_id &&
                            'text-red-700',
                        )}
                        onClick={() => handleWithdraw(document.document_id)}
                      >
                        {withdrawArmed === document.document_id ? (
                          <XCircle className="size-3" />
                        ) : null}
                        {withdrawArmed === document.document_id
                          ? '确认撤版'
                          : '撤版'}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <p className="mt-4 flex items-start gap-1.5 text-[10px] leading-5 text-gray-400">
        <ShieldQuestion className="mt-0.5 size-3 shrink-0" />
        根云平台等企业专有接口在没有正式文档与账号时保持未配置；系统不会猜测签名算法或把
        Mock 数据标记为真实数据。
      </p>
    </div>
  );
}
