'use client';

import { Check } from 'lucide-react';
import type { GeoAsset, GeoTask } from '@/lib/geo/types';
import './implementation-record.css';

export default function ImplementationRecordForm({
  task,
  assets,
  kind,
  revision,
  url,
  note,
  occurredAt,
  onKind,
  onUrl,
  onNote,
  onOccurredAt,
}: {
  task?: GeoTask;
  assets: GeoAsset[];
  kind: 'rehearsal' | 'user_confirmed';
  revision?: number;
  url: string;
  note: string;
  occurredAt: string;
  onKind: (kind: 'rehearsal' | 'user_confirmed') => void;
  onUrl: (url: string) => void;
  onNote: (note: string) => void;
  onOccurredAt: (occurredAt: string) => void;
}) {
  const proposal = task?.proposal;
  const target = assets.find((item) => item.id === proposal?.targetAssetId);
  const supplementDate =
    task?.implementation?.kind === 'user_confirmed' &&
    !task.implementation.occurredAt;
  return (
    <div className="og-modal-body og-implementation-form">
      <section className="ir-target">
        <span>{revision !== undefined ? `方案 v${revision}` : '实施登记'}</span>
        <h3>{target?.title || proposal?.title || task?.title}</h3>
        {proposal && (
          <details>
            <summary>查看审核稿</summary>
            <div className="ir-candidate">
              <p>{proposal.after}</p>
            </div>
          </details>
        )}
      </section>
      {!supplementDate && (
        <div className="ir-mode" role="group" aria-label="实施方式">
          <button
            type="button"
            aria-pressed={kind === 'user_confirmed'}
            onClick={() => onKind('user_confirmed')}
          >
            <span className="ir-check">
              {kind === 'user_confirmed' && <Check size={14} />}
            </span>
            实际实施
          </button>
          <button
            type="button"
            aria-pressed={kind === 'rehearsal'}
            onClick={() => onKind('rehearsal')}
          >
            <span className="ir-check">
              {kind === 'rehearsal' && <Check size={14} />}
            </span>
            本地演练
          </button>
        </div>
      )}
      {kind === 'user_confirmed' && (
        <>
          <label
            className="og-field-label"
            htmlFor="implementation-occurred-at"
          >
            实际实施时间<span>必填 · 当前设备时区</span>
          </label>
          <input
            id="implementation-occurred-at"
            className="og-input"
            type="datetime-local"
            value={occurredAt}
            onChange={(event) => onOccurredAt(event.target.value)}
            required
            aria-describedby="implementation-date-help"
          />
          <p className="ir-date-help" id="implementation-date-help">
            {supplementDate
              ? '补充原记录实际发生的时间；原登记时间保留。'
              : '填写实际生效时间；登记时间另存。'}
          </p>
        </>
      )}
      <label className="og-field-label" htmlFor="implementation-url">
        {kind === 'rehearsal' ? '目标页面' : '已修改的页面'}
      </label>
      <input
        id="implementation-url"
        className="og-input"
        type="url"
        value={url}
        readOnly={supplementDate}
        onChange={(event) => onUrl(event.target.value)}
        placeholder="https://…"
      />
      <label className="og-field-label" htmlFor="implementation-note">
        实际改动{kind === 'user_confirmed' && <span>必填</span>}
      </label>
      <textarea
        id="implementation-note"
        className="og-input og-note-input"
        value={note}
        readOnly={supplementDate}
        onChange={(event) => onNote(event.target.value)}
        placeholder={
          kind === 'rehearsal'
            ? '演练记录（选填）'
            : '改了哪一段；与审核稿有差异也请记录。'
        }
      />
      <p className="ir-boundary">
        {kind === 'rehearsal'
          ? '演练保留在历史中，不计入真实效果。'
          : '仅登记你已完成的修改；不会替你发布。'}
      </p>
    </div>
  );
}
