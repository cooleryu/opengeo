'use client';

import { useState } from 'react';
import Markdown from 'markdown-to-jsx';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ExternalLink,
  FilePlus2,
  Loader2,
  Sparkles,
} from 'lucide-react';
import type { ActionBoardCard, DocDraftPayload, PrPatchPayload } from '@/lib/geo/optimization/action-board-catalog';
import {
  ACTION_BOARD_MESSAGES_EN,
  ACTION_BOARD_MESSAGES_ZH,
  type ActionBoardMessageKey,
} from '@/lib/geo/optimization/action-board-messages';
import { ShotViewer } from './EditDiff';
import { CopyButton, hostOf, PostZone, type BoardActions, type BoardText } from './action-board-shared';

const MD_OPTIONS = { disableParsingRawHTML: true, forceBlock: true } as const;

function docText(key: ActionBoardMessageKey, lang: 'en' | 'zh'): string {
  return (lang === 'zh' ? ACTION_BOARD_MESSAGES_ZH : ACTION_BOARD_MESSAGES_EN)[key];
}

function hostAndPath(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    if (!path || path === '/') return host;
    const shortPath = path.length > 26 ? `${path.slice(0, 25)}…` : path;
    return `${host}${shortPath}`;
  } catch {
    return hostOf(url);
  }
}

export function FileChangeDoc({
  card,
  payload,
  actions,
  text,
}: {
  card: ActionBoardCard;
  payload: DocDraftPayload;
  actions: BoardActions;
  text: BoardText;
}) {
  const { tk, tn } = text;
  const lang = actions.board.targetLanguage;
  const [tab, setTab] = useState<'preview' | 'markdown'>('preview');
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [checkedClaims, setCheckedClaims] = useState<Set<number>>(new Set());
  const products = payload.table.products;
  const ownName = products[0] ?? '';

  const save = async () => {
    setSaving(true);
    const written = await actions.onSaveDoc(card.id);
    setSaving(false);
    if (written) setSavedPath(written);
  };

  const toggleClaim = (index: number) => {
    setCheckedClaims((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className="ab-doc">
      <div className="ab-fc-bar">
        <FilePlus2 size={14} />
        <span className="ab-file-path">{payload.path ?? tk('doc.copyOnly')}</span>
        <span className="ab-fc-count">{tn('doc.words', payload.wordCount)}</span>
        <span className="ab-tabs" role="tablist">
          {(['preview', 'markdown'] as const).map((key) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'is-active' : ''} onClick={() => setTab(key)}>
              {tk(`doc.${key}`)}
            </button>
          ))}
        </span>
      </div>

      <div className="ab-doc-grid">
        <PostZone language={lang}>
          {tab === 'markdown' ? (
            <pre className="ab-md-source">{payload.markdown}</pre>
          ) : (
            <article className="ab-doc-article">
              {/* Visual Hero + TL;DR Callout */}
              <header className="ab-doc-hero">
                <span className="ab-doc-eyebrow">
                  <Sparkles size={12} />
                  {docText('doc.heroEyebrow', lang)}
                </span>
                <h1>{payload.title}</h1>
                <p className="ab-tldr">
                  <strong>TL;DR</strong> {payload.tldr}
                </p>
              </header>

              {/* Two-Column Executive Verdict */}
              {payload.verdict && (
                <section className="ab-doc-verdict" aria-label={docText('doc.verdictTitle', lang)}>
                  <div className="ab-verdict-card is-own">
                    <span className="ab-verdict-badge">{ownName}</span>
                    <h3>{payload.verdict.ownHeadline}</h3>
                    <ul>
                      {payload.verdict.ownPoints.map((point, i) => (
                        <li key={i}>
                          <Check size={13} />
                          <span>{point}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="ab-verdict-card">
                    <span className="ab-verdict-badge">{products.slice(1).join(' · ')}</span>
                    <h3>{payload.verdict.saasHeadline}</h3>
                    <ul>
                      {payload.verdict.saasPoints.map((point, i) => (
                        <li key={i}>
                          <ArrowRight size={13} />
                          <span>{point}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </section>
              )}

              {/* Rich Comparison Table */}
              <div className="ab-table-wrap">
                <table className="ab-compare">
                  <thead>
                    <tr>
                      <th />
                      {products.map((p, i) => (
                        <th key={p} className={i === 0 ? 'is-own' : ''}>
                          <span className="ab-th-brand">
                            <span className={`ab-mono ${i === 0 ? 'is-own' : ''}`} aria-hidden="true">
                              {p.trim().slice(0, 1).toUpperCase()}
                            </span>
                            <span>{p}</span>
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {payload.table.rows.map((row) => (
                      <tr key={row.dimension}>
                        <th scope="row">{row.dimension}</th>
                        {row.cells.map((cell, i) => {
                          const muted = /^not (?:publicly )?(?:stated|listed)/i.test(cell.trim());
                          return (
                            <td key={i} className={`${i === 0 ? 'is-own' : ''} ${muted ? 'is-muted' : ''}`}>
                              {cell}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Real Product Interface Showcase */}
              {payload.screenshotUrl && (
                <section className="ab-doc-showcase">
                  <div className="ab-showcase-bar">
                    <span className="ab-showcase-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                    <span className="ab-showcase-label">
                      {ownName} · {docText('doc.productView', lang)}
                    </span>
                  </div>
                  <ShotViewer src={payload.screenshotUrl} alt={`${ownName} interface`} align="start" />
                </section>
              )}

              {/* Who Should Pick Which? Decision Grid */}
              {payload.bestFor && payload.bestFor.length > 0 && (
                <section className="ab-doc-block">
                  <h2>{docText('doc.picksTitle', lang)}</h2>
                  <div className="ab-picks-grid">
                    {payload.bestFor.map((pick, i) => {
                      const isOwn = i === 0 || pick.product.toLowerCase() === ownName.toLowerCase();
                      return (
                        <div key={pick.product} className={`ab-pick-card ${isOwn ? 'is-own' : ''}`}>
                          <div className="ab-pick-head">
                            <span className={`ab-mono ${isOwn ? 'is-own' : ''}`} aria-hidden="true">
                              {pick.product.trim().slice(0, 1).toUpperCase()}
                            </span>
                            <strong>{pick.product}</strong>
                            <span className="ab-pick-badge">{pick.badge}</span>
                          </div>
                          <p className="ab-pick-row">
                            <span>{docText('doc.bestFor', lang)}</span>
                            {pick.idealFor}
                          </p>
                          <p className="ab-pick-row is-trade">
                            <span>{docText('doc.tradeOff', lang)}</span>
                            {pick.tradeOff}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Visual Workflow Contrast */}
              {payload.workflow && (
                <section className="ab-doc-block">
                  <h2>{docText('doc.workflowTitle', lang)}</h2>
                  <div className="ab-flow-pair">
                    <div className="ab-flow-lane">
                      <span className="ab-flow-title">{payload.workflow.traditionalTitle}</span>
                      <ol className="ab-flow-steps">
                        {payload.workflow.traditionalSteps.map((step, i) => (
                          <li key={i}>
                            <span className="ab-flow-num">{i + 1}</span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                    <div className="ab-flow-lane is-own">
                      <span className="ab-flow-title">{payload.workflow.ownTitle}</span>
                      <ol className="ab-flow-steps">
                        {payload.workflow.ownSteps.map((step, i) => (
                          <li key={i}>
                            <span className="ab-flow-num">{i + 1}</span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  </div>
                </section>
              )}

              {/* Buyer Q&A Sections */}
              {payload.sections.map((section) => (
                <section key={section.heading} className="ab-doc-section">
                  <h2>{section.heading}</h2>
                  <Markdown options={MD_OPTIONS}>{section.body}</Markdown>
                </section>
              ))}
            </article>
          )}
        </PostZone>

        <aside className="ab-rail">
          <h3>{tk('doc.contents')}</h3>
          <ol className="ab-toc" lang={lang}>
            <li>{docText('doc.comparison', lang)}</li>
            {payload.bestFor?.length ? <li>{docText('doc.picksTitle', lang)}</li> : null}
            {payload.workflow ? <li>{docText('doc.workflowTitle', lang)}</li> : null}
            {payload.sections.map((s) => (
              <li key={s.heading}>{s.heading}</li>
            ))}
          </ol>
          <div className="ab-rail-divider" />
          <div className="ab-rail-head">
            <h3>{tk('doc.check')}</h3>
            {payload.claims.length > 0 && (
              <span className="ab-rail-count">
                {tk('doc.verifiedCount', { n: checkedClaims.size, total: payload.claims.length })}
              </span>
            )}
          </div>
          {payload.claims.length ? (
            <ul className="ab-claims">
              {payload.claims.map((claim, i) => (
                <li key={i} className={checkedClaims.has(i) ? 'is-checked' : ''}>
                  <label className="ab-claim-check">
                    <input
                      type="checkbox"
                      checked={checkedClaims.has(i)}
                      onChange={() => toggleClaim(i)}
                    />
                    <span className="ab-claim-copy">
                      <span className="ab-claim-about">{claim.about}</span>
                      <span lang={lang}>{claim.text}</span>
                    </span>
                  </label>
                  {claim.sourceUrl ? (
                    <a className="ab-link" href={claim.sourceUrl} target="_blank" rel="noreferrer">
                      <ExternalLink size={12} />
                      {hostAndPath(claim.sourceUrl)}
                    </a>
                  ) : (
                    <span className="ab-claim-warn">
                      <AlertTriangle size={12} />
                      {tk('doc.noSource')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </aside>
      </div>

      <footer className="ab-fc-foot">
        {payload.canSaveToRepo && !savedPath && !card.completedAt ? (
          <button type="button" className="ost-btn-primary is-sm" disabled={saving} onClick={() => void save()}>
            {saving ? <Loader2 size={14} className="ost-spin" /> : <FilePlus2 size={14} />}
            <span>{tk(saving ? 'doc.saving' : 'doc.save')}</span>
          </button>
        ) : savedPath ? (
          <span className="ab-ok">{tk('doc.saved', { path: savedPath })}</span>
        ) : null}
        <CopyButton value={payload.markdown} label={tk('doc.copyMarkdown')} />
      </footer>
    </div>
  );
}

export function FileChangePr({ payload, actions, text }: { payload: PrPatchPayload; actions: BoardActions; text: BoardText }) {
  const { tk } = text;
  const lang = actions.board.targetLanguage;
  return (
    <div className="ab-pr">
      {payload.targets.map((target) => (
        <section key={target.repoUrl} className="ab-pr-target">
          <div className="ab-fc-bar">
            <span className="ab-file-path">
              {target.repoSlug}
              {target.section ? ` · ${target.section}` : ''}
            </span>
            <a className="ab-link" href={target.repoUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={13} />
              {tk('pr.openRepo')}
            </a>
          </div>
          <PostZone language={lang}>
            <div className="ab-field-block">
              <span className="ab-field-label">{tk('pr.entry')}</span>
              <pre className="ab-diff">
                <span className="ab-diff-line is-add">+ {target.entryLine}</span>
              </pre>
              <CopyButton value={target.entryLine} />
            </div>
            <div className="ab-field-block">
              <span className="ab-field-label">{tk('pr.title')}</span>
              <p>{target.prTitle}</p>
              <CopyButton value={target.prTitle} />
            </div>
            <div className="ab-field-block">
              <span className="ab-field-label">{tk('pr.body')}</span>
              <p className="ab-pre">{target.prBody}</p>
              <CopyButton value={target.prBody} />
            </div>
          </PostZone>
        </section>
      ))}
    </div>
  );
}
