'use client';

/**
 * Symmetric Segmented Donut Ring Gauge for KPI cards.
 * Uses the exact same denominator as the adjacent fraction so visual and numbers never conflict.
 */
export function DonutRing({
  yes,
  unknown,
  total,
  centerText,
}: {
  yes: number;
  unknown: number;
  total: number;
  centerText: string;
}) {
  const size = 68;
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const safeTotal = Math.max(1, total);
  const yesLen = total > 0 ? (yes / safeTotal) * c : 0;
  const unknownLen = total > 0 ? (unknown / safeTotal) * c : 0;

  return (
    <span className="pov-donut" aria-hidden="true">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#eef0f3"
          strokeWidth={stroke}
        />
        {unknownLen > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="#fcd34d"
            strokeWidth={stroke}
            strokeDasharray={`${unknownLen} ${c}`}
            strokeDashoffset={-yesLen}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
        {yesLen > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="#16a34a"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${yesLen} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <span className="pov-donut-label">{centerText}</span>
    </span>
  );
}

export function AnswerPips({
  yes,
  no,
  unknown,
}: {
  yes: number;
  no: number;
  unknown: number;
}) {
  const total = yes + no + unknown;
  if (total <= 0 || total > 24) return null;
  const items: ('yes' | 'no' | 'unknown')[] = [
    ...Array<'yes'>(yes).fill('yes'),
    ...Array<'no'>(no).fill('no'),
    ...Array<'unknown'>(unknown).fill('unknown'),
  ];
  return (
    <span className="pov-pips" aria-hidden="true">
      {items.map((kind, idx) => (
        <i key={idx} className={`is-${kind}`} />
      ))}
    </span>
  );
}
