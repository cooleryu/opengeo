'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { readableDiff, readableText } from '@/lib/geo/optimization/word-diff';
import { DiffLines, useBoardText } from './action-board-shared';

export type DiffMode = 'changes' | 'after' | 'source';

/** An edit as prose: added words highlighted, removed words struck, long unchanged runs folded. */
export function EditDiffView({
  before,
  after,
  unifiedDiff,
  mode,
  lang,
}: {
  before: string;
  after: string;
  unifiedDiff?: string;
  mode: DiffMode;
  lang?: string;
}) {
  const { tk } = useBoardText();
  const segments = useMemo(() => readableDiff(before, after), [before, after]);
  const afterText = useMemo(() => readableText(after), [after]);
  if (mode === 'source' && unifiedDiff) return <DiffLines diff={unifiedDiff} lang={lang} />;
  if (mode === 'after') {
    return (
      <div className="ab-wd is-after" lang={lang}>
        {afterText.split('\n').map((paragraph, i) => (
          <p key={i}>{paragraph}</p>
        ))}
      </div>
    );
  }
  return (
    <p className="ab-wd" lang={lang}>
      {segments.map((segment, i) => {
        if (segment.op === 'fold') {
          return (
            <span key={i} className="ab-wd-fold" role="img" aria-label={tk('hero.unchanged')}>
              …
            </span>
          );
        }
        // A changed line break is layout, not wording: show it as plain space.
        if (!segment.text.trim()) return segment.op === 'del' ? ' ' : <span key={i}>{segment.text}</span>;
        if (segment.op === 'add') return <ins key={i}>{segment.text}</ins>;
        if (segment.op === 'del') return <del key={i}>{segment.text}</del>;
        return <span key={i}>{segment.text}</span>;
      })}
    </p>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <span className="ab-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className={option.value === value ? 'is-on' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}

/** Page-audit screenshots are captured at deviceScaleFactor 2 (page-audit.ts), so half the pixel width is actual size. */
const SHOT_DPR = 2;

/** The highlighted section at actual size (readable), scrollable sideways; "Fit width" shows all of it. */
export function ShotViewer({ src, alt, align = 'center' }: { src: string; alt: string; align?: 'center' | 'start' }) {
  const { tk } = useBoardText();
  const frame = useRef<HTMLDivElement>(null);
  const [actualWidth, setActualWidth] = useState<number | null>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  const [fit, setFit] = useState(false);
  const wider = actualWidth !== null && actualWidth > frameWidth + 1;

  useEffect(() => {
    const el = frame.current;
    if (!el || fit || actualWidth === null) return;
    el.scrollLeft = align === 'start' ? 0 : Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
  }, [actualWidth, align, fit, src]);

  return (
    <figure className="ab-shot">
      <div ref={frame} className={`ab-shot-frame ${fit ? 'is-fit' : ''}`} tabIndex={wider && !fit ? 0 : undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          data-shot-dpr={SHOT_DPR}
          style={!fit && actualWidth ? { width: actualWidth, maxWidth: 'none' } : undefined}
          onLoad={(e) => {
            setActualWidth(e.currentTarget.naturalWidth / SHOT_DPR);
            setFrameWidth(frame.current?.clientWidth ?? 0);
          }}
        />
      </div>
      {wider && (
        <button type="button" className="ab-text-btn ab-shot-toggle" onClick={() => setFit((v) => !v)}>
          {tk(fit ? 'fc.shotActual' : 'fc.shotFit')}
        </button>
      )}
    </figure>
  );
}
