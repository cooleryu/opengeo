'use client';

import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, Copy, ExternalLink } from 'lucide-react';
import { plural, type UiMessageKey } from '@/lib/geo/i18n';
import type { ActionBoardMessageKey } from '@/lib/geo/optimization/action-board-messages';
import {
  videoPlatformName,
  type ActionBoardCard,
  type ActionBoardCoverage,
  type ActionBoardRecord,
  type Label,
} from '@/lib/geo/optimization/action-board-catalog';
import type { PageAuditRecord } from '@/lib/geo/optimization/page-audit';
import ResearchEngineIcon from '../ResearchEngineIcon';
import { useUiLanguage } from '../UiLanguageContext';

type PluralBase<K extends string> = K extends `${infer B}.one` ? B : never;
export type BoardPluralKey = PluralBase<ActionBoardMessageKey>;

/** All board text goes through here: plain keys, English plurals, and {en, zh} labels. */
export function useBoardText() {
  const { t, uiLanguage } = useUiLanguage();
  const tk = (key: ActionBoardMessageKey, vars?: Record<string, string | number>) => t(key as UiMessageKey, vars);
  const tn = (base: BoardPluralKey, n: number, vars?: Record<string, string | number>) =>
    plural(uiLanguage, n, {
      one: tk(`${base}.one` as ActionBoardMessageKey, vars),
      other: tk(`${base}.other` as ActionBoardMessageKey, vars),
    });
  const pick = (label?: Label | null) => (label ? label[uiLanguage] || label.en : '');
  return { tk, tn, pick, uiLanguage };
}

export type BoardText = ReturnType<typeof useBoardText>;

export interface BoardActions {
  projectId: string;
  board: ActionBoardRecord;
  pageAudit: PageAuditRecord | null;
  busyCardId: string | null;
  onRedo: (cardId: string) => void;
  onMarkDone: (cardId: string, publishedUrl?: string) => Promise<void>;
  onSaveDoc: (cardId: string) => Promise<string | null>;
  onReadThreadBrowser: (cardId: string, threadUrl: string) => Promise<boolean>;
  onRedraftThreadText: (cardId: string, threadUrl: string, pastedText: string) => Promise<boolean>;
  onPageAuditChange: (audit: PageAuditRecord) => void;
  onRunAudit: (assetId?: string) => Promise<void>;
  auditRunning: boolean;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Card titles are computed from structured fields, never written by a model. */
export function cardTitle(card: ActionBoardCard, text: BoardText): string {
  const { tk, tn } = text;
  const pages = card.seeds.pages ?? [];
  const payload = card.payload;
  switch (card.kind) {
    case 'page_diff': {
      const n = payload?.kind === 'page_diff' ? payload.edits.length : (card.seeds.findingIds ?? []).length;
      return n > 0 ? tn('card.page_diff', n, { target: card.target.label }) : tk('card.page_diff.noAudit', { target: card.target.label });
    }
    case 'doc_draft':
      return tk('card.doc_draft');
    case 'community_reply':
      return tn('card.community_reply', payload?.kind === 'community_reply' ? payload.threads.length : Math.min(3, pages.length));
    case 'video_script':
      return tk('card.video_script', {
        platform: payload?.kind === 'video_script' ? payload.platform : videoPlatformName(card.target.label),
      });
    case 'form_pack':
      return tk('card.form_pack', { sites: [...new Set(pages.map((p) => hostOf(p.url)))].slice(0, 2).join(', ') });
    case 'pr_patch':
      return tk('card.pr_patch', { repo: pages[0]?.url.replace(/^https?:\/\/github\.com\//, '').split('/').slice(0, 2).join('/') ?? '' });
    case 'outreach_email': {
      const siteCount =
        payload?.kind === 'outreach_email'
          ? payload.targets.length
          : Math.min(4, new Set(pages.map((p) => hostOf(p.url)).filter(Boolean)).size || pages.length);
      return tn('card.outreach_email', siteCount);
    }
  }
}

const PAGE_DIFF_WHY = new Set(['homonym', 'brand_absent', 'page_gaps']);

/** Why this action matters: the line written with the draft, or a fixed line until it exists. */
export function cardWhy(card: ActionBoardCard, text: BoardText): string {
  if (card.why) return text.pick(card.why);
  if (card.kind !== 'page_diff') return text.tk(`why.${card.kind}`);
  return text.tk(`why.page_diff.${PAGE_DIFF_WHY.has(card.reason) ? card.reason : 'page_gaps'}` as ActionBoardMessageKey);
}

export function EvidenceChips({ card, text }: { card: ActionBoardCard; text: BoardText }) {
  const { evidence } = card;
  return (
    <span className="ab-evidence">
      {evidence.engines.map((engine) => (
        <span key={engine} className="ab-engine" aria-label={engine}>
          <ResearchEngineIcon engine={engine} />
        </span>
      ))}
      {evidence.questionCount > 0 && <span>{text.tn('ev.questions', evidence.questionCount)}</span>}
      {evidence.questionCount > 0 && evidence.citationCount > 0 && <span className="ab-ev-dot" aria-hidden="true">·</span>}
      {evidence.citationCount > 0 && <span>{text.tn('ev.citations', evidence.citationCount)}</span>}
    </span>
  );
}

/** Collapsible evidence trail inside modals so users can verify every number without cluttering screen 1. */
export function EvidenceDisclosure({
  card,
  coverage,
  text,
}: {
  card: ActionBoardCard;
  coverage: ActionBoardCoverage;
  text: BoardText;
}) {
  const { tk } = text;
  const questions = card.evidence.questions ?? [];
  const pages = card.seeds.pages ?? [];
  const homonymClues = card.kind === 'page_diff' && card.reason === 'homonym' ? (coverage.homonymClues ?? []) : [];
  const total = questions.length + pages.length + homonymClues.length;
  if (!total) return null;

  return (
    <details className="ab-ev-box">
      <summary>
        <ChevronDown size={14} className="ab-ev-caret" />
        <span>{tk('ev.viewSources', { n: total })}</span>
      </summary>
      <div className="ab-ev-panel">
        {homonymClues.length > 0 && (
          <div className="ab-ev-group">
            <span className="ab-field-label">{tk('ev.homonymTitle')}</span>
            <ul className="ab-ev-list">
              {homonymClues.map((clue, i) => (
                <li key={i}>{clue}</li>
              ))}
            </ul>
          </div>
        )}
        {questions.length > 0 && (
          <div className="ab-ev-group">
            <span className="ab-field-label">{tk('ev.questionsTitle')}</span>
            <ul className="ab-ev-list">
              {questions.map((q) => (
                <li key={q.id}>{q.query}</li>
              ))}
            </ul>
          </div>
        )}
        {pages.length > 0 && (
          <div className="ab-ev-group">
            <span className="ab-field-label">{tk('ev.pagesTitle')}</span>
            <div className="ab-ev-links">
              {pages.map((page) => (
                <a key={page.url} className="ab-link" href={page.url} target="_blank" rel="noreferrer">
                  <ExternalLink size={12} />
                  <span>{hostOf(page.url)}</span>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

export function CopyButton({
  value,
  label,
  className,
  iconOnly,
}: {
  value: string;
  label?: string;
  className?: string;
  iconOnly?: boolean;
}) {
  const text = useBoardText();
  const [copied, setCopied] = useState(false);
  const shown = copied ? text.tk('dlg.copied') : label ?? text.tk('dlg.copy');
  return (
    <button
      type="button"
      className={className ?? (iconOnly ? 'ab-icon-copy' : 'ost-btn-secondary is-sm')}
      aria-label={iconOnly ? shown : undefined}
      title={iconOnly ? shown : undefined}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        });
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {!iconOnly && <span>{shown}</span>}
    </button>
  );
}

export function PostedLink({ card, actions, text }: { card: ActionBoardCard; actions: BoardActions; text: BoardText }) {
  const [url, setUrl] = useState(card.publishedUrl ?? '');
  const valid = /^https?:\/\/\S+$/i.test(url.trim());
  return (
    <div className="ab-posted">
      <input
        className="ab-input"
        type="url"
        value={url}
        placeholder={text.tk('msg.posted')}
        aria-label={text.tk('msg.posted')}
        onChange={(e) => setUrl(e.target.value)}
      />
      <button type="button" className="ost-btn-secondary is-sm" disabled={!valid} onClick={() => void actions.onMarkDone(card.id, url.trim())}>
        {text.tk('msg.save')}
      </button>
    </div>
  );
}

/** The publishable zone: content stays in the target language, whatever the UI language is. */
export function PostZone({
  language,
  actions,
  children,
}: {
  language: 'en' | 'zh';
  actions?: ReactNode;
  children: ReactNode;
}) {
  const text = useBoardText();
  return (
    <section className="ab-post">
      <header className="ab-post-head">
        <span>{text.tk('dlg.postZone', { lang: text.tk(`dlg.lang.${language}`) })}</span>
        {actions && <span className="ab-post-actions">{actions}</span>}
      </header>
      <div className="ab-post-body" lang={language}>
        {children}
      </div>
    </section>
  );
}

export function diffLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'is-add';
  if (line.startsWith('-') && !line.startsWith('---')) return 'is-del';
  if (line.startsWith('@@')) return 'is-hunk';
  return '';
}

export function DiffLines({ diff, lang }: { diff: string; lang?: string }) {
  const lines = diff.split('\n').filter((line) => !line.startsWith('+++') && !line.startsWith('---'));
  return (
    <pre className="ab-diff" lang={lang}>
      {lines.map((line, i) => (
        <span key={i} className={`ab-diff-line ${diffLineClass(line)}`}>
          {line || ' '}
        </span>
      ))}
    </pre>
  );
}

/** Older audits saved a translated label in front of the heading; show only the document's own text. */
export function displayHeading(heading: string, fallback: string): string {
  const clean = heading.replace(/^(?:顶部介绍\s*·\s*|Opening\s*\/\s*)/, '').trim();
  return !clean || /^(?:顶部介绍区|页面首屏区|Hero)$/.test(clean) ? fallback : clean;
}

export function auditShotUrl(projectId: string, audit: PageAuditRecord, file?: string): string | null {
  if (!file) return null;
  return `/api/geo/project-media?project=${encodeURIComponent(projectId)}&auditShot=${encodeURIComponent(file)}&v=${encodeURIComponent(audit.updatedAt)}`;
}

export async function postJson<T>(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  return { ok: res.ok, status: res.status, data };
}
