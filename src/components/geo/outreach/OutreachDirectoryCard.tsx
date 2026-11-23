'use client';

import { useState, type ReactNode } from 'react';
import { Check, Copy, ExternalLink, Globe } from 'lucide-react';
import { describeExternalListingCopy } from '@/lib/geo/outreach/external-page-meta';
import type { OutreachActionRecord } from '@/lib/geo/outreach/outreach-store';
import { useUiLanguage } from '../UiLanguageContext';

export interface OutreachDirectoryCardProps {
  item: OutreachActionRecord;
  isTopPriority: boolean;
  isEn: boolean;
  busyId: string | null;
  pitchText: string;
  onChangePitch: (next: string) => void;
  isMarkingListing: boolean;
  sentUrlInput: string;
  onChangeSentUrl: (next: string) => void;
  onStartMark: () => void;
  onCancelMark: () => void;
  onConfirmMark: (cleanUrl: string) => Promise<void>;
  onSkip: () => Promise<void>;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  renderEvidenceBox: (item: OutreachActionRecord, explanation?: string) => ReactNode;
}

export function OutreachDirectoryCard({
  item,
  isTopPriority,
  isEn,
  busyId,
  pitchText,
  onChangePitch,
  isMarkingListing,
  sentUrlInput,
  onChangeSentUrl,
  onStartMark,
  onCancelMark,
  onConfirmMark,
  onSkip,
  onNotice,
  onError,
  renderEvidenceBox,
}: OutreachDirectoryCardProps) {
  const { t } = useUiLanguage();
  const [copiedNow, setCopiedNow] = useState(false);
  const copy = describeExternalListingCopy(item, isEn);
  const targetOpenUrl = item.listingDraft?.submitUrl || item.targetUrl;

  return (
    <article className="oap-action-card is-ready">
      <div className="oap-card-top">
        <div className="oap-badges">
          {isTopPriority && (
            <span className="oap-priority-pill">
              {isEn ? 'Priority #1' : '优先处理'}
            </span>
          )}
          <span className="oap-kind-pill is-awesome">
            <Globe size={12} />
            {copy.badge}
          </span>
          {Boolean(item.citedCount) && (
            <span className="oap-cited-pill">
              {t('actionPlan.citedBadge', { count: item.citedCount ?? 1 })}
            </span>
          )}
        </div>
      </div>

      <h3 data-i18n-skip="">{item.title}</h3>
      {renderEvidenceBox(item, copy.howToExplain)}

      <div className="oap-inline-fields">
        <label className="oap-field">
          <span>{copy.draftFieldLabel}</span>
          <textarea
            rows={5}
            value={pitchText}
            onChange={(e) => onChangePitch(e.target.value)}
          />
        </label>
      </div>

      {isMarkingListing && (
        <div className="oap-mark-sent-box">
          <input
            type="url"
            value={sentUrlInput}
            onChange={(e) => onChangeSentUrl(e.target.value)}
            placeholder={copy.markPlaceholder}
          />
          <div className="oap-mark-sent-btns">
            <button
              type="button"
              className="ost-btn-secondary is-sm"
              onClick={onCancelMark}
            >
              {t('actionPlan.readerDrawerClose')}
            </button>
            <button
              type="button"
              className="ost-btn-primary is-sm"
              disabled={Boolean(busyId) || !/^https?:\/\/\S+/i.test(sentUrlInput.trim())}
              onClick={async () => {
                const cleanUrl = sentUrlInput.trim();
                if (!/^https?:\/\/\S+/i.test(cleanUrl)) {
                  onError(
                    isEn
                      ? 'Please paste a valid http:// or https:// URL before archiving.'
                      : '请先填入以 http:// 或 https:// 开头的真实公开链接。',
                  );
                  return;
                }
                await onConfirmMark(cleanUrl);
              }}
            >
              <Check size={13} />
              <span>{t('actionPlan.markSentBtn')}</span>
            </button>
          </div>
        </div>
      )}

      <div className="oap-card-actions">
        <button
          type="button"
          className="ost-btn-secondary is-sm"
          disabled={Boolean(busyId)}
          onClick={() => void onSkip()}
        >
          {t('actionPlan.skipCardBtn')}
        </button>
        {!isMarkingListing && (
          <button
            type="button"
            className="ost-btn-secondary is-sm"
            disabled={Boolean(busyId)}
            onClick={onStartMark}
          >
            <Check size={13} />
            <span>{t('actionPlan.markSentBtn')}</span>
          </button>
        )}
        <button
          type="button"
          className="ost-btn-secondary is-sm"
          onClick={async () => {
            onError('');
            try {
              await navigator.clipboard?.writeText(pitchText);
              setCopiedNow(true);
              window.setTimeout(() => setCopiedNow(false), 2000);
              onNotice(
                copy.listingType === 'editorial_roundup'
                  ? isEn
                    ? 'Copied outreach pitch to clipboard.'
                    : '已复制给作者的自荐信到剪贴板。'
                  : isEn
                    ? 'Copied submission details to clipboard.'
                    : '已复制产品提交资料到剪贴板。',
              );
            } catch {
              onError(
                isEn
                  ? 'Clipboard copy failed — select and copy the text box above manually.'
                  : '自动复制失败，请直接选中上方文本框手动复制。',
              );
            }
          }}
        >
          {copiedNow ? <Check size={13} /> : <Copy size={13} />}
          <span>
            {copiedNow
              ? isEn
                ? 'Copied'
                : '已复制'
              : copy.copyBtnLabel}
          </span>
        </button>
        <a
          href={targetOpenUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="ost-btn-primary is-sm"
        >
          <span>{copy.openLinkLabel}</span>
          <ExternalLink size={14} />
        </a>
      </div>
    </article>
  );
}
