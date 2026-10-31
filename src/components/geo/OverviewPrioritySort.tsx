'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { animate, AnimatePresence, motion, useMotionValue, useReducedMotion } from 'motion/react';
import { GripVertical } from 'lucide-react';
import type { ResearchQuestion } from '@/lib/geo/research-types';

const settle = { type: 'spring' as const, visualDuration: 0.25, bounce: 0.06 };
const follow = { duration: 0.07, ease: [0.18, 0.67, 0.28, 1] as [number, number, number, number] };
type Session = {
  id: string;
  items: ResearchQuestion[];
  startIndex: number;
  gap: number;
  rect: DOMRect;
  listHeight: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  hintY: number;
  inside: boolean;
  phase: 'pending' | 'dragging' | 'settling';
  keyboard: boolean;
};
type Props = {
  items: ResearchQuestion[];
  disabled: boolean;
  onReorder: (ids: string[]) => void;
  renderItem: (question: ResearchQuestion, index: number, handle: ReactNode) => ReactNode;
};

/** Display-only sorting. The underlying questions and observations stay untouched. */
export default function OverviewPrioritySort({ items, disabled, onReorder, renderItem }: Props) {
  const list = useRef<HTMLDivElement>(null);
  const session = useRef<Session | null>(null);
  const cleanup = useRef<() => void>(() => {});
  const [drag, setDrag] = useState<Session | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const reduced = useReducedMotion();
  const transition = reduced ? { duration: 0 } : settle;

  useEffect(() => () => { cleanup.current(); session.current = null; x.stop(); y.stop(); }, [x, y]);

  function rowElements() {
    return Array.from(list.current?.querySelectorAll<HTMLElement>(':scope > [data-sort-id]') ?? []);
  }

  function updateGap(s: Session, keyboardGap?: number) {
    const container = list.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const rows = rowElements();
    s.inside = s.keyboard || (s.x >= bounds.left && s.x <= bounds.right && s.y >= bounds.top && s.y <= bounds.bottom);
    // offsetTop excludes Motion's transient transforms, so the hit area cannot oscillate.
    s.gap = keyboardGap ?? rows.filter(row => bounds.top + row.offsetTop + row.offsetHeight / 2 < s.y).length;
    const before = rows[s.gap - 1];
    const after = rows[s.gap];
    s.hintY = before && after
      ? (before.offsetTop + before.offsetHeight + after.offsetTop) / 2
      : after ? after.offsetTop : before ? before.offsetTop + before.offsetHeight + 5 : 0;
    setDrag({ ...s });
  }

  function begin(s: Session) {
    s.phase = 'dragging';
    document.body.style.setProperty('cursor', 'grabbing');
    document.body.style.setProperty('user-select', 'none');
    x.set(s.rect.left);
    y.set(s.rect.top);
    setDrag({ ...s });
    setAnnouncement('已拿起。上下方向键调整，回车放下，Escape 取消。');
    requestAnimationFrame(() => {
      if (session.current === s && s.phase === 'dragging') {
        updateGap(s, s.keyboard ? s.gap : undefined);
        followPointer(s);
      }
    });
  }

  function followPointer(s: Session) {
    const aside = Math.min(72, s.rect.width * 0.12);
    const tx = s.rect.left + s.x - s.startX + aside;
    const ty = s.rect.top + s.y - s.startY;
    if (reduced) { x.set(tx); y.set(ty); }
    else { void animate(x, tx, follow); void animate(y, ty, follow); }
  }

  function finish(cancel: boolean) {
    const s = session.current;
    if (!s || s.phase === 'settling') return;
    cleanup.current();
    if (s.phase === 'pending') { session.current = null; return; }
    const commit = !cancel && s.inside && s.gap !== s.startIndex;
    const next = [...s.items];
    if (commit) {
      const [picked] = next.splice(s.startIndex, 1);
      next.splice(s.gap, 0, picked);
      onReorder(next.map(item => item.id));
    }
    s.items = next;
    s.phase = 'settling';
    setDrag({ ...s });
    setAnnouncement(commit ? `已移至第 ${s.gap + 1} 位。` : '顺序未改变。');
    requestAnimationFrame(() => {
      if (session.current !== s) return;
      const destination = rowElements().find(row => row.dataset.sortId === s.id)?.getBoundingClientRect();
      const end = () => {
        if (session.current !== s) return;
        session.current = null;
        setDrag(null);
        requestAnimationFrame(() => rowElements().find(row => row.dataset.sortId === s.id)?.querySelector<HTMLButtonElement>('.pov-priority-handle')?.focus({ preventScroll: true }));
      };
      if (!destination || reduced) { end(); return; }
      void Promise.all([
        animate(x, destination.left, settle),
        animate(y, destination.top, settle),
      ]).then(end);
    });
  }

  function prepare(id: string, clientX: number, clientY: number, keyboard: boolean) {
    if (disabled || items.length < 2 || session.current || !list.current) return;
    const row = rowElements().find(el => el.dataset.sortId === id);
    if (!row) return;
    const s: Session = {
      id, items: [...items], startIndex: items.findIndex(item => item.id === id),
      gap: items.findIndex(item => item.id === id), rect: row.getBoundingClientRect(),
      listHeight: list.current.offsetHeight, startX: clientX, startY: clientY,
      x: clientX, y: clientY, hintY: 0, inside: true, phase: 'pending', keyboard,
    };
    session.current = s;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    let frame = 0;
    const move = (event: PointerEvent) => {
      if (s.keyboard || s.phase === 'settling') return;
      s.x = event.clientX; s.y = event.clientY;
      if (s.phase === 'pending' && Math.hypot(s.x - s.startX, s.y - s.startY) > 4) { begin(s); return; }
      if (s.phase === 'dragging') { event.preventDefault(); followPointer(s); updateGap(s); }
    };
    const up = () => finish(false);
    const cancel = () => finish(true);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); finish(true); }
      if (!s.keyboard || s.phase !== 'dragging') return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); finish(false); }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        updateGap(s, Math.max(0, Math.min(s.items.length - 1, s.gap + (event.key === 'ArrowUp' ? -1 : 1))));
        const top = list.current?.getBoundingClientRect().top ?? s.rect.top;
        void animate(y, top + s.hintY - 12, reduced ? { duration: 0 } : follow);
      }
    };
    const scroll = () => {
      if (s.phase === 'dragging' && !s.keyboard && list.current) {
        const bounds = list.current.getBoundingClientRect();
        if (s.x >= bounds.left && s.x <= bounds.right) {
          const delta = s.y < 54 ? -Math.min(12, (54 - s.y) / 3) : s.y > innerHeight - 54 ? Math.min(12, (s.y - innerHeight + 54) / 3) : 0;
          if (delta) { window.scrollBy(0, delta); updateGap(s); }
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', cancel);
    cleanup.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', cancel);
      cancelAnimationFrame(frame);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
    };
    frame = requestAnimationFrame(scroll);
    if (keyboard) begin(s);
  }

  const visible = drag ? drag.items.filter(item => drag.phase === 'settling' || item.id !== drag.id) : items;
  const picked = drag?.items.find(item => item.id === drag.id);
  const hint = drag?.phase === 'dragging' && drag.inside && drag.gap !== drag.startIndex;
  return <>
    <div id="pov-priority-list" ref={list} className={`pov-priority-list${drag ? ' is-sorting' : ''}`}
      style={{ minHeight: drag?.listHeight }}>
      {visible.map((question, index) => {
        const distance = drag ? (index < drag.gap ? drag.gap - index - 1 : index - drag.gap) : 0;
        const ripple = hint && !reduced ? (index < drag.gap ? -1 : 1) * 8 * 0.7 ** distance : 0;
        const handle = <button type="button" className="pov-priority-number pov-priority-handle"
          disabled={disabled || items.length < 2} aria-label={`调整顺序：${question.zh}`}
          title="拖动排序；空格拿起，方向键移动，回车放下" aria-keyshortcuts="Space ArrowUp ArrowDown Enter Escape"
          onPointerDown={event => {
            if (event.button !== 0 || !event.isPrimary) return;
            event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
            prepare(question.id, event.clientX, event.clientY, false);
          }}
          onKeyDown={event => {
            if ((event.key === ' ' || event.key === 'Enter') && !session.current) {
              event.preventDefault(); event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              prepare(question.id, rect.left, rect.top, true);
            }
          }}><GripVertical size={16} aria-hidden="true" /></button>;
        return <motion.div key={question.id} data-sort-id={question.id} className="pov-sort-row"
          layout="position" transition={transition} style={{ visibility: drag?.id === question.id ? 'hidden' : undefined }}>
          <motion.div animate={{ y: ripple }} transition={{ ...transition, delay: ripple ? distance * 0.024 : 0 }}>
            {renderItem(question, index, handle)}
          </motion.div>
        </motion.div>;
      })}
      <AnimatePresence>
        {hint && <motion.div className="pov-sort-hint" key="gap" aria-hidden="true"
          initial={{ opacity: 0, y: drag.hintY }} animate={{ opacity: 1, y: drag.hintY }} exit={{ opacity: 0 }}
          transition={transition}>
          <motion.div initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={reduced ? { duration: 0 } : { duration: 0.13, ease: [0.2, 0.8, 0.2, 1] }} />
        </motion.div>}
      </AnimatePresence>
    </div>
    {drag && picked && <motion.div className="pov-priority-lift" aria-hidden="true" ref={el => { if (el) el.inert = true; }}
      style={{ x, y, width: drag.rect.width }} initial={{ scale: 1 }}
      animate={{ scale: drag.phase === 'settling' ? 1 : 0.9, boxShadow: drag.phase === 'settling' ? '0 0 0 #23374b00' : '0 16px 40px #23374b26' }}
      transition={reduced ? { duration: 0 } : drag.phase === 'settling' ? settle : { type: 'spring', visualDuration: 0.18, bounce: 0.18 }}>
      {renderItem(picked, drag.items.findIndex(item => item.id === picked.id), <span className="pov-priority-number"><GripVertical size={16} /></span>)}
    </motion.div>}
    <span className="pov-sort-announcement" role="status" aria-live="polite">{announcement}</span>
  </>;
}
