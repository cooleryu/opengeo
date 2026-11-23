'use client';

import { useEffect, useRef } from 'react';
import { Check, Loader2, RefreshCw, X } from 'lucide-react';
import { KIND_INTERFACE, type ActionBoardCard } from '@/lib/geo/optimization/action-board-catalog';
import { FileChangeDoc, FileChangePr } from './FileChangeDoc';
import { FileChangeEdits } from './FileChangeEdits';
import { FormPack, Storyboard } from './FormStoryboard';
import { EmailComposer, ReplyComposer } from './MessageInterface';
import { cardTitle, cardWhy, EvidenceChips, EvidenceDisclosure, type BoardActions, type BoardText } from './action-board-shared';

/** Model-drafted kinds can be redrafted; page edits redraft per edit. */
const REDRAFTABLE = new Set(['doc_draft', 'community_reply', 'video_script', 'form_pack', 'pr_patch', 'outreach_email']);

function Body({
  card,
  actions,
  text,
  initialFindingId,
}: {
  card: ActionBoardCard;
  actions: BoardActions;
  text: BoardText;
  initialFindingId?: string;
}) {
  if (card.kind === 'page_diff') return <FileChangeEdits card={card} actions={actions} text={text} initialFindingId={initialFindingId} />;
  const payload = card.payload;
  if (!payload) {
    return (
      <div className="ab-empty-pane">
        {card.status === 'pending' ? <Loader2 size={24} className="ost-spin" /> : null}
        <strong>{text.tk(card.status === 'pending' ? 'dlg.pendingTitle' : 'dlg.failedTitle')}</strong>
        {card.status === 'failed' && (
          <p>{text.tk(card.failure === 'interrupted' ? 'board.interrupted' : 'board.failed')}</p>
        )}
      </div>
    );
  }
  switch (payload.kind) {
    case 'doc_draft':
      return <FileChangeDoc card={card} payload={payload} actions={actions} text={text} />;
    case 'pr_patch':
      return <FileChangePr payload={payload} actions={actions} text={text} />;
    case 'community_reply':
      return <ReplyComposer card={card} payload={payload} actions={actions} text={text} />;
    case 'outreach_email':
      return <EmailComposer card={card} payload={payload} actions={actions} text={text} />;
    case 'form_pack':
      return <FormPack card={card} payload={payload} actions={actions} text={text} />;
    case 'video_script':
      return <Storyboard card={card} payload={payload} actions={actions} text={text} />;
    default:
      return null;
  }
}

export function ActionBoardDialog({
  card,
  actions,
  text,
  initialFindingId,
  onClose,
}: {
  card: ActionBoardCard;
  actions: BoardActions;
  text: BoardText;
  initialFindingId?: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  const busy = actions.busyCardId === card.id || card.status === 'pending';
  const canRedo = REDRAFTABLE.has(card.kind) && card.status !== 'pending';

  return (
    <dialog
      ref={ref}
      className={`oap-clean-modal ab-modal is-${KIND_INTERFACE[card.kind]}`}
      aria-labelledby="ab-modal-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header className="oap-modal-head ab-modal-head">
        <div className="oap-modal-head-copy">
          <span className="ab-kicker">{text.tk(`kind.${card.kind}`)}</span>
          <h2 id="ab-modal-title">{cardTitle(card, text)}</h2>
          <p className="ab-modal-sub">
            <span>{cardWhy(card, text)}</span>
            <EvidenceChips card={card} text={text} />
          </p>
        </div>
        <div className="oap-modal-head-actions">
          {canRedo && (
            <button type="button" className="ost-btn-secondary is-sm" disabled={busy} onClick={() => actions.onRedo(card.id)}>
              {busy ? <Loader2 size={14} className="ost-spin" /> : <RefreshCw size={14} />}
              <span>{text.tk(busy ? 'dlg.redoing' : 'dlg.redo')}</span>
            </button>
          )}
          {card.status === 'ready' && (
            <button
              type="button"
              className={card.completedAt ? 'ost-btn-secondary is-sm is-done' : 'ost-btn-secondary is-sm'}
              disabled={Boolean(card.completedAt)}
              onClick={() => void actions.onMarkDone(card.id)}
            >
              <Check size={14} />
              <span>{text.tk(card.completedAt ? 'board.done' : 'board.markDone')}</span>
            </button>
          )}
          <button type="button" className="oap-modal-close-btn" onClick={onClose} aria-label={text.tk('dlg.close')}>
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="oap-modal-body ab-modal-body">
        <EvidenceDisclosure card={card} coverage={actions.board.coverage} text={text} />
        <Body card={card} actions={actions} text={text} initialFindingId={initialFindingId} />
      </div>
    </dialog>
  );
}
