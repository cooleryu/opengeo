'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Check, CircleAlert, Loader2 } from 'lucide-react';
import type { QuestionGenerationJob } from '@/lib/geo/question-types';
import { useUiLanguage } from './UiLanguageContext';
import './BackgroundPreparationStatus.css';

type BackgroundPreparationStatusProps = {
  job: QuestionGenerationJob | null | undefined;
  onOpen?: () => void;
};

function elapsedLabel(startedAt: string, endedAt: number, uiLanguage: 'en' | 'zh') {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started) || !Number.isFinite(endedAt)) return null;
  const seconds = Math.max(0, Math.floor((endedAt - started) / 1000));
  const isEn = uiLanguage === 'en';
  if (seconds < 60) return isEn ? `${seconds}s` : `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return isEn
      ? `${minutes}m ${seconds % 60}s`
      : `${minutes} 分 ${seconds % 60} 秒`;
  }
  return isEn
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export default function BackgroundPreparationStatus({
  job,
  onOpen,
}: BackgroundPreparationStatusProps) {
  const { uiLanguage, t } = useUiLanguage();
  const [now, setNow] = useState(() => Date.now());
  const active = job?.status === 'queued' || job?.status === 'running';

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, job?.id]);

  if (!job) return null;

  const complete = job.status === 'completed';
  const title = complete
    ? t('prep.ready')
    : job.status === 'failed'
      ? t('prep.failed')
      : job.status === 'interrupted'
        ? t('prep.interrupted')
        : job.status === 'superseded'
          ? t('prep.superseded')
          : t('prep.writingQuestions');
  const rawDetail = job.error || '';
  const hasHan = Boolean(rawDetail && /[\p{Script=Han}]/u.test(rawDetail));
  const detail =
    uiLanguage === 'en' && hasHan && !active && job.error
      ? 'Question preparation did not finish. Please retry.'
      : rawDetail;
  const showDetail = !complete && !active && Boolean(detail) && detail !== title;
  const elapsed = elapsedLabel(
    job.startedAt,
    active ? now : Date.parse(job.completedAt || job.updatedAt),
    uiLanguage,
  );

  return (
    <section
      className={`og-background-preparation ${active ? 'is-active' : complete ? 'is-complete' : 'is-stopped'}`}
      aria-label={t('prep.writingQuestions')}
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
