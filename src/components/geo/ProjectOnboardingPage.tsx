'use client';

import Link from 'next/link';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Building2,
  Check,
  CircleAlert,
  Github,
  Globe2,
  Loader2,
  Lock,
  PencilLine,
  Plus,
  X,
} from 'lucide-react';
import { resolveProjectUiLanguage } from '@/lib/geo/i18n';
import type { GeoProject } from '@/lib/geo/types';
import type { QuestionGenerationJob } from '@/lib/geo/question-types';
import type {
  OnboardingRecord,
  ProjectEntryKind,
} from '@/lib/geo/project-onboarding-types';
import BackgroundPreparationStatus from './BackgroundPreparationStatus';
import OpenGeoBrandMark from './OpenGeoBrandMark';
import { UiLanguageProvider, useUiLanguage } from './UiLanguageContext';
import './project-onboarding.css';

const entryTypes = [
  {
    id: 'repository' as const,
    titleKey: 'onboarding.typeRepoTitle' as const,
    hintKey: 'onboarding.typeRepoHint' as const,
    labelKey: 'onboarding.typeRepoLabel' as const,
    placeholderKey: 'onboarding.typeRepoPlaceholder' as const,
    Icon: Github,
  },
  {
    id: 'company' as const,
    titleKey: 'onboarding.typeProductTitle' as const,
    hintKey: 'onboarding.typeProductHint' as const,
    labelKey: 'onboarding.typeProductLabel' as const,
    placeholderKey: 'onboarding.typeProductPlaceholder' as const,
    Icon: Building2,
  },
];

type ProjectResponse = {
  project: GeoProject;
  onboarding: OnboardingRecord | null;
  questionGeneration?: QuestionGenerationJob | null;
};

function CapabilityText({ text }: { text: string }) {
  const cnSeparator = text.indexOf('：');
  const enSeparator = cnSeparator > 0 ? -1 : text.indexOf(': ');
  const separator = cnSeparator > 0 ? cnSeparator : enSeparator;
  if (separator <= 0) return <>{text}</>;
  const divider = cnSeparator > 0 ? '：' : ': ';
  return (
    <>
      <strong>{text.slice(0, separator)}</strong>
      {divider}
      {text.slice(separator + divider.length)}
    </>
  );
}

function ProjectOnboardingPageInner() {
  const { uiLanguage, setUiLanguage, t } = useUiLanguage();
  const [kind, setKind] = useState<ProjectEntryKind>('repository');
  const [url, setUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [projectId, setProjectId] = useState('');
  const [result, setResult] = useState<ProjectResponse | null>(null);
  const [matchedExisting, setMatchedExisting] = useState(false);
  const [hasProjects, setHasProjects] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [pendingRevision, setPendingRevision] = useState('');
  const [revisionError, setRevisionError] = useState('');
  const revisionRequest = useRef({ id: '', feedback: '' });
  const revisionSubmitting = useRef(false);
  const requestId = useRef('');
  const submittedInput = useRef('');
  const syncedProjectLang = useRef('');
  const selection = entryTypes.find((item) => item.id === kind)!;
  const record = result?.onboarding;
  const working = Boolean(
    record && ['queued', 'reading', 'analyzing'].includes(record.status),
  );
  const ready = record?.status === 'ready';
  const questionGeneration = result?.questionGeneration;
  const analysis = record?.analysis;
  const revising = busy || Boolean(pendingRevision && working);
  const revisionFailed =
    record?.status === 'failed' && Boolean(record.revision);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams(window.location.search);
    const id = params.get('project') || '';
    if (!id) {
      setUiLanguage('en');
    }
    if (params.get('next') === 'questions' && params.get('revision')) {
      setPendingRevision(params.get('revision')!);
      setConfirmOpen(true);
    }
    void fetch('/api/geo/projects', { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok)
          throw new Error(payload.error || '暂时无法读取项目。');
        if (!active) return;
        setHasProjects(payload.hasProjects);
        setProjectId(id);
        if (!id) setLoading(false);
      })
      .catch((err) => {
        if (active) {
          setError(err.message);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [setUiLanguage]);

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/geo/projects?project=${encodeURIComponent(projectId)}`,
          { cache: 'no-store', signal: controller.signal },
        );
        const payload: ProjectResponse & { error?: string } =
          await response.json();
        if (!response.ok)
          throw new Error(payload.error || '暂时无法读取进度。');
        if (controller.signal.aborted) return;
        setResult(payload);
        const lockedLang = resolveProjectUiLanguage({
          uiLanguage: payload.onboarding?.uiLanguage ?? payload.project?.uiLanguage,
          summaryOrDescription:
            payload.onboarding?.analysis?.summary || payload.project?.description,
        });
        const langKey = `${projectId}:${lockedLang}`;
        if (syncedProjectLang.current !== langKey) {
          syncedProjectLang.current = langKey;
          setUiLanguage(lockedLang);
        }
        setError('');
        setLoading(false);
        const continuation = new URLSearchParams(window.location.search);
        const requestedRevision = continuation.get('revision');
        if (
          !revisionSubmitting.current &&
          continuation.get('next') === 'questions' &&
          requestedRevision &&
          payload.onboarding?.status === 'ready' &&
          payload.onboarding.revision?.id !== requestedRevision
        ) {
          // An interrupted POST may never have reached the server. Do not trap
          // a refreshed page behind an unsaved continuation request.
          setPendingRevision('');
          setRevisionError(
            '未找到上次修改的保存记录。请重新补充，或直接继续。',
          );
          window.history.replaceState(
            null,
            '',
            `/new?project=${encodeURIComponent(projectId)}`,
          );
        }
        if (
          (payload.onboarding &&
            ['queued', 'reading', 'analyzing'].includes(
              payload.onboarding.status,
            )) ||
          (payload.questionGeneration &&
            ['queued', 'running'].includes(payload.questionGeneration.status))
        ) {
          timer = setTimeout(poll, 2000);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : '暂时无法读取进度。');
          setLoading(false);
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [projectId, refreshKey, setUiLanguage]);

  useEffect(() => {
    const restorePage = (event: PageTransitionEvent) => {
      if (event.persisted) setRefreshKey((key) => key + 1);
    };
    const refreshVisiblePage = () => {
      if (document.visibilityState === 'visible')
        setRefreshKey((key) => key + 1);
    };
    window.addEventListener('pageshow', restorePage);
    document.addEventListener('visibilitychange', refreshVisiblePage);
    return () => {
      window.removeEventListener('pageshow', restorePage);
      document.removeEventListener('visibilitychange', refreshVisiblePage);
    };
  }, []);

  useEffect(() => {
    const revision = record?.revision;
    if (!pendingRevision || revision?.id !== pendingRevision) return;
    revisionRequest.current = { id: revision.id, feedback: revision.feedback };
    setFeedback(revision.feedback);
    if (record?.status === 'ready' && revision.completedAt) {
      window.location.assign(
        `/?view=overview&project=${encodeURIComponent(projectId)}`,
      );
    }
  }, [record, pendingRevision, projectId]);

  const continueToQuestions = async () => {
    if (revisionSubmitting.current || revising) return;
    const correction = feedback.trim();
    if (!correction) {
      if (!ready || pendingRevision) return;
      window.location.assign(
        `/?view=overview&project=${encodeURIComponent(projectId)}`,
      );
      return;
    }
    if (revisionRequest.current.feedback !== correction) {
      revisionRequest.current = {
        id: crypto.randomUUID(),
        feedback: correction,
      };
    }
    const id = revisionRequest.current.id;
    const retry = revisionFailed && record?.revision?.id === id;
    revisionSubmitting.current = true;
    setBusy(true);
    setRevisionError('');
    setPendingRevision(id);
    // Keep the continuation across reloads; the correction itself is saved server-side.
    window.history.replaceState(
      null,
      '',
      `/new?project=${encodeURIComponent(projectId)}&revision=${encodeURIComponent(id)}&next=questions`,
    );
    try {
      const response = await fetch('/api/geo/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          retry
            ? { action: 'retry', projectId, requestId: id }
            : {
                action: 'revise',
                projectId,
                feedback: correction,
                requestId: id,
                uiLanguage,
              },
        ),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(
          payload.error ||
            (uiLanguage === 'en'
              ? 'Update could not be saved. Please try again.'
              : '修改还没有保存，请重试。'),
        );
      setResult(payload);
    } catch (err) {
      setRevisionError(
        err instanceof Error
          ? err.message
          : uiLanguage === 'en'
            ? 'Update could not be saved. Please try again.'
            : '修改还没有保存，请重试。',
      );
    } finally {
      revisionSubmitting.current = false;
      setBusy(false);
      // Also recover an accepted request whose HTTP response was interrupted.
      setRefreshKey((key) => key + 1);
    }
  };

  const create = async (retry = false) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setMatchedExisting(false);
    const key = JSON.stringify({
      kind,
      url: url.trim(),
      notes: notes.trim(),
    });
    if (!requestId.current || submittedInput.current !== key) {
      requestId.current = crypto.randomUUID();
      submittedInput.current = key;
    }
    try {
      const response = await fetch('/api/geo/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          retry
            ? { action: 'retry', projectId, uiLanguage }
            : {
                kind,
                targetLanguage: 'en',
                uiLanguage,
                url: url.trim(),
                notes: notes.trim(),
                requestId: requestId.current,
              },
        ),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(
          payload.error ||
            (uiLanguage === 'en'
              ? 'Could not create project. Please try again.'
              : '项目暂时未能创建，请重试。'),
        );
      setMatchedExisting(!retry && response.status === 200);
      setResult(payload);
      const lockedLang = resolveProjectUiLanguage({
        uiLanguage: payload.onboarding?.uiLanguage ?? payload.project?.uiLanguage,
        summaryOrDescription:
          payload.onboarding?.analysis?.summary || payload.project?.description,
      });
      syncedProjectLang.current = `${payload.project.id}:${lockedLang}`;
      setUiLanguage(lockedLang);
      setProjectId(payload.project.id);
      setHasProjects(true);
      window.history.replaceState(
        null,
        '',
        `/new?project=${encodeURIComponent(payload.project.id)}`,
      );
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : uiLanguage === 'en'
            ? 'Request failed. Please try again.'
            : '操作未完成，请重试。',
      );
    } finally {
      setBusy(false);
    }
  };

  const projectLink = (view: string) =>
    `/?view=${view}&project=${encodeURIComponent(projectId)}`;
  const stage = result ? (ready ? 2 : 1) : 0;

  return (
    <div className="og-onboarding">
      <header className="og-onboarding-topbar">
        <Link className="og-onboarding-brand" href="/">
          <OpenGeoBrandMark size={30} />OpenGEO
        </Link>
        <div className="og-onboarding-topbar-right">
          {hasProjects && (
            <Link
              className="og-onboarding-back"
              href={projectId ? projectLink('overview') : '/'}
            >
              <ArrowLeft size={15} />
              {t('onboarding.back')}
            </Link>
          )}
        </div>
      </header>
      <main className="og-onboarding-main">
        <ol className="og-onboarding-steps" aria-label={t('onboarding.step1')}>
          {[t('onboarding.step1'), t('onboarding.step2'), t('onboarding.step3')].map((label, index) => (
            <li
              key={label}
              className={
                index === stage ? 'current' : index < stage ? 'done' : ''
              }
              aria-current={index === stage ? 'step' : undefined}
            >
              <span>{index < stage ? <Check size={13} /> : index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        {loading ? (
          <div className="og-onboarding-loading" role="status">
            <Loader2 className="onboarding-spin" />
            {t('onboarding.loading')}
          </div>
        ) : !result && !projectId ? (
          <>
            <div className="og-onboarding-intro">
              <span className="og-onboarding-eyebrow">
                {t('onboarding.eyebrow')}
              </span>
              <h1>{t('onboarding.heading')}</h1>
              <p>{t('onboarding.subheading')}</p>
            </div>
            <form
              className="og-onboarding-form"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <section
                className="og-onboarding-lang-commitment"
                aria-label={t('onboarding.uiLangHeading')}
              >
                <div className="og-onboarding-lang-head">
                  <strong>{t('onboarding.uiLangHeading')}</strong>
                  <span className="og-onboarding-lock-pill">
                    <Lock size={12} aria-hidden="true" />
                    {t('onboarding.uiLangLockBadge')}
                  </span>
                </div>
                <p className="og-onboarding-lang-desc">
                  {t('onboarding.uiLangCommitmentDesc')}
                </p>
                <div
                  className="og-onboarding-lang-cards"
                  role="group"
                  aria-label={t('onboarding.uiLangHeading')}
                >
                  <button
                    type="button"
                    className={uiLanguage === 'en' ? 'selected' : ''}
                    aria-pressed={uiLanguage === 'en'}
                    disabled={busy}
                    onClick={() => setUiLanguage('en')}
                  >
                    <strong>{t('onboarding.uiLangEnTitle')}</strong>
                    <small>{t('onboarding.uiLangEnHint')}</small>
                    {uiLanguage === 'en' && (
                      <Check size={15} className="og-onboarding-selected" />
                    )}
                  </button>
                  <button
                    type="button"
                    className={uiLanguage === 'zh' ? 'selected' : ''}
                    aria-pressed={uiLanguage === 'zh'}
                    disabled={busy}
                    onClick={() => setUiLanguage('zh')}
                  >
                    <strong>{t('onboarding.uiLangZhTitle')}</strong>
                    <small>{t('onboarding.uiLangZhHint')}</small>
                    {uiLanguage === 'zh' && (
                      <Check size={15} className="og-onboarding-selected" />
                    )}
                  </button>
                </div>
              </section>
              <div
                className="og-onboarding-types og-onboarding-types-two"
                role="group"
                aria-label={t('onboarding.step1')}
              >
                {entryTypes.map(({ id, titleKey, hintKey, Icon }) => (
                  <button
                    className={kind === id ? 'selected' : ''}
                    type="button"
                    key={id}
                    aria-pressed={kind === id}
                    disabled={busy}
                    onClick={() => {
                      setKind(id);
                      setError('');
                    }}
                  >
                    <span className="og-onboarding-type-icon">
                      <Icon size={25} strokeWidth={1.6} />
                    </span>
                    <strong>{t(titleKey)}</strong>
                    <small>{t(hintKey)}</small>
                    {kind === id && (
                      <Check size={15} className="og-onboarding-selected" />
                    )}
                  </button>
                ))}
              </div>
              <label
                className="og-onboarding-field"
                htmlFor="project-entry-url"
              >
                {t(selection.labelKey)}
              </label>
              <div className="og-onboarding-url">
                <Globe2 size={19} aria-hidden="true" />
                <input
                  id="project-entry-url"
                  type="url"
                  required
                  maxLength={2048}
                  placeholder={t(selection.placeholderKey)}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  disabled={busy}
                  autoComplete="url"
                  aria-describedby={error ? 'onboarding-error' : undefined}
                />
              </div>
              <label
                className="og-onboarding-field"
                htmlFor="project-entry-notes"
              >
                {t('onboarding.notesLabel')}
                <span>{t('onboarding.optional')}</span>
              </label>
              <textarea
                id="project-entry-notes"
                rows={3}
                maxLength={4000}
                placeholder={t('onboarding.notesPlaceholder')}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                disabled={busy}
              />
              {error && (
                <p
                  className="og-onboarding-error"
                  id="onboarding-error"
                  role="alert"
                >
                  <CircleAlert size={16} />
                  {error}
                </p>
              )}
              <div className="og-onboarding-form-footer">
                <p>{t('onboarding.footerHint')}</p>
                <button
                  className="og-onboarding-primary"
                  type="submit"
                  disabled={busy}
                >
                  {busy ? (
                    <>
                      <Loader2 size={17} className="onboarding-spin" />
                      {t('onboarding.creatingBtn')}
                    </>
                  ) : (
                    <>
                      {t('onboarding.submitBtn')}
                      <ArrowRight size={17} />
                    </>
                  )}
                </button>
              </div>
            </form>
          </>
        ) : result ? (
          <>
            <div className="og-onboarding-intro">
              <span className="og-onboarding-eyebrow">
                {result.project.name}
              </span>
              <h1>
                {working
                  ? t('onboarding.stageWorkingTitle')
                  : ready
                    ? t('onboarding.stageReadyTitle')
                    : record?.status === 'failed'
                      ? t('onboarding.stageFailedTitle')
                      : t('onboarding.stageExistingTitle')}
              </h1>
              {matchedExisting && (
                <div className="og-onboarding-matched-badge" role="status">
                  <Check size={14} />
                  {t('onboarding.matchedExistingBadge')}
                </div>
              )}
            </div>
            {working && (
              <section
                className="og-onboarding-progress"
                role="status"
                aria-live="polite"
              >
                <div className="og-onboarding-progress-icon">
                  <BookOpen size={30} />
                  <span />
                </div>
                <h2>
                  {record?.status === 'analyzing'
                    ? t('onboarding.progressAnalyzingHeading')
                    : t('onboarding.progressReadingHeading')}
                </h2>
                {record?.message &&
                  !(
                    uiLanguage === 'en' &&
                    /[\p{Script=Han}]/u.test(record.message)
                  ) && <p>{record.message}</p>}
                <div className="og-onboarding-progress-stages">
                  <span className="done">
                    <Check size={14} />
                    {t('onboarding.progressSavedEntry')}
                  </span>
                  <span className="active">
                    <Loader2 size={14} className="onboarding-spin" />
                    {record?.status === 'analyzing'
                      ? t('onboarding.progressAiUnderstanding')
                      : t('onboarding.progressReadingDocs')}
                  </span>
                  <span>{t('onboarding.progressNextQuestions')}</span>
                </div>
                <small>{t('onboarding.progressAutoHint')}</small>
              </section>
            )}
            {ready && analysis && (
              <section className="og-onboarding-understanding">
                <div className="og-onboarding-summary">
                  <p>{analysis.summary}</p>
                </div>
                <div className="og-onboarding-audience">
                  <p>
                    <strong>{t('onboarding.audienceLabel')}</strong>
                    {analysis.audience}
                  </p>
                </div>
                {questionGeneration && (
                  <div className="og-onboarding-question-progress">
                    <BackgroundPreparationStatus job={questionGeneration} />
                  </div>
                )}
                <div className="og-onboarding-next">
                  <div className="og-onboarding-review-prompt">
                    <button type="button" onClick={() => setConfirmOpen(true)}>
                      <PencilLine size={18} aria-hidden="true" />
                      {t('onboarding.editUnderstandingBtn')}
                    </button>
                    <p>{t('onboarding.publicEvidenceNote')}</p>
                  </div>
                  <a
                    className="og-onboarding-primary"
                    href={projectLink('overview')}
                  >
                    {t('onboarding.goOverview')}
                    <ArrowRight size={17} />
                  </a>
                </div>
                <h2>{t('onboarding.capabilitiesHeading')}</h2>
                <ul className="og-onboarding-capabilities">
                  {analysis.capabilities.slice(0, 3).map((item, index) => (
                    <li key={index}>
                      <CapabilityText text={item} />
                    </li>
                  ))}
                </ul>
                {analysis.capabilities.length > 3 && (
                  <details>
                    <summary>
                      {t('onboarding.moreCapabilities', {
                        count: analysis.capabilities.length - 3,
                      })}
                    </summary>
                    <ul className="og-onboarding-capabilities">
                      {analysis.capabilities.slice(3).map((item, index) => (
                        <li key={index}>
                          <CapabilityText text={item} />
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </section>
            )}
            {record?.status === 'failed' && (
              <section className="og-onboarding-failed">
                <CircleAlert size={30} />
                <h2>
                  {uiLanguage === 'en' && /[\p{Script=Han}]/u.test(record.message)
                    ? t('onboarding.stageFailedTitle')
                    : record.message}
                </h2>
                {record.error && record.error !== record.message && (
                  <p>{record.error}</p>
                )}
                <div className="og-onboarding-failed-actions">
                  <button
                    className="og-onboarding-primary"
                    onClick={() => {
                      if (record.revision) {
                        revisionRequest.current = {
                          id: record.revision.id,
                          feedback: record.revision.feedback,
                        };
                        setFeedback(record.revision.feedback);
                        setPendingRevision(record.revision.id);
                        setConfirmOpen(true);
                      } else void create(true);
                    }}
                    disabled={busy}
                  >
                    {busy ? t('onboarding.retryingBtn') : t('onboarding.retryBtn')}
                  </button>
                  <a href={projectLink('settings')}>
                    {t('onboarding.checkSettingsLink')}
                    <ArrowRight size={15} />
                  </a>
                  <a className="og-onboarding-start-over" href="/new">
                    <ArrowLeft size={14} />
                    {t('onboarding.startOverLink')}
                  </a>
                </div>
                <p className="og-onboarding-note">
                  {record.revision
                    ? t('onboarding.failedRevisionNote')
                    : t('onboarding.failedInitialNote')}
                </p>
              </section>
            )}
            {!record && (
              <section className="og-onboarding-understanding">
                <p>{t('onboarding.existingReuseNote')}</p>
                <a
                  className="og-onboarding-primary"
                  href={projectLink('overview')}
                >
                  {t('onboarding.goOverview')}
                  <ArrowRight size={17} />
                </a>
              </section>
            )}
            <div className="og-onboarding-saved-entry">
              <Globe2 size={16} />
              <a
                href={
                  record?.url ||
                  result.project.repositoryUrl ||
                  result.project.siteUrl
                }
                target="_blank"
                rel="noreferrer"
              >
                {record?.url ||
                  result.project.repositoryUrl ||
                  result.project.siteUrl}
              </a>
              {ready && (
                <>
                  <span aria-hidden="true">·</span>
                  <a className="og-onboarding-start-over" href="/new">
                    <ArrowLeft size={13} />
                    {t('onboarding.startOverLink')}
                  </a>
                </>
              )}
            </div>
            {error && (
              <div className="og-onboarding-error" role="alert">
                {error}
                <button onClick={() => setRefreshKey((key) => key + 1)}>
                  {t('onboarding.reloadProgressBtn')}
                </button>
              </div>
            )}
          </>
        ) : (
          <section className="og-onboarding-failed">
            <p role="alert">{error || t('onboarding.loading')}</p>
            <button onClick={() => setRefreshKey((key) => key + 1)}>
              {t('onboarding.reloadProgressBtn')}
            </button>
            <a href="/new">
              <Plus size={16} />
              {t('onboarding.reAddEntryLink')}
            </a>
          </section>
        )}
      </main>
      <Dialog
        open={confirmOpen}
        onClose={() => {
          if (!revising) setConfirmOpen(false);
        }}
        className="og-onboarding-confirm"
      >
        <div className="og-onboarding-confirm-backdrop" aria-hidden="true" />
        <div className="og-onboarding-confirm-position">
          <DialogPanel className="og-onboarding-confirm-panel">
            <button
              className="og-onboarding-confirm-close"
              aria-label={t('onboarding.dialogCloseAria')}
              disabled={revising}
              onClick={() => setConfirmOpen(false)}
            >
              <X size={20} />
            </button>
            <DialogTitle>
              {revising
                ? t('onboarding.dialogTitleUpdating')
                : t('onboarding.dialogTitleEdit')}
            </DialogTitle>
            {revising ? (
              <div
                className="og-onboarding-revising"
                role="status"
                aria-live="polite"
              >
                <div className="og-onboarding-revising-icon">
                  <Loader2 size={28} className="onboarding-spin" />
                </div>
                <strong>{t('onboarding.dialogUpdatingStrong')}</strong>
                <p>{t('onboarding.dialogUpdatingHint')}</p>
              </div>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void continueToQuestions();
                }}
              >
                <p className="og-onboarding-confirm-hint">
                  {t('onboarding.dialogHint')}
                </p>
                <label htmlFor="onboarding-correction">
                  {t('onboarding.dialogFieldLabel')}
                </label>
                <textarea
                  id="onboarding-correction"
                  value={feedback}
                  onChange={(event) => setFeedback(event.target.value)}
                  maxLength={4000}
                  rows={4}
                  placeholder={t('onboarding.dialogPlaceholder')}
                />
                {(revisionError || revisionFailed) && (
                  <p className="og-onboarding-confirm-error" role="alert">
                    {revisionError || t('onboarding.dialogRevisionFailed')}
                  </p>
                )}
                <div className="og-onboarding-confirm-actions">
                  <button
                    type="button"
                    className="og-onboarding-confirm-cancel"
                    onClick={() => setConfirmOpen(false)}
                  >
                    {t('onboarding.dialogCancelBtn')}
                  </button>
                  <button
                    type="submit"
                    className="og-onboarding-primary"
                    disabled={!feedback.trim()}
                  >
                    {revisionFailed
                      ? t('onboarding.dialogRetrySubmitBtn')
                      : t('onboarding.dialogSubmitBtn')}
                    <ArrowRight size={17} />
                  </button>
                </div>
              </form>
            )}
            {error && (
              <div className="og-onboarding-confirm-error" role="alert">
                {error}
                <button onClick={() => setRefreshKey((key) => key + 1)}>
                  {t('onboarding.reloadProgressBtn')}
                </button>
              </div>
            )}
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  );
}

export default function ProjectOnboardingPage() {
  return (
    <UiLanguageProvider>
      <ProjectOnboardingPageInner />
    </UiLanguageProvider>
  );
}
