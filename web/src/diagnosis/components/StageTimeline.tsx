import { Check, Circle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Run } from '../contracts.generated';
import { stageLabel } from './common';

const STAGES = [
  'confirm_status',
  'locate_anomaly',
  'generate_hypotheses',
  'verify_evidence',
  'produce_report',
] as const;

export function StageTimeline({ run }: { run: Run }) {
  const currentIndex = STAGES.indexOf(run.stage as (typeof STAGES)[number]);
  const finished =
    run.status === 'completed' ||
    run.status === 'awaiting_human' ||
    run.status === 'failed' ||
    run.status === 'cancelled';

  return (
    <div className="flex flex-col gap-0 sm:flex-row sm:items-start">
      {STAGES.map((stage, index) => {
        const rounds = run.stage_rounds?.[stage] ?? 0;
        const done = finished
          ? run.status !== 'failed' && run.status !== 'cancelled'
          : index < currentIndex;
        const active = !finished && index === currentIndex;
        return (
          <div
            key={stage}
            className={cn(
              'relative flex flex-1 items-start gap-2.5 pb-4 sm:flex-col sm:items-center sm:gap-1.5 sm:pb-0',
            )}
          >
            {index < STAGES.length - 1 ? (
              <span
                aria-hidden
                className={cn(
                  'absolute top-7 left-[11px] h-[calc(100%-20px)] w-px sm:top-[11px] sm:left-[calc(50%+14px)] sm:h-px sm:w-[calc(100%-28px)]',
                  done ? 'bg-blue-200' : 'bg-gray-200',
                )}
              />
            ) : null}
            <span
              className={cn(
                'relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold transition-colors',
                done
                  ? 'border-blue-200 bg-blue-50 text-blue-700'
                  : active
                    ? 'border-blue-600 bg-blue-600 text-white shadow-[0_0_0_3px_rgba(37,99,235,0.12)]'
                    : 'border-gray-200 bg-white text-gray-400',
              )}
            >
              {done ? (
                <Check className="size-3" />
              ) : active ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Circle className="size-2.5" />
              )}
            </span>
            <div className="min-w-0 sm:text-center">
              <div
                className={cn(
                  'text-[11px] leading-5 font-medium',
                  active
                    ? 'text-blue-700'
                    : done
                      ? 'text-gray-700'
                      : 'text-gray-400',
                )}
              >
                {stageLabel(stage)}
              </div>
              <div className="text-[10px] text-gray-400">
                {rounds > 0 ? `${rounds} 轮` : '—'}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
