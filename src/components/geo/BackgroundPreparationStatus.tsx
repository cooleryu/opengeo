'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Check, CircleAlert, Loader2 } from 'lucide-react';
import type {
  QuestionGenerationJob,
  QuestionGenerationProgress,
} from '@/lib/geo/question-types';
import { useUiLanguage } from './UiLanguageContext';
import './BackgroundPreparationStatus.css';

type BackgroundPreparationStatusProps = {
  job: QuestionGenerationJob | null | undefined;
  onOpen?: () => void;
};

const stageLabelKeys: Record<
  QuestionGenerationJob['stage'],
  | 'prep.stagePreparing'
  | 'prep.stagePlanning'
  | 'prep.stageGenerating'
  | 'prep.stageChecking'
  | 'prep.stageRepairing'
  | 'prep.stageReviewing'
  | 'prep.stageSaving'
> = {
  preparing: 'prep.stagePreparing',
  planning: 'prep.stagePlanning',
  generating: 'prep.stageGenerating',
  checking: 'prep.stageChecking',
  repairing: 'prep.stageRepairing',
  reviewing: 'prep.stageReviewing',
  saving: 'prep.stageSaving',
};

const stageGroups = [
  { labelKey: 'prep.stepTopics' as const, step: 'planning' },
  { labelKey: 'prep.stepDraft' as const, step: 'generating' },
  { labelKey: 'prep.stepReview' as const, step: 'reviewing' },
  { labelKey: 'prep.stepSave' as const, step: 'saving' },
];

export function questionGenerationStepIndex(
  progress: QuestionGenerationProgress | undefined | null,
  checkpoints: QuestionGenerationJob['checkpoints'] = [],
) {
  if (!progress) return 0;
  if (progress.workflowStep) {
    return stageGroups.findIndex(
      (group) => group.step === progress.workflowStep,
    );
  }
  if (progress.stage === 'saving') return 3;
  if (progress.stage === 'reviewing') return 2;
  if (['checking', 'repairing'].includes(progress.stage)) {
    const hasReviewResult = checkpoints.some((checkpoint) =>
      checkpoint.key.startsWith('review-'),
    );
    const checkingReview =
      progress.message.includes('审核') && !/等待.*审核/.test(progress.message);
    return hasReviewResult || checkingReview ? 2 : 1;
  }
  return progress.stage === 'generating' ? 1 : 0;
}

/** Older running jobs lack workflowStep; keep a review that was actually observed. */
export function useQuestionGenerationStep(
  progress: QuestionGenerationProgress | undefined | null,
  runKey: string | undefined,
  checkpoints?: QuestionGenerationJob['checkpoints'],
) {
  const [observed, setObserved] = useState({ runKey, step: 0 });
  const inferred = questionGenerationStepIndex(progress, checkpoints);
  const step = progress?.workflowStep
    ? inferred
    : Math.max(inferred, observed.runKey === runKey ? observed.step : 0);
  if (observed.runKey !== runKey || observed.step !== step) {
    setObserved({ runKey, step });
  }
  return step;
}

export function QuestionGenerationRequestStatus({
  request,
  active,
}: {
  request: QuestionGenerationProgress['request'];
  active: boolean;
}) {
  const { uiLanguage, t } = useUiLanguage();
  if (!request) return null;
  const label =
    !active && ['connecting', 'connected', 'receiving'].includes(request.phase)
      ? t('prep.reqStopped')
      : request.phase === 'connecting'
        ? t('prep.reqConnecting')
        : request.phase === 'connected'
          ? t('prep.reqConnected')
          : request.phase === 'receiving'
            ? request.outputCharacters > 0
              ? t('prep.reqReceiving')
              : t('prep.reqConnected')
            : request.phase === 'completed'
              ? t('prep.reqCompleted')
              : t('prep.reqFailed');
  return (
    <p className="og-background-preparation-request">
      {label}
      {request.outputCharacters > 0 && (
        <span>
          {t('prep.charsReceived', {
            count:
              uiLanguage === 'en'
                ? request.outputCharacters.toLocaleString('en-US')
                : request.outputCharacters.toLocaleString(),
          })}
        </span>
      )}
    </p>
  );
}

function checkpointKind(key: string, uiLanguage: 'en' | 'zh') {
  if (uiLanguage === 'en') {
    if (key === 'directions') return 'Intents';
    if (key.startsWith('draft-')) return 'Drafted';
    if (key.startsWith('review-')) return 'Reviewed';
    if (key.startsWith('set-review')) return 'Coverage';
    if (key === 'refinement-draft') return 'Drafted';
    if (key === 'refinement-review') return 'Reviewed';
    return 'Checkpoint';
  }
  if (key === 'directions') return '选题方向';
  if (key.startsWith('draft-')) return '候选问题 · 待审核';
  if (key.startsWith('review-')) return '审核结果';
  return '阶段成果';
}

function checkpointTitle(
  checkpoint: { key: string; title: string },
  uiLanguage: 'en' | 'zh',
) {
  if (uiLanguage !== 'en') return checkpoint.title;
  const { key } = checkpoint;
  if (key === 'directions') return 'Buyer intent themes';
  if (key.startsWith('review-')) return `Batch ${key.slice(7)} independent review`;
  if (key === 'set-review-0') return 'Full-set coverage review';
  if (key === 'set-review-1') return 'Refined set coverage review';
  if (key === 'refinement-draft') return 'Supplemental draft questions';
  if (key === 'refinement-review') return 'Supplemental independent review';
  return checkpoint.title;
}

function checkpointItem(item: string, uiLanguage: 'en' | 'zh', key: string) {
  if (uiLanguage !== 'en') return item;
  let normalized = item
    .replace(/^纳入：/, 'Included: ')
    .replace(/^暂缓：/, 'Deferred: ')
    .replace(/^排除：/, 'Excluded: ');
  if (key.startsWith('set-review')) {
    normalized = normalized.replace(/：/, ': ');
  }
  return normalized;
}

function elapsedLabel(startedAt: string, endedAt: number, uiLanguage: 'en' | 'zh') {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started) || !Number.isFinite(endedAt)) return null;
  const seconds = Math.max(0, Math.floor((endedAt - started) / 1000));
  if (uiLanguage === 'en') {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export default function BackgroundPreparationStatus({
  job,
  onOpen,
}: BackgroundPreparationStatusProps) {
  const { uiLanguage, t } = useUiLanguage();
  const [now, setNow] = useState(() => Date.now());
  const active = job?.status === 'queued' || job?.status === 'running';
  const workflowStep = useQuestionGenerationStep(
    job,
    job?.id,
    job?.checkpoints,
  );

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, job?.id]);

  if (!job) return null;

  const complete = job.status === 'completed';
  const currentStage = job.status === 'queued' ? -1 : workflowStep;
  const title = complete
    ? t('prep.ready')
    : job.status === 'failed'
      ? t('prep.failed')
      : job.status === 'interrupted'
        ? t('prep.interrupted')
        : job.status === 'superseded'
          ? t('prep.superseded')
          : job.status === 'queued'
            ? t('prep.queued')
            : t(stageLabelKeys[job.stage]);
  const rawDetail = job.error || job.message;
  const hasHan = Boolean(rawDetail && /[\p{Script=Han}]/u.test(rawDetail));
  const detail =
    uiLanguage === 'en' && hasHan && !active && job.error
      ? 'Question preparation encountered a review mismatch. Please retry.'
      : rawDetail;
  const showDetail =
    !complete &&
    Boolean(detail) &&
    detail !== title &&
    !(uiLanguage === 'en' && hasHan && !job.error);
  const elapsed = elapsedLabel(
    job.startedAt,
    active ? now : Date.parse(job.completedAt || job.updatedAt),
    uiLanguage,
  );
  const checkpoints =
    job.checkpoints?.filter((checkpoint) => checkpoint.items.length > 0) ?? [];

  return (
    <section
      className={`og-background-preparation ${active ? 'is-active' : complete ? 'is-complete' : 'is-stopped'}`}
      aria-label={t('prep.stagePreparing')}
    >
      <div className="og-background-preparation-icon" aria-hidden="true">
        {active ? (
          <Loader2 size={20} className="og-background-preparation-spin" />
        ) : complete ? (
          <Check size={20} />
        ) : (
          <CircleAlert size={20} />
        )}
      </div>
      <div className="og-background-preparation-content">
        <div className="og-background-preparation-heading">
          <strong role="status" aria-live="polite">
            {title}
          </strong>
          {elapsed && (
            <span className="og-background-preparation-elapsed">
              {active
                ? t('prep.elapsedActive', { time: elapsed })
                : t('prep.elapsedDone', { time: elapsed })}
            </span>
          )}
        </div>
        {showDetail && <p>{detail}</p>}
        <QuestionGenerationRequestStatus
          request={job.request}
          active={active}
        />
        <ol
          className="og-background-preparation-stages"
          aria-label={t('prep.stagePreparing')}
        >
          {stageGroups.map((group, index) => {
            const done = complete || index < currentStage;
            const current = !complete && index === currentStage;
            return (
              <li
                key={group.step}
                className={done ? 'is-done' : current ? 'is-current' : ''}
                aria-current={current ? 'step' : undefined}
              >
                <span aria-hidden="true">
                  {done ? <Check size={11} /> : index + 1}
                </span>
                {t(group.labelKey)}
              </li>
            );
          })}
        </ol>
        {checkpoints.length > 0 && (
          <details className="og-background-preparation-checkpoints">
            <summary>{t('prep.checkpointsSummary')}</summary>
            <div className="og-background-preparation-checkpoint-list">
              {checkpoints.map((checkpoint, checkpointIndex) => (
                <details
                  className="og-background-preparation-checkpoint"
                  key={checkpoint.key}
                  open={checkpointIndex === checkpoints.length - 1}
                >
                  <summary className="og-background-preparation-checkpoint-heading">
                    <strong>{checkpointTitle(checkpoint, uiLanguage)}</strong>
                    <span>{checkpointKind(checkpoint.key, uiLanguage)}</span>
                  </summary>
                  <ul>
                    {checkpoint.items.slice(0, 2).map((item, index) => (
                      <li key={index}>
                        {checkpointItem(item, uiLanguage, checkpoint.key)}
                      </li>
                    ))}
                  </ul>
                  {checkpoint.items.length > 2 && (
                    <details className="og-background-preparation-more">
                      <summary>
                        {uiLanguage === 'en'
                          ? `Show ${checkpoint.items.length - 2} more`
                          : `查看其余 ${checkpoint.items.length - 2} 条`}
                      </summary>
                      <ul>
                        {checkpoint.items.slice(2).map((item, index) => (
                          <li key={index}>
                            {checkpointItem(item, uiLanguage, checkpoint.key)}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </details>
              ))}
            </div>
          </details>
        )}
        {active && (
          <p className="og-background-preparation-hint">
            {t('prep.backgroundHint')}
          </p>
        )}
      </div>
      {onOpen && (
        <button
          type="button"
          className="og-background-preparation-open"
          onClick={onOpen}
        >
          {complete
            ? t('prep.openReady')
            : active
              ? t('prep.openActive')
              : t('prep.openStopped')}
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      )}
    </section>
  );
}
