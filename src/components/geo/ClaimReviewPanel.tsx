'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Plus } from 'lucide-react';
import type { ClaimReviewRecord } from '@/lib/geo/types';
import type {
  ResearchObservation,
  ResearchQuestion,
} from '@/lib/geo/research-types';
import { inferContentLang } from '@/lib/geo/i18n';
import { contentWebUrl } from './ContentEvidence';
import GeoSelect from './GeoSelect';
import { useUiLanguage } from './UiLanguageContext';
import './claim-review.css';

export type ClaimReviewInput = Pick<
  ClaimReviewRecord,
  | 'projectId'
  | 'batchId'
  | 'questionId'
  | 'observationIndex'
  | 'language'
  | 'engine'
  | 'quote'
  | 'fact'
  | 'evidenceUrl'
  | 'conclusion'
  | 'scope'
>;

const conclusions = {
  supported: { en: 'Supported', zh: '有依据支持' },
  contradicted: { en: 'Contradicted', zh: '与依据不符' },
  uncertain: { en: 'Uncertain', zh: '尚不能确认' },
} as const;

export default function ClaimReviewPanel({
  projectId,
  batchId,
  question,
  observationIndex,
  observation,
  records,
  onSave,
}: {
  projectId: string;
  batchId: string;
  question: ResearchQuestion;
  observationIndex: number;
  observation: ResearchObservation;
  records: ClaimReviewRecord[];
  onSave: (payload: ClaimReviewInput) => Promise<void>;
}) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const langKey = isEn ? 'en' : 'zh';
  const locale = isEn ? 'en-US' : 'zh-CN';
  const selectPortal = useRef<HTMLDetailsElement>(null);
  const reviews = records.filter(
    (entry) =>
      entry.projectId === projectId &&
      entry.batchId === batchId &&
      entry.questionId === question.id &&
      entry.observationIndex === observationIndex &&
      entry.language === observation.language &&
      entry.engine === observation.engine,
  );
  const [editing, setEditing] = useState(false);
  const [quote, setQuote] = useState('');
  const [fact, setFact] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [conclusion, setConclusion] =
    useState<ClaimReviewRecord['conclusion']>('uncertain');
  const [scope, setScope] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setEditing(false);
    setQuote('');
    setFact('');
    setEvidenceUrl('');
    setScope('');
    setConclusion('uncertain');
    setError('');
    setSaved(false);
  }, [
    projectId,
    batchId,
    question.id,
    observationIndex,
    observation.language,
    observation.engine,
  ]);

  return (
    <details className="cr-review" ref={selectPortal}>
      <summary>
        <span>{isEn ? 'Claim check' : '说法核查'}</span>
        <small>
          {isEn ? 'Manual check · ' : '人工核查 · '}
          {reviews.length
            ? isEn
              ? `${reviews.length} logged`
              : `${reviews.length} 条`
            : isEn
              ? 'None yet'
              : '尚无记录'}
        </small>
      </summary>
      <div className="cr-body">
        {reviews.length > 0 && (
          <div className="cr-records">
            {reviews.map((review) => (
              <article key={review.id}>
                <header>
                  <span className={'cr-conclusion ' + review.conclusion}>
                    {conclusions[review.conclusion][langKey]}
                  </span>
                  <time>
                    {new Date(review.reviewedAt).toLocaleDateString(locale, {
                      timeZone: 'UTC',
                    })}
                  </time>
                </header>
                <blockquote lang={inferContentLang(review.quote)}>
                  {review.quote}
                </blockquote>
                <details className="cr-record-evidence">
                  <summary>{isEn ? 'Facts & evidence' : '事实与依据'}</summary>
                  <dl>
                    <div>
                      <dt>{isEn ? 'Product fact' : '项目事实'}</dt>
                      <dd lang={inferContentLang(review.fact)}>
                        {review.fact}
                      </dd>
                    </div>
                    <div>
                      <dt>{isEn ? 'Scope & limits' : '适用边界'}</dt>
                      <dd lang={inferContentLang(review.scope)}>
                        {review.scope}
                      </dd>
                    </div>
                  </dl>
                  {contentWebUrl(review.evidenceUrl) && (
                    <a
                      href={contentWebUrl(review.evidenceUrl)!}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {isEn ? 'Source link' : '核查依据'}
                      <ArrowUpRight size={12} />
                      <span data-i18n-skip="">
                        {new URL(review.evidenceUrl).hostname}
                      </span>
                    </a>
                  )}
                </details>
              </article>
            ))}
          </div>
        )}
        {!editing && (
          <button
            className="cr-add"
            onClick={() => {
              setEditing(true);
              setSaved(false);
            }}
          >
            <Plus size={14} />
            {isEn ? 'Log manual check' : '登记人工核查'}
          </button>
        )}
        {saved && (
          <p className="cr-saved" role="status">
            <Check size={13} />
            {isEn ? 'Review saved' : '核查记录已保存'}
          </p>
        )}
        {editing && (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (!quote.trim() || !fact.trim() || !scope.trim()) {
                setError(
                  isEn
                    ? 'Fill in the quote, product fact, and scope.'
                    : '请补全原话、项目事实和适用边界。',
                );
                return;
              }
              if (!contentWebUrl(evidenceUrl.trim())) {
                setError(
                  isEn
                    ? 'Enter a valid http or https evidence URL.'
                    : '请填写可打开的 http 或 https 核查依据链接。',
                );
                return;
              }
              setBusy(true);
              setError('');
              setSaved(false);
              try {
                await onSave({
                  projectId,
                  batchId,
                  questionId: question.id,
                  observationIndex,
                  language: observation.language,
                  engine: observation.engine,
                  quote: quote.trim(),
                  fact: fact.trim(),
                  evidenceUrl: evidenceUrl.trim(),
                  conclusion,
                  scope: scope.trim(),
                });
                setQuote('');
                setFact('');
                setEvidenceUrl('');
                setConclusion('uncertain');
                setScope('');
                setEditing(false);
                setSaved(true);
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : isEn
                      ? 'Could not save review. Please try again.'
                      : '核查记录未保存，请重试。',
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              {isEn ? 'Answer quote' : '回答原话'}
              <textarea
                aria-label={isEn ? 'Answer quote to verify' : '核查的回答原话'}
                rows={2}
                required
                placeholder={
                  isEn
                    ? 'Copy the exact sentence from the opened answer'
                    : '从已打开的回答原文中摘录完整语句'
                }
                value={quote}
                onChange={(event) => setQuote(event.target.value)}
              />
            </label>
            <label>
              {isEn ? 'Product fact' : '项目事实'}
              <textarea
                aria-label={isEn ? 'Verified product fact' : '核查的项目事实'}
                rows={2}
                required
                placeholder={
                  isEn
                    ? 'What does your supporting evidence confirm?'
                    : '依据材料能够确认什么'
                }
                value={fact}
                onChange={(event) => setFact(event.target.value)}
              />
            </label>
            <label>
              {isEn ? 'Evidence link' : '核查依据'}
              <input
                aria-label={isEn ? 'Evidence URL' : '核查依据链接'}
                type="url"
                required
                placeholder="https://…"
                value={evidenceUrl}
                onChange={(event) => setEvidenceUrl(event.target.value)}
              />
            </label>
            <div className="cr-form-row">
              <label>
                {isEn ? 'Verdict' : '人工判断'}
                <GeoSelect
                  label={isEn ? 'Manual check verdict' : '人工核查判断'}
                  value={conclusion}
                  onChange={setConclusion}
                  portalTarget={selectPortal}
                  options={[
                    { value: 'uncertain', label: conclusions.uncertain[langKey] },
                    { value: 'supported', label: conclusions.supported[langKey] },
                    {
                      value: 'contradicted',
                      label: conclusions.contradicted[langKey],
                    },
                  ]}
                />
              </label>
            </div>
            <label>
              {isEn ? 'Scope & limits' : '适用边界'}
              <textarea
                aria-label={isEn ? 'Verification scope' : '核查适用边界'}
                rows={2}
                required
                placeholder={
                  isEn
                    ? 'Version, date, conditions, or open items'
                    : '版本、时间、适用条件或仍待核实之处'
                }
                value={scope}
                onChange={(event) => setScope(event.target.value)}
              />
            </label>
            <div className="cr-form-actions">
              <button type="submit" disabled={busy}>
                {busy
                  ? isEn
                    ? 'Saving…'
                    : '保存中…'
                  : isEn
                    ? 'Save review'
                    : '保存人工核查'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                {isEn ? 'Cancel' : '取消'}
              </button>
            </div>
            {error && (
              <p className="cr-error" role="alert">
                {error}
              </p>
            )}
          </form>
        )}
      </div>
    </details>
  );
}
