'use client';

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  AppWindow,
  ArrowRight,
  Check,
  Code,
  FileText,
  GitPullRequest,
  Globe,
  Loader2,
  Mail,
  MessageSquare,
  PenLine,
  Play,
  Presentation,
  ScanSearch,
  Sparkles,
  SquareTerminal,
} from 'lucide-react';
import type {
  ActionBoardCard,
  ActionCardKind,
  CommunityThread,
  StoryboardScreen,
} from '@/lib/geo/optimization/action-board-catalog';
import type { PageAuditFinding, PageAuditRecord } from '@/lib/geo/optimization/page-audit';
import ResearchEngineIcon from '../ResearchEngineIcon';
import { EditDiffView, Segmented, type DiffMode } from './EditDiff';
import { cardTitle, cardWhy, displayHeading, EvidenceChips, hostOf, type BoardText } from './action-board-shared';

const KIND_ICON: Record<ActionCardKind, ReactNode> = {
  page_diff: <PenLine size={14} />,
  doc_draft: <FileText size={14} />,
  pr_patch: <GitPullRequest size={14} />,
  community_reply: <MessageSquare size={14} />,
  outreach_email: <Mail size={14} />,
  form_pack: <FileText size={14} />,
  video_script: <Play size={14} />,
};

function Kicker({ kind, text }: { kind: ActionCardKind; text: BoardText }) {
  return (
    <span className="ab-kicker">
      {KIND_ICON[kind]}
      <span>{text.tk(`kind.${kind}`)}</span>
    </span>
  );
}

/** Only states worth a glance: done, drafting, failed, or something to check before shipping. */
function StatusPill({ card, text }: { card: ActionBoardCard; text: BoardText }) {
  if (card.completedAt) {
    return (
      <span className="ab-status is-done">
        <Check size={12} />
        {text.tk('board.done')}
      </span>
    );
  }
  if (card.status === 'pending') {
    return (
      <span className="ab-status">
        <Loader2 size={12} className="ost-spin" />
        {text.tk('board.pending')}
      </span>
    );
  }
  if (card.status === 'failed') {
    return <span className="ab-status is-failed">{text.tk(card.failure === 'interrupted' ? 'board.interrupted' : 'board.failed')}</span>;
  }
  if (card.payload?.kind === 'doc_draft' && card.payload.claims.length) {
    return <span className="ab-status is-check">{text.tn('card.claims', card.payload.claims.length)}</span>;
  }
  return null;
}

function Shimmer({ lines = 3 }: { lines?: number }) {
  return (
    <span className="ab-shimmer" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} />
      ))}
    </span>
  );
}

/** Live findings for a page-edit card, in the card's order, read from page-audit.json. */
export function liveEdits(card: ActionBoardCard, audit: PageAuditRecord | null): PageAuditFinding[] {
  if (!audit) return [];
  const ids = card.payload?.kind === 'page_diff' ? card.payload.edits.map((e) => e.findingId) : card.seeds.findingIds ?? [];
  const byId = new Map(audit.findings.map((f) => [f.id, f]));
  return ids.map((id) => byId.get(id)).filter((f): f is PageAuditFinding => Boolean(f && f.status !== 'dismissed'));
}

/** The first section of a page is its opening; others go by their own heading. */
export function editPlace(finding: PageAuditFinding, text: BoardText): string {
  return finding.sectionId === 'S0' ? text.tk('hero.opening') : displayHeading(finding.sectionHeading, finding.sectionId);
}

export function editTitle(card: ActionBoardCard, finding: PageAuditFinding, text: BoardText): string {
  const label = card.payload?.kind === 'page_diff' ? card.payload.edits.find((e) => e.findingId === finding.id)?.title : undefined;
  return text.pick(label) || text.tk(`fc.cat.${finding.category}`);
}

export function HeroEditCard({
  card,
  audit,
  text,
  onOpen,
}: {
  card: ActionBoardCard;
  audit: PageAuditRecord | null;
  text: BoardText;
  onOpen: (findingId?: string) => void;
}) {
  const { tk } = text;
  const edits = liveEdits(card, audit);
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<DiffMode>('changes');
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = edits[Math.min(active, edits.length - 1)];

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = edits.length - 1;
    const moves: Record<string, number> = {
      ArrowRight: active >= last ? 0 : active + 1,
      ArrowLeft: active <= 0 ? last : active - 1,
      Home: 0,
      End: last,
    };
    if (!(e.key in moves)) return;
    e.preventDefault();
    setActive(moves[e.key]);
    tabs.current[moves[e.key]]?.focus();
  };

  return (
    <article className={`ab-hero ${card.completedAt ? 'is-done' : ''}`} aria-labelledby={`${card.id}-title`}>
      <div className="ab-hero-main">
        <div className="ab-card-top">
          <Kicker kind={card.kind} text={text} />
          <StatusPill card={card} text={text} />
        </div>
        <h2 id={`${card.id}-title`} className="ab-hero-title">
          {cardTitle(card, text)}
        </h2>
        <p className="ab-card-why">{cardWhy(card, text)}</p>
        <div className="ab-hero-foot">
          <EvidenceChips card={card} text={text} />
          <button type="button" className="ab-cta" onClick={() => onOpen(current?.id)}>
            {tk(edits.length ? 'board.reviewPush' : 'fc.runAudit')}
            <ArrowRight size={15} />
          </button>
        </div>
      </div>

      <div className="ab-hero-preview">
        {!edits.length ? (
          <div className="ab-hero-empty">
            <ScanSearch size={22} />
            <span>{tk('fc.noAuditBody')}</span>
          </div>
        ) : (
          <>
            <div className="ab-switch-bar">
              <div className="ab-pills" role="tablist" aria-label={tk('fc.edits')} onKeyDown={onKey}>
                {edits.map((finding, i) => (
                  <button
                    key={finding.id}
                    ref={(el) => {
                      tabs.current[i] = el;
                    }}
                    type="button"
                    role="tab"
                    id={`${card.id}-tab-${i}`}
                    aria-selected={i === active}
                    aria-controls={`${card.id}-panel-${i}`}
                    tabIndex={i === active ? 0 : -1}
                    className={`ab-pill ${i === active ? 'is-active' : ''}`}
                    onClick={() => setActive(i)}
                  >
                    <span className={`ab-pill-dot ${finding.patchPreview ? 'is-ready' : ''}`} aria-hidden="true" />
                    {editPlace(finding, text)}
                  </button>
                ))}
              </div>
              <Segmented
                value={mode}
                onChange={setMode}
                label={tk('hero.view')}
                options={[
                  { value: 'changes', label: tk('hero.changes') },
                  { value: 'after', label: tk('hero.after') },
                ]}
              />
            </div>
            <div className="ab-stage">
              {edits.map((finding, i) => (
                <div
                  key={finding.id}
                  role="tabpanel"
                  id={`${card.id}-panel-${i}`}
                  aria-labelledby={`${card.id}-tab-${i}`}
                  aria-hidden={i !== active}
                  className={`ab-panel ${i === active ? 'is-active' : ''}`}
                >
                  <p className="ab-panel-title">{editTitle(card, finding, text)}</p>
                  {finding.patchPreview ? (
                    <div className="ab-panel-body" tabIndex={i === active ? 0 : -1}>
                      <EditDiffView
                        before={finding.patchPreview.beforeExcerpt}
                        after={finding.patchPreview.afterExcerpt}
                        mode={mode}
                        lang={audit?.targetLanguage}
                      />
                    </div>
                  ) : (
                    <div className="ab-panel-body is-empty">
                      {card.status === 'pending' ? (
                        <Shimmer />
                      ) : (
                        <>
                          <span>{tk('hero.notDrafted')}</span>
                          <button type="button" className="ost-btn-secondary is-sm" onClick={() => onOpen(finding.id)}>
                            <Sparkles size={14} />
                            <span>{tk('fc.writeEdit')}</span>
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </article>
  );
}

// --- Follow-up card previews: one fixed box, one idea each ---

function Mono({ name, tone }: { name: string; tone?: 'own' | 'you' }) {
  return (
    <span className={`ab-mono ${tone ? `is-${tone}` : ''}`} aria-hidden="true">
      {name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

function Versus({ products }: { products: string[] }) {
  const [own, ...others] = products;
  return (
    <span className="ab-vs">
      <span className="ab-vs-own">
        <Mono name={own ?? ''} tone="own" />
        <span className="ab-vs-name">{own}</span>
      </span>
      <span className="ab-vs-mid">vs</span>
      <span className="ab-vs-others">
        {others.slice(0, 3).map((name) => (
          <span key={name} className="ab-vs-chip">
            <Mono name={name} />
            <span className="ab-vs-name">{name}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

export const SCREEN_ICON: Record<StoryboardScreen, ReactNode> = {
  product: <AppWindow size={18} />,
  browser: <Globe size={18} />,
  chatgpt: <ResearchEngineIcon engine="chatgpt" />,
  google: <ResearchEngineIcon engine="google" />,
  terminal: <SquareTerminal size={18} />,
  code: <Code size={18} />,
  slide: <Presentation size={18} />,
};

function Frames({ beats, meta }: { beats: Array<{ t: string; screen?: StoryboardScreen }>; meta?: string }) {
  const shown = beats.slice(0, 5);
  return (
    <span className="ab-frames">
      <span className="ab-frames-row" style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}>
        {shown.map((beat, i) => (
          <span key={i} className="ab-frame">
            <span className={`ab-frame-screen ${beat.screen ? '' : 'is-empty'}`}>{beat.screen ? SCREEN_ICON[beat.screen] : null}</span>
            <span className="ab-frame-t">{beat.t}</span>
          </span>
        ))}
      </span>
      {meta && <span className="ab-frames-meta">{meta}</span>}
    </span>
  );
}

/** Search titles carry the community and site name; the card already shows both. */
export function cleanThreadTitle(title: string, community: string): string {
  let clean = title.trim();
  if (community && clean.toLowerCase().startsWith(`${community.toLowerCase()}:`)) clean = clean.slice(community.length + 1).trim();
  return clean.replace(/\s*[-–—|:]\s*(?:reddit|quora)(?:\.com)?\s*$/i, '').replace(/\s*:\s*r\/\w+\s*$/i, '').trim();
}

function ThreadMini({
  where,
  title,
  more,
  thread,
  text,
  lang,
}: {
  where: string;
  title: string;
  more: number;
  thread?: CommunityThread;
  text: BoardText;
  lang: 'en' | 'zh';
}) {
  const { tk } = text;
  const titleOnly = thread && thread.source.status !== 'fetched';
  return (
    <span className="ab-tm">
      <span className="ab-tm-head">
        <Mono name={/reddit/i.test(thread?.platform ?? where) ? 'r' : where} />
        <span className="ab-tm-where">{where}</span>
        {more > 0 && <span className="ab-tm-more">+{more}</span>}
        {titleOnly && (
          <span className="ab-chip" title={tk('msg.titleOnly', { reason: tk(`msg.reason.${thread.source.reason ?? 'error'}`) })}>
            {tk('card.titleOnly')}
          </span>
        )}
      </span>
      <span className="ab-tm-title" lang={lang} data-clamp="">
        {cleanThreadTitle(title, where)}
      </span>
      <span className="ab-tm-reply">
        <Mono name={tk('card.you')} tone="you" />
        {thread ? (
          <span className="ab-tm-body" lang={lang} data-clamp="">
            {thread.body}
          </span>
        ) : (
          <Shimmer lines={2} />
        )}
      </span>
    </span>
  );
}

function CardPreview({ card, text, lang, brand }: { card: ActionBoardCard; text: BoardText; lang: 'en' | 'zh'; brand: string }) {
  const { tk, tn } = text;
  const payload = card.payload;
  const pages = card.seeds.pages ?? [];
  switch (card.kind) {
    case 'doc_draft':
      return <Versus products={payload?.kind === 'doc_draft' ? payload.table.products : [brand, ...(card.seeds.competitors ?? [])]} />;
    case 'video_script':
      return payload?.kind === 'video_script' ? (
        <Frames beats={payload.beats} meta={`${payload.duration} · ${tn('vid.shots', payload.beats.length)}`} />
      ) : (
        <Frames beats={['0:00', '0:30', '1:00', '1:30'].map((t) => ({ t }))} />
      );
    case 'community_reply': {
      const thread = payload?.kind === 'community_reply' ? payload.threads[0] : undefined;
      const count = payload?.kind === 'community_reply' ? payload.threads.length : Math.min(3, pages.length);
      const where = thread?.community || hostOf(pages[0]?.url ?? '');
      return <ThreadMini where={where} title={thread?.title ?? pages[0]?.title ?? ''} more={count - 1} thread={thread} text={text} lang={lang} />;
    }
    case 'form_pack':
      return payload?.kind === 'form_pack' ? (
        <span className="ab-mini-form" lang={lang}>
          {payload.fields
            .filter((f) => ['name', 'tagline'].includes(f.key))
            .map((f) => (
              <span key={f.key} className="ab-mini-field">
                <span>{tk(`form.field.${f.key}`)}</span>
                <span data-clamp="">{f.value}</span>
              </span>
            ))}
        </span>
      ) : (
        <Shimmer />
      );
    case 'pr_patch':
      return payload?.kind === 'pr_patch' ? (
        <span className="ab-code-line" lang={lang} data-clamp="">
          + {payload.targets[0]?.entryLine}
        </span>
      ) : (
        <Shimmer />
      );
    case 'outreach_email':
      return payload?.kind === 'outreach_email' ? (
        <span className="ab-mail-line" lang="en">
          <span>{payload.targets[0]?.siteName}</span>
          <strong data-clamp="">{payload.targets[0]?.subject}</strong>
        </span>
      ) : (
        <Shimmer />
      );
    default:
      return <Shimmer />;
  }
}

export function FollowCard({
  card,
  text,
  lang,
  brand,
  onOpen,
}: {
  card: ActionBoardCard;
  text: BoardText;
  lang: 'en' | 'zh';
  brand: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={`ab-card ${card.completedAt ? 'is-done' : ''}`}
      aria-label={`${cardTitle(card, text)}. ${cardWhy(card, text)}`}
      onClick={onOpen}
    >
      <span className="ab-card-top">
        <Kicker kind={card.kind} text={text} />
        <StatusPill card={card} text={text} />
      </span>
      <span className="ab-card-title">{cardTitle(card, text)}</span>
      <span className="ab-card-why">{cardWhy(card, text)}</span>
      <span className="ab-preview">
        <CardPreview card={card} text={text} lang={lang} brand={brand} />
      </span>
      <span className="ab-card-foot">
        <EvidenceChips card={card} text={text} />
        <ArrowRight size={15} className="ab-arrow" />
      </span>
    </button>
  );
}

export function SecondaryRow({ card, text, onOpen }: { card: ActionBoardCard; text: BoardText; onOpen: () => void }) {
  return (
    <button type="button" className={`ab-row ${card.completedAt ? 'is-done' : ''}`} onClick={onOpen}>
      <Kicker kind={card.kind} text={text} />
      <span className="ab-row-title">{cardTitle(card, text)}</span>
      <EvidenceChips card={card} text={text} />
      <StatusPill card={card} text={text} />
      <ArrowRight size={15} className="ab-arrow" />
    </button>
  );
}
