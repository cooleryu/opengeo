'use client';

import { inferContentLang } from '@/lib/geo/i18n';
import { auditRows, isAiAnswerRow } from '@/lib/geo/overview-metrics';
import type { ResearchBatch } from '@/lib/geo/research-types';
import type { ResearchRow } from '@/lib/geo/research-view';
import { useUiLanguage } from '../UiLanguageContext';

export const verdictLabels = {
  zh: { yes: '已提及', no: '未提及', unknown: '分析中' },
  en: { yes: 'Mentioned', no: 'Not mentioned', unknown: 'Analyzing' },
} as const;

export function OverviewMention({
  batch,
  row,
}: {
  batch: ResearchBatch;
  row: ResearchRow;
}) {
  const { uiLanguage, t } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const audit = auditRows(batch, [row], batch.answerAudits ?? [])[0]?.audit;
  return (
    <span
      className={`pov-status ${audit?.mention === 'yes' ? 'positive' : ''}`}
    >
      {!row.observation
        ? (isEn ? 'Not run' : '未测')
        : !audit
          ? (isEn ? 'Analyzing' : '分析中')
          : audit.mention === 'unknown'
            ? t('term.couldNotVerify')
            : verdictLabels[isEn ? 'en' : 'zh'][audit.mention]}
    </span>
  );
}

export function humanizeAuditEvidence(
  text: string | undefined,
  kind: 'mention' | 'citation',
  verdict: 'yes' | 'no' | 'unknown',
  isEn = false,
  audited = false,
): string {
  const trimmed = text?.trim();
  if (!trimmed) {
    if (audited && verdict === 'unknown') {
      return kind === 'mention'
        ? isEn
          ? "Couldn't verify whether this answer mentioned your product."
          : '无法确认这条回答是否提到了你的产品。'
        : isEn
          ? "Couldn't verify whether this answer cited your site."
          : '无法确认这条回答是否引用了你的网站。';
    }
    return kind === 'mention'
      ? isEn
        ? 'This answer has not been verified yet.'
        : '这条回答尚未复核。'
      : isEn
        ? 'Source citation check is pending.'
        : '引用关系尚未核实。';
  }
  if (/(?:nativeCitations|citationSource|citationsComplete|observedSourceHints|\bevidence\.)/i.test(trimmed)) {
    if (kind === 'citation' && verdict === 'unknown') {
      return audited
        ? isEn
          ? "Couldn't verify whether this answer cited your site from the captured links."
          : '无法根据已采集的来源链接确认是否引用了你的网站。'
        : isEn
          ? 'Checking captured source links against your project pages.'
          : '正在核对采集到的来源链接归属。';
    }
    if (kind === 'citation' && verdict === 'no') {
      return isEn
        ? 'Verified captured links: none point to your site, repository, or owned articles.'
        : '已核对回答附带的来源链接，未发现指向本项目网站、仓库或自有文章的链接。';
    }
  }
  if (isEn && /[\u4e00-\u9fff]/.test(trimmed)) {
    if (kind === 'mention') {
      if (verdict === 'no') {
        const listed = trimmed.match(/列举了\s*([^，。；]+?)\s*等/);
        const names = listed?.[1]?.replace(/\s*、\s*/g, ', ').trim();
        if (names && !/[\u4e00-\u9fff]/.test(names)) {
          return `The answer lists alternatives (${names}), with zero mention of your project or repository.`;
        }
        return 'Reviewed the full captured answer; your project name and repository were not mentioned.';
      }
      if (verdict === 'yes') {
        return 'Verified direct mention of your project in the captured answer.';
      }
      return audited
        ? "Couldn't verify whether this answer mentioned your product."
        : 'Analyzing brand mention in this captured answer.';
    }
    if (verdict === 'no') {
      return 'Verified captured links: none point to your site, repository, or owned articles.';
    }
    if (verdict === 'yes') {
      return 'Confirmed a citation link pointing to your official site, repository, or authored article.';
    }
    return audited
      ? "Couldn't verify whether this answer cited your site."
      : 'Checking captured source links against your project pages.';
  }
  return trimmed
    .replace(/[（(]\s*(?:citationSource|citationsComplete)\s*=[^）)]+[）)]/gi, '')
    .trim();
}

export function OverviewAudit({
  batch,
  row,
}: {
  batch: ResearchBatch;
  row: ResearchRow;
}) {
  const { uiLanguage, t } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const audit = auditRows(batch, [row], batch.answerAudits ?? [])[0]?.audit;
  if (!row.observation || !isAiAnswerRow(row)) return null;
  const mention = audit?.mention ?? 'unknown';
  const citation = audit?.citation ?? 'unknown';
  return (
    <div className="pov-audit-detail">
      <div>
        <strong>
          {isEn ? 'Brand mention' : '正文提及'} ·{' '}
          {!audit
            ? (isEn ? 'Analyzing' : '分析中')
            : mention === 'unknown'
              ? t('term.couldNotVerify')
              : verdictLabels[isEn ? 'en' : 'zh'][mention]}
        </strong>
        <p
          lang={audit?.mentionEvidence ? inferContentLang(audit.mentionEvidence) : undefined}
          data-i18n-skip={audit?.mentionEvidence ? '' : undefined}
        >
          {humanizeAuditEvidence(audit?.mentionEvidence, 'mention', mention, isEn, Boolean(audit))}
        </p>
      </div>
      <div>
        <strong>
          {isEn ? 'Official citation' : '官方引用'} ·{' '}
          {!audit
            ? (isEn ? 'Analyzing' : '分析中')
            : citation === 'yes'
              ? (isEn ? 'Cited' : '已确认')
              : citation === 'no'
                ? (isEn ? 'Not cited' : '未引用')
                : t('term.couldNotVerify')}
        </strong>
        <p
          lang={audit?.citationEvidence ? inferContentLang(audit.citationEvidence) : undefined}
          data-i18n-skip={audit?.citationEvidence ? '' : undefined}
        >
          {humanizeAuditEvidence(audit?.citationEvidence, 'citation', citation, isEn, Boolean(audit))}
        </p>
      </div>
    </div>
  );
}
