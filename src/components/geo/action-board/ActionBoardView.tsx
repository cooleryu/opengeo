'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { isCurrentActionBoard, type ActionBoardRecord } from '@/lib/geo/optimization/action-board-catalog';
import type { PageAuditRecord } from '@/lib/geo/optimization/page-audit';
import ResearchEngineIcon from '../ResearchEngineIcon';
import { ActionBoardDialog } from './ActionBoardDialog';
import { FollowCard, HeroEditCard, SecondaryRow } from './ActionBoardCards';
import { cardTitle, postJson, useBoardText, type BoardActions } from './action-board-shared';
import './action-board.css';

const POLL_MS = 1500;

interface BoardResponse {
  actionBoard?: ActionBoardRecord | null;
  stale?: boolean;
  generating?: boolean;
  pageAudit?: PageAuditRecord | null;
  writtenPath?: string;
  fetched?: boolean;
}

export interface ActionBoardViewProps {
  projectId: string;
  board: ActionBoardRecord | null;
  pageAudit: PageAuditRecord | null;
  onBoardChange: (nextBoard: ActionBoardRecord | null) => void;
  onPageAuditChange: (nextAudit: PageAuditRecord) => void;
  onError?: (msg: string) => void;
  onNotice?: (msg: string) => void;
}

export function ActionBoardView({
  projectId,
  board: initialBoard,
  pageAudit,
  onBoardChange,
  onPageAuditChange,
  onError,
  onNotice,
}: ActionBoardViewProps) {
  const text = useBoardText();
  const { tk } = text;
  const [board, setBoard] = useState<ActionBoardRecord | null>(isCurrentActionBoard(initialBoard) ? initialBoard : null);
  const [stale, setStale] = useState(Boolean(initialBoard) && !isCurrentActionBoard(initialBoard));
  const [generating, setGenerating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const [auditRunning, setAuditRunning] = useState(false);
  const [opened, setOpened] = useState<{ cardId: string; findingId?: string } | null>(null);
  const callbacks = useRef({ onBoardChange, onPageAuditChange });
  useEffect(() => {
    callbacks.current = { onBoardChange, onPageAuditChange };
  });

  const apply = useCallback((data: BoardResponse) => {
    if (data.actionBoard !== undefined) {
      setBoard(data.actionBoard ?? null);
      callbacks.current.onBoardChange(data.actionBoard ?? null);
    }
    if (data.stale !== undefined) setStale(data.stale);
    if (data.generating !== undefined) setGenerating(data.generating);
    if (data.pageAudit) callbacks.current.onPageAuditChange(data.pageAudit);
  }, []);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/geo/action-board?project=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
    if (res.ok) apply((await res.json()) as BoardResponse);
  }, [apply, projectId]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const pending = generating || Boolean(board?.cards.some((c) => c.status === 'pending'));
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => void refresh().catch(() => undefined), POLL_MS);
    return () => window.clearInterval(timer);
  }, [pending, refresh]);

  const post = async (body: Record<string, unknown>) => {
    const { ok, status, data } = await postJson<BoardResponse>('/api/geo/action-board', {
      projectId,
      uiLanguage: text.uiLanguage,
      ...body,
    });
    if (status === 409 && data.error === 'action_board_busy') {
      setGenerating(true);
      return null;
    }
    if (!ok) throw new Error(data.error || tk('board.errAction'));
    apply(data);
    return data;
  };

  const report = (error: unknown, fallback: 'board.errAction' | 'board.errGenerate' = 'board.errAction') =>
    onError?.(error instanceof Error && error.message ? error.message : tk(fallback));

  const generate = async () => {
    setStarting(true);
    onError?.('');
    try {
      await post({ action: 'generate' });
    } catch (error) {
      report(error, 'board.errGenerate');
    } finally {
      setStarting(false);
    }
  };

  const actions: BoardActions | null = board
    ? {
        projectId,
        board,
        pageAudit,
        busyCardId,
        auditRunning,
        onRedo: (cardId) => {
          setBusyCardId(cardId);
          void post({ action: 'regenerate_card', cardId })
            .catch((error) => report(error))
            .finally(() => setBusyCardId(null));
        },
        onMarkDone: async (cardId, publishedUrl) => {
          try {
            await post({ action: 'mark_done', cardId, ...(publishedUrl ? { publishedUrl } : {}) });
          } catch (error) {
            report(error);
          }
        },
        onSaveDoc: async (cardId) => {
          try {
            const data = await post({ action: 'save_doc', cardId });
            return data?.writtenPath ?? null;
          } catch (error) {
            const code = error instanceof Error ? error.message : '';
            onError?.(code === 'repo_not_owned' ? tk('doc.notOwned') : code === 'doc_exists' ? tk('doc.exists') : tk('board.errAction'));
            return null;
          }
        },
        onReadThreadBrowser: async (cardId, threadUrl) => {
          try {
            const data = await post({ action: 'read_thread_browser', cardId, threadUrl });
            if (data?.fetched === false) onError?.(tk('msg.chromeBlocked'));
            return Boolean(data?.fetched);
          } catch (error) {
            report(error);
            return false;
          }
        },
        onRedraftThreadText: async (cardId, threadUrl, pastedText) => {
          try {
            await post({ action: 'redraft_thread_text', cardId, threadUrl, pastedText });
            return true;
          } catch (error) {
            report(error);
            return false;
          }
        },
        onPageAuditChange: (audit) => callbacks.current.onPageAuditChange(audit),
        onRunAudit: async (assetId) => {
          setAuditRunning(true);
          try {
            const { ok, data } = await postJson<{ pageAudit?: PageAuditRecord }>('/api/geo/optimization', {
              projectId,
              uiLanguage: text.uiLanguage,
              action: 'audit_page',
              ...(assetId ? { assetId } : {}),
            });
            if (!ok || !data.pageAudit) throw new Error(data.error || tk('board.errAction'));
            callbacks.current.onPageAuditChange(data.pageAudit);
            await post({ action: 'generate' });
          } catch (error) {
            report(error);
          } finally {
            setAuditRunning(false);
          }
        },
        onError: (message) => onError?.(message),
        onNotice: (message) => onNotice?.(message),
      }
    : null;

  if (!board || !actions) {
    return (
      <div className="ab-root">
        <section className="ab-empty">
          <Sparkles size={22} />
          <h2>{tk(stale ? 'board.staleTitle' : 'board.emptyTitle')}</h2>
          <p>{tk(stale ? 'board.staleBody' : 'board.emptyBody')}</p>
          <button type="button" className="ost-btn-primary" disabled={starting || generating} onClick={() => void generate()}>
            {starting || generating ? <Loader2 size={15} className="ost-spin" /> : <Sparkles size={15} />}
            <span>{tk(starting || generating ? 'board.preparing' : stale ? 'board.refresh' : 'board.generate')}</span>
          </button>
        </section>
      </div>
    );
  }

  const ordered = [...board.cards].sort((a, b) => a.rank - b.rank);
  const primary = ordered.filter((c) => c.placement === 'primary');
  const featured = primary[0]?.kind === 'page_diff' ? primary[0] : null;
  const grid = primary.filter((c) => c !== featured);
  const secondary = ordered.filter((c) => c.placement === 'secondary');
  const activeCard = board.cards.find((c) => c.id === opened?.cardId) ?? null;
  const next = [...primary, ...secondary].find((c) => !c.completedAt);
  const takeaway = next
    ? tk('board.next', { target: next.kind === 'page_diff' ? next.target.label : cardTitle(next, text) })
    : tk('board.allDone');

  return (
    <div className="ab-root">
      <div className="ab-head">
        <div className="ab-score">
          <span className="ab-score-num">
            <strong>{board.coverage.mentions}</strong>
            <span>/{board.coverage.answers}</span>
          </span>
          <span className="ab-score-copy">
            <span className="ab-score-label">
              {tk('board.score', { brand: board.brandName })}
              {board.coverage.engines.map((engine) => (
                <span key={engine} className="ab-engine" aria-label={engine}>
                  <ResearchEngineIcon engine={engine} />
                </span>
              ))}
            </span>
            <span className="ab-takeaway">{takeaway}</span>
          </span>
        </div>
        <button type="button" className="ost-btn-secondary is-sm" disabled={pending || starting} onClick={() => void generate()}>
          {pending || starting ? <Loader2 size={14} className="ost-spin" /> : <RefreshCw size={14} />}
          <span>{tk(pending || starting ? 'board.refreshing' : 'board.refresh')}</span>
        </button>
      </div>

      {featured && (
        <HeroEditCard card={featured} audit={pageAudit} text={text} onOpen={(findingId) => setOpened({ cardId: featured.id, findingId })} />
      )}

      {grid.length > 0 && (
        <div className={`ab-grid is-${Math.min(grid.length, 3)}`}>
          {grid.map((card) => (
            <FollowCard
              key={card.id}
              card={card}
              text={text}
              lang={board.targetLanguage}
              brand={board.brandName}
              onOpen={() => setOpened({ cardId: card.id })}
            />
          ))}
        </div>
      )}

      {secondary.length > 0 && (
        <section className="ab-also">
          <h3>{tk('board.also')}</h3>
          {secondary.map((card) => (
            <SecondaryRow key={card.id} card={card} text={text} onOpen={() => setOpened({ cardId: card.id })} />
          ))}
        </section>
      )}

      {activeCard && (
        <ActionBoardDialog
          card={activeCard}
          actions={actions}
          text={text}
          initialFindingId={opened?.findingId}
          onClose={() => setOpened(null)}
        />
      )}
    </div>
  );
}
