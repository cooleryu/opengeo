'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown from 'markdown-to-jsx';
import {
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileSearch,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import type { HumanProgressStep } from '@/lib/agent-hub';
import { plural } from '@/lib/geo/i18n';
import type {
  PageAuditFinding,
  PageAuditRecord,
  PageAuditTargetOption,
} from '@/lib/geo/optimization/page-audit';
import GeoSelect from './GeoSelect';
import ResearchEngineIcon from './ResearchEngineIcon';
import { useUiLanguage } from './UiLanguageContext';

export interface PageAuditSectionProps {
  projectId: string;
  questionTotal: number;
  initialAudit: PageAuditRecord | null;
  targets: PageAuditTargetOption[];
  onOpenQuestions?: () => void;
  onAuditUpdated?: (audit: PageAuditRecord) => void;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
}

function buildCopyBriefMarkdown(audit: PageAuditRecord, selectedIds: Set<string>): string {
  const chosen = audit.findings.filter((f) => selectedIds.has(f.id));
  const lines: string[] = [
    `# ${audit.targetLabel} — Page Update Brief`,
    ...(audit.targetUrl ? [`URL: ${audit.targetUrl}`] : []),
    `Based on ${audit.shardStats.totalAnswers} live AI answers (${audit.shardStats.chatgptAnswers} ChatGPT / ${audit.shardStats.googleAnswers} Google AI).`,
    '',
  ];
  chosen.forEach((f, idx) => {
    lines.push(`## ${idx + 1}. ${f.title} (${f.sectionHeading})`);
    lines.push(`- **Why**: ${f.whyAiMissed}`);
    lines.push(`- **Verified basis**: ${f.codebaseFact}`);
    lines.push(`- **Target block**: "${f.anchorQuote}"`);
    if (f.patchPreview) {
      lines.push(
        `- **Action**: ${f.patchPreview.insertionMode === 'insert_after' ? 'Insert right after the target block' : 'Replace the target block'}`,
      );
      lines.push('');
      lines.push('```markdown');
      lines.push(f.patchPreview.afterExcerpt.trim());
      lines.push('```');
    } else {
      lines.push(`- **Suggested update**: ${f.suggestedDirection}`);
    }
    lines.push('');
  });
  return lines.join('\n').trim();
}

function shortPillLabel(finding: PageAuditFinding, isEn: boolean): string {
  const heading = finding.sectionHeading
    .replace(/^Opening\s*\/\s*|^顶部介绍\s*·\s*/i, '')
    .trim();
  if (finding.category === 'missing_definition') {
    return isEn ? 'Hero definition' : '首屏定义';
  }
  if (finding.category === 'weak_claim_check') {
    return isEn ? 'Evidence check' : '弱证据核查';
  }
  if (heading && heading.length <= 20) return heading;
  if (finding.category === 'competitor_angle_gap') {
    return isEn ? 'Comparison gap' : '对比维度补漏';
  }
  return finding.title;
}

function renderHighlightedExcerpt(excerpt: string, anchor: string): ReactNode {
  const cleanAnchor = anchor.trim();
  if (!cleanAnchor) return excerpt;
  const idx = excerpt.indexOf(cleanAnchor);
  if (idx < 0) return excerpt;
  return (
    <>
      {excerpt.slice(0, idx)}
      <mark className="oap-anchor-mark">{cleanAnchor}</mark>
      {excerpt.slice(idx + cleanAnchor.length)}
    </>
  );
}

export default function PageAuditSection({
  projectId,
  questionTotal,
  initialAudit,
  targets,
  onOpenQuestions,
  onAuditUpdated,
  onNotice,
  onError,
}: PageAuditSectionProps) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';

  const [audit, setAudit] = useState<PageAuditRecord | null>(initialAudit);
  const [selectedAssetId, setSelectedAssetId] = useState<string>(
    initialAudit?.targetAssetId || targets[0]?.assetId || '',
  );
  const [runningAudit, setRunningAudit] = useState(false);
  const [auditSteps, setAuditSteps] = useState<HumanProgressStep[]>([]);
  const [busyFindingId, setBusyFindingId] = useState<string | null>(null);
  const [busyBatchOp, setBusyBatchOp] = useState<'preview' | 'apply' | 'mark_live' | null>(null);
  const [markingLiveScope, setMarkingLiveScope] = useState<'card' | 'modal' | null>(null);
  const [liveUrlInput, setLiveUrlInput] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [pendingScrollFindingId, setPendingScrollFindingId] = useState<string | null>(null);
  const [showSignalDiff, setShowSignalDiff] = useState(false);

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const activeAudit = audit ?? initialAudit;
  const effectiveAssetId = selectedAssetId || activeAudit?.targetAssetId || targets[0]?.assetId || '';

  // Sync local selection state with activeAudit findings (open findings selected by default)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    const init = new Set<string>();
    for (const f of initialAudit?.findings ?? []) {
      if (f.status === 'open') init.add(f.id);
    }
    return init;
  });

  const auditIdKey = activeAudit?.id ?? '';
  useEffect(() => {
    if (!activeAudit) return;
    setSelectedIds((prev) => {
      const next = new Set<string>();
      for (const f of activeAudit.findings) {
        if (f.status === 'open') {
          // Keep user's unchecked choice within same audit run; default-check on fresh audit
          if (prev.size === 0 || prev.has(f.id)) next.add(f.id);
        }
      }
      return next;
    });
    // Reset cleanly whenever a new audit run completes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditIdKey]);

  // Native <dialog> open/close synchronization + light dismiss fallback
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (modalOpen && !dlg.open) {
      dlg.showModal();
    } else if (!modalOpen && dlg.open) {
      dlg.close();
    }
  }, [modalOpen]);

  useEffect(() => {
    if (!modalOpen || !pendingScrollFindingId) return;
    const timer = setTimeout(() => {
      const el = document.getElementById(`oap-doc-finding-${pendingScrollFindingId}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setPendingScrollFindingId(null);
    }, 60);
    return () => clearTimeout(timer);
  }, [modalOpen, pendingScrollFindingId]);

  const findings = useMemo(() => activeAudit?.findings ?? [], [activeAudit]);
  const openFindings = useMemo(() => findings.filter((f) => f.status !== 'applied'), [findings]);
  const allApplied = findings.length > 0 && openFindings.length === 0;
  const selectedOpenIds = useMemo(
    () => openFindings.filter((f) => selectedIds.has(f.id)).map((f) => f.id),
    [openFindings, selectedIds],
  );
  const missingPreviewSelectedIds = useMemo(
    () =>
      openFindings
        .filter((f) => selectedIds.has(f.id) && !f.patchPreview)
        .map((f) => f.id),
    [openFindings, selectedIds],
  );
  const canWriteLocalFile = Boolean(activeAudit?.localFilePath);
  const isLiveWebTarget = Boolean(activeAudit && activeAudit.targetKind === 'live_web');
  const hasShippedCurrentAudit = useMemo(() => {
    if (!activeAudit?.shippedRecords?.length) return false;
    const currentIds = new Set(findings.map((f) => f.id));
    return activeAudit.shippedRecords.some((rec) =>
      rec.findingIds.some((id) => currentIds.has(id)),
    );
  }, [activeAudit, findings]);
  const markLiveCandidateIds = useMemo(() => {
    if (selectedOpenIds.length > 0) return selectedOpenIds;
    return findings.filter((f) => f.status === 'applied').map((f) => f.id);
  }, [findings, selectedOpenIds]);
  const heroShotFinding = useMemo(
    () => findings.find((f) => Boolean(f.screenshotFile)) ?? findings[0] ?? null,
    [findings],
  );

  const toggleSelectFinding = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openInspectModal = (scrollToId?: string) => {
    setPendingScrollFindingId(scrollToId ?? null);
    setModalOpen(true);
  };

  const runAudit = async (overrideAssetId?: string) => {
    if (runningAudit || !projectId) return;
    setRunningAudit(true);
    setAuditSteps([]);
    onError?.('');
    onNotice?.('');

    try {
      const res = await fetch('/api/geo/optimization', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        body: JSON.stringify({
          projectId,
          action: 'audit_page',
          assetId: (overrideAssetId ?? effectiveAssetId) || undefined,
        }),
      });

      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          payload.error || (isEn ? 'Page audit failed.' : '页面分块体检失败，请稍后重试。'),
        );
      }

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/x-ndjson') && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newlineIdx = buffer.indexOf('\n');
          while (newlineIdx >= 0) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (line) {
              const event = JSON.parse(line) as {
                type?: 'progress' | 'result' | 'error';
                step?: HumanProgressStep;
                pageAudit?: PageAuditRecord;
                error?: string;
              };
              if (event.type === 'progress' && event.step) {
                setAuditSteps((prev) => [...prev, event.step!]);
              } else if (event.type === 'result' && event.pageAudit) {
                setAudit(event.pageAudit);
                setSelectedIds(
                  new Set(
                    event.pageAudit.findings.filter((f) => f.status === 'open').map((f) => f.id),
                  ),
                );
                onAuditUpdated?.(event.pageAudit);
              } else if (event.type === 'error') {
                throw new Error(event.error || (isEn ? 'Page audit failed.' : '页面分块体检失败。'));
              }
            }
            newlineIdx = buffer.indexOf('\n');
          }
        }
      } else {
        const payload = (await res.json()) as { pageAudit?: PageAuditRecord };
        if (payload.pageAudit) {
          setAudit(payload.pageAudit);
          setSelectedIds(
            new Set(payload.pageAudit.findings.filter((f) => f.status === 'open').map((f) => f.id)),
          );
          onAuditUpdated?.(payload.pageAudit);
        }
      }
    } catch (err) {
      onError?.(
        err instanceof Error
          ? err.message
          : isEn
            ? 'Page audit failed.'
            : '页面分块体检失败，请检查模型配置后重试。',
      );
    } finally {
      setRunningAudit(false);
    }
  };

  const handlePreviewSingle = async (findingId: string) => {
    if (busyFindingId || busyBatchOp) return;
    setBusyFindingId(findingId);
    onError?.('');
    try {
      const res = await fetch('/api/geo/optimization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          action: 'preview_finding_patch',
          findingId,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        pageAudit?: PageAuditRecord;
        error?: string;
      };
      if (!res.ok || !payload.pageAudit) {
        throw new Error(
          payload.error || (isEn ? 'Could not generate preview.' : '生成该处修改预览失败。'),
        );
      }
      setAudit(payload.pageAudit);
      onAuditUpdated?.(payload.pageAudit);
    } catch (err) {
      onError?.(
        err instanceof Error
          ? err.message
          : isEn
            ? 'Could not generate preview.'
            : '生成修改预览失败，请稍后重试。',
      );
    } finally {
      setBusyFindingId(null);
    }
  };

  const handlePreviewBatch = async (idsToPreview: string[]): Promise<PageAuditRecord | null> => {
    if (!idsToPreview.length) return activeAudit;
    setBusyBatchOp('preview');
    onError?.('');
    try {
      const res = await fetch('/api/geo/optimization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          action: 'preview_finding_batch',
          findingIds: idsToPreview,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        pageAudit?: PageAuditRecord;
        error?: string;
      };
      if (!res.ok || !payload.pageAudit) {
        throw new Error(
          payload.error || (isEn ? 'Could not generate previews.' : '批量生成修改预览失败。'),
        );
      }
      setAudit(payload.pageAudit);
      onAuditUpdated?.(payload.pageAudit);
      return payload.pageAudit;
    } catch (err) {
      onError?.(
        err instanceof Error
          ? err.message
          : isEn
            ? 'Could not generate previews.'
            : '批量生成修改预览失败，请稍后重试。',
      );
      return null;
    } finally {
      setBusyBatchOp(null);
    }
  };

  const handlePrimaryShip = async (fromModal: boolean) => {
    if (!activeAudit || !selectedOpenIds.length || busyBatchOp || busyFindingId) return;

    // Step 1: Ensure every selected finding has a drafted preview first (parallel via AgentHub.runBatch)
    let latestAudit: PageAuditRecord = activeAudit;
    if (missingPreviewSelectedIds.length > 0) {
      const generated = await handlePreviewBatch(missingPreviewSelectedIds);
      if (!generated) return;
      latestAudit = generated;
      // When triggered from the closed Launchpad before previews existed, open Idea B modal so user sees exact green edits!
      if (!fromModal && canWriteLocalFile) {
        setModalOpen(true);
        onNotice?.(
          isEn
            ? `Wrote ${plural('en', missingPreviewSelectedIds.length, { one: '{n} suggested edit', other: '{n} suggested edits' })}—review below and click Apply to write to ${latestAudit.targetLabel}.`
            : `已并发生成 ${missingPreviewSelectedIds.length} 条修改建议，滚一眼确认无误后点右下角即可写入本地 ${latestAudit.targetLabel}。`,
        );
        return;
      }
    }

    // Step 2A: No writable local repository file (pure SaaS site OR remote repo) -> copy brief honestly, NEVER mutate data/ snapshots
    if (!canWriteLocalFile) {
      const brief = buildCopyBriefMarkdown(latestAudit, new Set(selectedOpenIds));
      await navigator.clipboard?.writeText(brief).catch(() => {});
      onNotice?.(
        isEn
          ? `Copied ${plural('en', selectedOpenIds.length, { one: '{n} suggested edit', other: '{n} suggested edits' })} for ${latestAudit.targetLabel} to clipboard. After publishing them live, click "Mark live" with the live URL to start the retest clock.`
          : `已复制 ${selectedOpenIds.length} 条「${latestAudit.targetLabel}」修改建议到剪贴板；更新线上页面后点「我已上线」并填入线上链接，即可自动入账并开启复测计时。`,
      );
      return;
    }

    // Step 2B: Writable local repo file -> Apply selected previewed patches sequentially
    setBusyBatchOp('apply');
    onError?.('');
    try {
      const res = await fetch('/api/geo/optimization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          action: 'apply_finding_batch',
          findingIds: selectedOpenIds,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        pageAudit?: PageAuditRecord;
        appliedIds?: string[];
        errors?: string[];
        writtenPath?: string | null;
        error?: string;
      };
      if (!res.ok || !payload.pageAudit) {
        throw new Error(
          payload.error || (isEn ? 'Could not apply selected patches.' : '批量应用修改失败。'),
        );
      }
      setAudit(payload.pageAudit);
      onAuditUpdated?.(payload.pageAudit);
      const count = payload.appliedIds?.length ?? selectedOpenIds.length;
      if (count > 0) {
        onNotice?.(
          isEn
            ? `Wrote ${plural('en', count, { one: '{n} suggested edit', other: '{n} suggested edits' })} to local file ${payload.writtenPath || payload.pageAudit.targetLabel}. Push them live and click "Mark live" to start the retest clock.`
            : `已写入本地文件 ${payload.writtenPath || payload.pageAudit.targetLabel}（共 ${count} 条，其余内容保持原样）；推送上线后点击「我已上线」即可记入「已发布」并开始复测计时。`,
        );
        if (fromModal) setModalOpen(false);
      }
      if (payload.errors?.length) {
        onError?.(payload.errors.join('；'));
      }
    } catch (err) {
      onError?.(
        err instanceof Error
          ? err.message
          : isEn
            ? 'Could not apply selected patches.'
            : '应用修改失败，请重试。',
      );
    } finally {
      setBusyBatchOp(null);
    }
  };

  const openMarkLiveBar = (scope: 'card' | 'modal') => {
    const defaultUrl =
      activeAudit?.targetUrl && /^https?:\/\//i.test(activeAudit.targetUrl)
        ? activeAudit.targetUrl
        : '';
    setLiveUrlInput(defaultUrl);
    setMarkingLiveScope(scope);
    onError?.('');
  };

  const handleConfirmMarkLive = async () => {
    if (!activeAudit || !markLiveCandidateIds.length || busyBatchOp || busyFindingId) return;
    const cleanUrl = liveUrlInput.trim();
    if (!/^https?:\/\/\S+/i.test(cleanUrl)) {
      onError?.(
        isEn
          ? 'Please enter a valid http:// or https:// live page URL.'
          : '请填入以 http:// 或 https:// 开头的真实线上页面链接。',
      );
      return;
    }
    setBusyBatchOp('mark_live');
    onError?.('');
    try {
      const res = await fetch('/api/geo/optimization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          action: 'mark_findings_live',
          findingIds: markLiveCandidateIds,
          liveUrl: cleanUrl,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        pageAudit?: PageAuditRecord;
        error?: string;
      };
      if (!res.ok || !payload.pageAudit) {
        throw new Error(
          payload.error || (isEn ? 'Could not log live update.' : '记录已上线失败，请重试。'),
        );
      }
      setAudit(payload.pageAudit);
      onAuditUpdated?.(payload.pageAudit);
      setMarkingLiveScope(null);
      setLiveUrlInput('');
      setModalOpen(false);
      onNotice?.(
        isEn
          ? `Logged ${plural('en', markLiveCandidateIds.length, { one: '{n} live page update', other: '{n} live page updates' })} to Published and started the retest clock.`
          : `已将 ${markLiveCandidateIds.length} 条页面修改记入「已发布」，复测计时已开始。`,
      );
    } catch (err) {
      onError?.(
        err instanceof Error
          ? err.message
          : isEn
            ? 'Could not log live update.'
            : '记录已上线失败，请重试。',
      );
    } finally {
      setBusyBatchOp(null);
    }
  };

  const cardTitle = activeAudit
    ? isEn
      ? `Improve ${activeAudit.targetLabel}`
      : isLiveWebTarget
        ? `优化 ${activeAudit.targetLabel}`
        : `完善 ${activeAudit.targetLabel}`
    : isEn
      ? 'Audit your main page'
      : '体检你的核心页面';

  return (
    <>
      <section
        className={`oap-lp-card ${allApplied ? 'is-done' : ''}`}
        aria-label={cardTitle}
      >
        {/* Row 1: Aligned Card Header */}
        <div className="oap-lp-head">
          {(targets.length > 1 || activeAudit) && (
            <div className="oap-lp-head-top">
              <div className="oap-lp-head-meta">
                {targets.length > 1 && (
                  <GeoSelect
                    label={isEn ? 'Select page to audit' : '切换体检页面'}
                    className="oap-lp-select"
                    value={effectiveAssetId}
                    disabled={runningAudit}
                    onChange={setSelectedAssetId}
                    options={targets.map((item) => ({
                      value: item.assetId,
                      label: item.label,
                    }))}
                  />
                )}
                {activeAudit && !runningAudit && (
                  <button
                    type="button"
                    className="oap-lp-icon-btn"
                    title={isEn ? 'Re-run audit' : '重新体检'}
                    aria-label={isEn ? 'Re-run audit' : '重新体检'}
                    disabled={questionTotal === 0}
                    onClick={() => void runAudit()}
                  >
                    <RefreshCw size={13} />
                  </button>
                )}
                {activeAudit && (
                  <span className={`oap-lp-count ${allApplied ? 'is-done' : ''}`}>
                    {allApplied
                      ? hasShippedCurrentAudit
                        ? isEn
                          ? '✓ Live'
                          : '✓ 已上线入账'
                        : isEn
                          ? '✓ Written locally'
                          : '✓ 已写入本地'
                      : isEn
                        ? `${selectedOpenIds.length} / ${openFindings.length} selected`
                        : `已选 ${selectedOpenIds.length} / ${openFindings.length} 处`}
                  </span>
                )}
              </div>
            </div>
          )}

          <h2 className="oap-lp-title">{cardTitle}</h2>
          <p className="oap-lp-desc">
            {activeAudit
              ? isEn
                ? `Read ${activeAudit.shardStats.totalAnswers} full AI answers and pinpointed ${findings.length} exact spots affecting citations.`
                : `并发读完 ${activeAudit.shardStats.totalAnswers} 条真实 AI 回答并核对${canWriteLocalFile ? '本地源码' : '页面原文'}，标出 ${findings.length} 处最影响 AI 引用的缺口。`
              : isEn
                ? 'Reads full ChatGPT & Google AI answers in parallel to pinpoint 3–4 surgical improvements on your actual page.'
                : '并发拆解实测 ChatGPT / Google 全文回答，直接在你的真实页面上标出 3～4 处最值钱的局部缺口。'}
          </p>
        </div>

        {/* Row 2: Aligned Card Body (Thumbnail + 4 clickable numbered pills, or live progress / empty state) */}
        <div className="oap-lp-body">
          {runningAudit ? (
            <div className="oap-lp-working" aria-live="polite">
              <div className="oap-lp-working-head">
                <Loader2 size={16} className="ost-spin" />
                <strong>
                  {auditSteps[auditSteps.length - 1]?.message ||
                    (isEn
                      ? 'Auditing answers and capturing page highlights…'
                      : '正在并发拆解回答并截取页面实景高亮图…')}
                </strong>
              </div>
              {auditSteps.length > 1 && (
                <ul className="oap-lp-working-log">
                  {auditSteps.slice(-4).map((step, i) => (
                    <li key={`${step.at}-${i}`}>
                      <Check size={12} />
                      <span>{step.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : !activeAudit ? (
            <div className="oap-lp-empty">
              <FileSearch size={20} />
              <p>
                {questionTotal > 0
                  ? isEn
                    ? 'Click below to audit your page against real captured AI answers—no whole-page rewrite.'
                    : '点击下方即可对照真实 AI 回答做活页分块体检，并截取页面实景高亮图。'
                  : isEn
                    ? 'Run one round of question monitoring first so we can audit your page against real AI answers.'
                    : '先在「问题监测」跑完一轮真实 AI 回答，系统就能自动给页面定位缺口。'}
              </p>
            </div>
          ) : (
            <div className="oap-lp-audit-preview">
              {heroShotFinding?.screenshotFile ? (
                <button
                  type="button"
                  className="oap-lp-shot-thumb"
                  onClick={() => openInspectModal(heroShotFinding.id)}
                  title={isEn ? 'Open full-page visual review' : '点开一页连续审阅全部实景截图'}
                >
                  <div className="oap-lp-shot-chrome">
                    <span className="oap-lp-shot-host">
                      {activeAudit.targetUrl?.replace(/^https?:\/\//i, '') || activeAudit.targetLabel}
                    </span>
                    <span className="oap-lp-shot-hint">
                      {isEn ? 'Review all ↗' : '点开细看实景 ↗'}
                    </span>
                  </div>
                  <div className="oap-lp-shot-img-wrap">
                    <img
                      src={`/api/geo/project-media?project=${encodeURIComponent(projectId)}&auditShot=${encodeURIComponent(heroShotFinding.screenshotFile)}&v=${encodeURIComponent(activeAudit.updatedAt)}`}
                      alt={heroShotFinding.title}
                      lang={activeAudit.uiLanguage}
                      data-i18n-skip=""
                      loading="lazy"
                    />
                  </div>
                </button>
              ) : heroShotFinding ? (
                <button
                  type="button"
                  className="oap-lp-excerpt-thumb"
                  onClick={() => openInspectModal(heroShotFinding.id)}
                >
                  <span className="oap-lp-shot-hint">
                    <span data-i18n-skip="">{heroShotFinding.sectionHeading}</span> · {isEn ? 'Inspect ↗' : '点开细看 ↗'}
                  </span>
                  <p lang={activeAudit.targetLanguage} data-i18n-skip="">{heroShotFinding.anchorQuote}</p>
                </button>
              ) : null}

              <div className="oap-lp-pill-grid">
                {findings.map((finding, idx) => {
                  const isApplied = finding.status === 'applied';
                  const isSelected = selectedIds.has(finding.id);
                  return (
                    <button
                      key={finding.id}
                      type="button"
                      className={`oap-lp-finding-pill ${isApplied ? 'is-applied' : !isSelected ? 'is-off' : ''}`}
                      onClick={() => openInspectModal(finding.id)}
                    >
                      <span className="oap-lp-pill-num">
                        {isApplied ? <Check size={11} /> : idx + 1}
                      </span>
                      <span
                        className="oap-lp-pill-text"
                        lang={activeAudit.targetLanguage}
                        data-i18n-skip=""
                      >
                        {shortPillLabel(finding, isEn)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Row 3: Aligned Card Footer — the live-URL form takes this row while it is open */}
        {markingLiveScope === 'card' && activeAudit ? (
          <div className="oap-mark-sent-box oap-lp-mark-live-box">
            <input
              type="url"
              value={liveUrlInput}
              onChange={(e) => setLiveUrlInput(e.target.value)}
              placeholder={
                isEn
                  ? 'Required: live public page URL (https://...)'
                  : '必填：已上线的公开网页链接（https://...）'
              }
            />
            <div className="oap-mark-sent-btns">
              <button
                type="button"
                className="ost-btn-secondary is-sm"
                onClick={() => setMarkingLiveScope(null)}
              >
                {isEn ? 'Cancel' : '取消'}
              </button>
              <button
                type="button"
                className="ost-btn-primary is-sm"
                disabled={
                  busyBatchOp === 'mark_live' ||
                  markLiveCandidateIds.length === 0 ||
                  !/^https?:\/\/\S+/i.test(liveUrlInput.trim())
                }
                onClick={() => void handleConfirmMarkLive()}
              >
                {busyBatchOp === 'mark_live' ? (
                  <Loader2 size={13} className="ost-spin" />
                ) : (
                  <Check size={13} />
                )}
                <span>{isEn ? 'Confirm live & log' : '确认已上线并入账'}</span>
              </button>
            </div>
          </div>
        ) : (
        <div className="oap-lp-footer">
          {!activeAudit ? (
            questionTotal > 0 ? (
              <button
                type="button"
                className="ost-btn-primary is-sm oap-lp-full-cta"
                disabled={runningAudit}
                onClick={() => void runAudit()}
              >
                {runningAudit ? (
                  <Loader2 size={14} className="ost-spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                <span>
                  {runningAudit
                    ? isEn
                      ? 'Auditing…'
                      : '正在体检…'
                    : isEn
                      ? 'Run Page Audit'
                      : '开始活页体检'}
                </span>
              </button>
            ) : (
              <button
                type="button"
                className="ost-btn-primary is-sm oap-lp-full-cta"
                onClick={onOpenQuestions}
              >
                <span>{isEn ? 'Go to Question Monitoring' : '先去问题监测跑一轮'}</span>
              </button>
            )
          ) : (
            <>
              <button
                type="button"
                className="ost-btn-secondary is-sm"
                onClick={() => openInspectModal()}
              >
                {isEn ? `Review all ${findings.length}` : `细看这 ${findings.length} 处`}
              </button>

              <div className="oap-lp-footer-actions">
                {allApplied ? (
                  hasShippedCurrentAudit ? (
                    <span className="oap-lp-done-badge">
                      <CheckCircle2 size={14} />
                      <span>
                        {isEn ? 'Logged live' : `已上线入账 · ${activeAudit.targetLabel}`}
                      </span>
                    </span>
                  ) : (
                    <>
                      <span className="oap-lp-desc">
                        {isEn
                          ? `Next: publish ${activeAudit.targetLabel}`
                          : `下一步：发布 ${activeAudit.targetLabel}`}
                      </span>
                      <button
                        type="button"
                        className="ost-btn-primary is-sm"
                        disabled={Boolean(busyBatchOp) || Boolean(busyFindingId)}
                        onClick={() => openMarkLiveBar('card')}
                      >
                        <Check size={13} />
                        <span>{isEn ? 'Mark live' : '我已上线'}</span>
                      </button>
                    </>
                  )
                ) : (
                  <>
                    {!canWriteLocalFile && (
                      <button
                        type="button"
                        className="ost-btn-secondary is-sm"
                        disabled={
                          markLiveCandidateIds.length === 0 ||
                          Boolean(busyBatchOp) ||
                          Boolean(busyFindingId)
                        }
                        onClick={() => openMarkLiveBar('card')}
                      >
                        <Check size={13} />
                        <span>{isEn ? 'Mark live' : '我已上线'}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="ost-btn-primary is-sm"
                      disabled={
                        selectedOpenIds.length === 0 || Boolean(busyBatchOp) || Boolean(busyFindingId)
                      }
                      onClick={() => void handlePrimaryShip(false)}
                    >
                      {busyBatchOp === 'preview' || busyBatchOp === 'apply' ? (
                        <Loader2 size={14} className="ost-spin" />
                      ) : !canWriteLocalFile ? (
                        <Copy size={13} />
                      ) : (
                        <Check size={14} />
                      )}
                      <span>
                        {busyBatchOp === 'preview'
                          ? isEn
                            ? 'Writing suggested edits…'
                            : '正在生成修改建议…'
                          : busyBatchOp === 'apply'
                            ? isEn
                              ? 'Writing locally…'
                              : '正在写入本地…'
                            : !canWriteLocalFile
                              ? isEn
                                ? `Copy ${plural('en', selectedOpenIds.length, { one: '{n} suggested edit', other: '{n} suggested edits' })}`
                                : `复制已选 ${selectedOpenIds.length} 条修改建议`
                              : isEn
                                ? `Apply ${selectedOpenIds.length} locally`
                                : `写入本地已选 ${selectedOpenIds.length} 处`}
                      </span>
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
        )}
      </section>

      {/* IDEA B: Continuous Single-Page Visual Review Modal (<dialog closedby="any">) */}
      <dialog
        ref={dialogRef}
        className="oap-clean-modal"
        aria-labelledby="oap-audit-modal-title"
        onClose={() => setModalOpen(false)}
        onClick={(e) => {
          if (e.target === dialogRef.current) setModalOpen(false);
        }}
      >
        {activeAudit && (
          <>
            <header className="oap-modal-head">
              <div className="oap-modal-head-copy">
                <h2 id="oap-audit-modal-title">{cardTitle}</h2>
                <p>
                  {isEn
                    ? 'Scroll once from top to bottom—each spot shows its live page highlight and exact suggested edit.'
                    : '一页连续审阅：从头滑到底即可看清每处页面实景位置与绿色建议修改，不用反复切换标签页。'}
                </p>
              </div>
              <div className="oap-modal-head-actions">
                {missingPreviewSelectedIds.length > 0 && (
                  <button
                    type="button"
                    className="ost-btn-secondary is-sm"
                    disabled={Boolean(busyBatchOp) || Boolean(busyFindingId)}
                    onClick={() => void handlePreviewBatch(missingPreviewSelectedIds)}
                  >
                    {busyBatchOp === 'preview' ? (
                      <Loader2 size={13} className="ost-spin" />
                    ) : (
                      <Sparkles size={13} />
                    )}
                    <span>
                      {busyBatchOp === 'preview'
                        ? isEn
                          ? 'Writing suggested edits…'
                          : '正在生成修改建议…'
                        : isEn
                          ? `Write all ${plural('en', missingPreviewSelectedIds.length, { one: '{n} suggested edit', other: '{n} suggested edits' })}`
                          : `一次生成全部 ${missingPreviewSelectedIds.length} 条修改建议`}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className="oap-modal-close-btn"
                  aria-label={isEn ? 'Close' : '关闭'}
                  onClick={() => setModalOpen(false)}
                >
                  <X size={15} />
                  <span>{isEn ? 'Close' : '关闭'}</span>
                </button>
              </div>
            </header>

            <div className="oap-modal-body">
              {/* Quiet one-line AI summary strip + optional platform difference disclosure */}
              <div className="oap-modal-summary-bar">
                <p lang={activeAudit.uiLanguage} data-i18n-skip="">
                  {activeAudit.signalSheet.summary}
                </p>
                <button
                  type="button"
                  className="oap-modal-diff-link"
                  onClick={() => setShowSignalDiff((v) => !v)}
                >
                  {showSignalDiff
                    ? isEn
                      ? 'Hide ChatGPT / Google split'
                      : '收起平台差异'
                    : isEn
                      ? 'ChatGPT vs Google notes'
                      : '看 ChatGPT / Google 差异'}
                </button>
              </div>

              {showSignalDiff && (
                <div className="oap-modal-signal-grid">
                  <div>
                    <strong>ChatGPT</strong>
                    <p lang={activeAudit.uiLanguage} data-i18n-skip="">
                      {activeAudit.signalSheet.platformDifferences.chatgpt}
                    </p>
                  </div>
                  <div>
                    <strong>Google AI</strong>
                    <p lang={activeAudit.uiLanguage} data-i18n-skip="">
                      {activeAudit.signalSheet.platformDifferences.google}
                    </p>
                  </div>
                </div>
              )}

              {/* Continuous Flowing Editorial Stream (Idea B: 1 -> 2 -> 3 -> 4, ZERO tabs!) */}
              <div className="oap-doc-stream">
                {findings.map((finding, idx) => {
                  const isApplied = finding.status === 'applied';
                  const isSelected = selectedIds.has(finding.id);
                  const isBusyOne = busyFindingId === finding.id;
                  const preview = finding.patchPreview;
                  const mergedReason = `${finding.whyAiMissed}${
                    finding.codebaseFact
                      ? activeAudit.uiLanguage === 'en'
                        ? ` (Verified: ${finding.codebaseFact})`
                        : `（核实依据：${finding.codebaseFact}）`
                      : ''
                  }`;

                  return (
                    <article
                      key={finding.id}
                      id={`oap-doc-finding-${finding.id}`}
                      className={`oap-stream-item ${!isSelected && !isApplied ? 'is-muted' : ''}`}
                    >
                      {/* Finding Header + Single Toggle */}
                      <div className="oap-stream-item-head">
                        <div className="oap-stream-item-title-row">
                          <span className={`oap-stream-num ${isApplied ? 'is-applied' : !isSelected ? 'is-off' : ''}`}>
                            {isApplied ? <Check size={12} /> : idx + 1}
                          </span>
                          <div className="oap-stream-title-group">
                            <h3 lang={activeAudit.uiLanguage} data-i18n-skip="">
                              {finding.title}
                            </h3>
                            <div className="oap-stream-meta">
                              <span>
                                <span
                                  lang={activeAudit.uiLanguage}
                                  data-i18n-skip=""
                                >
                                  {finding.sectionHeading}
                                </span>
                                {activeAudit.targetKind === 'repo_doc'
                                  ? isEn
                                    ? ` · L${finding.startLine}–${finding.endLine}`
                                    : ` · 第 ${finding.startLine}–${finding.endLine} 行`
                                  : ''}
                              </span>
                              {finding.citedEngines.map((eng) => (
                                <span key={eng} className="oap-evidence-engine-tag">
                                  <ResearchEngineIcon engine={eng} />
                                  <span>{eng === 'chatgpt' ? 'ChatGPT' : 'Google'}</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>

                        {isApplied ? (
                          <span className="oap-stream-applied-tag">
                            <CheckCircle2 size={13} />
                            <span>{isEn ? 'Applied' : '已应用'}</span>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className={`oap-stream-toggle ${isSelected ? 'is-on' : ''}`}
                            onClick={() => toggleSelectFinding(finding.id)}
                          >
                            {isSelected ? (
                              <>
                                <Check size={12} />
                                <span>{isEn ? 'Included' : '采纳这处'}</span>
                              </>
                            ) : (
                              <span>{isEn ? 'Skipped · Restore' : '已跳过 · 恢复'}</span>
                            )}
                          </button>
                        )}
                      </div>

                      {/* ONE Merged Plain-Language Reason */}
                      <p
                        className="oap-stream-reason"
                        lang={activeAudit.uiLanguage}
                        data-i18n-skip=""
                      >
                        {mergedReason}
                      </p>

                      {/* Wide-Context Real Highlighted Page Screenshot */}
                      {finding.screenshotFile ? (
                        <figure className="oap-stream-shot">
                          <div className="oap-stream-shot-chrome">
                            <span data-i18n-skip="">
                              {activeAudit.targetUrl?.replace(/^https?:\/\//i, '') || activeAudit.targetLabel}
                            </span>
                            {activeAudit.targetUrl && (
                              <a href={activeAudit.targetUrl} target="_blank" rel="noreferrer">
                                {isEn ? 'Open live page' : '查看线上原页'} <ExternalLink size={11} />
                              </a>
                            )}
                          </div>
                          <img
                            src={`/api/geo/project-media?project=${encodeURIComponent(projectId)}&auditShot=${encodeURIComponent(finding.screenshotFile)}&v=${encodeURIComponent(activeAudit.updatedAt)}`}
                            alt={finding.title}
                            lang={activeAudit.uiLanguage}
                            data-i18n-skip=""
                            loading="lazy"
                          />
                        </figure>
                      ) : (
                        <div className="oap-stream-excerpt" lang={activeAudit.targetLanguage} data-i18n-skip="">
                          <pre>{renderHighlightedExcerpt(finding.sectionExcerpt, finding.anchorQuote)}</pre>
                        </div>
                      )}

                      {/* Forest-Green In-Place Suggested Edit Block */}
                      {preview ? (
                        <div className="oap-stream-suggestion">
                          <div className="oap-stream-suggestion-head">
                            <span className="oap-stream-suggestion-kicker">
                              <Sparkles size={12} />
                              {preview.insertionMode === 'insert_after'
                                ? isEn
                                  ? 'Suggested addition right after the highlighted block'
                                  : '建议紧跟上方标注段落补入的内容'
                                : isEn
                                  ? 'Suggested in-place replacement'
                                  : '建议原地替换后的内容'}
                            </span>
                            {!isApplied && (
                              <button
                                type="button"
                                className="oap-stream-regen-btn"
                                disabled={isBusyOne || Boolean(busyBatchOp)}
                                onClick={() => void handlePreviewSingle(finding.id)}
                              >
                                {isBusyOne ? (
                                  <Loader2 size={12} className="ost-spin" />
                                ) : (
                                  <RotateCcw size={12} />
                                )}
                                <span>{isEn ? 'Regenerate' : '换一版写法'}</span>
                              </button>
                            )}
                          </div>
                          <p
                            className="oap-stream-suggestion-summary"
                            lang={activeAudit.uiLanguage}
                            data-i18n-skip=""
                          >
                            {preview.plainSummary}
                          </p>
                          <div
                            className="oap-stream-suggestion-render"
                            lang={activeAudit.targetLanguage}
                            data-i18n-skip=""
                          >
                            <Markdown options={{ forceBlock: true }}>
                              {preview.afterExcerpt}
                            </Markdown>
                          </div>
                          <details className="oap-diff-disclosure">
                            <summary>{isEn ? 'Technical Diff' : '查看技术对比'}</summary>
                            <pre className="oap-diff-pre">
                              {preview.unifiedDiff.split('\n').map((line, i) => {
                                const cls =
                                  line.startsWith('+') && !line.startsWith('+++')
                                    ? 'is-add'
                                    : line.startsWith('-') && !line.startsWith('---')
                                      ? 'is-del'
                                      : line.startsWith('@@')
                                        ? 'is-hunk'
                                        : '';
                                return (
                                  <span key={i} className={`oap-diff-line ${cls}`}>
                                    {line}
                                  </span>
                                );
                              })}
                            </pre>
                          </details>
                        </div>
                      ) : (
                        <div className="oap-stream-draft-cta">
                          <p>
                            <strong>{isEn ? 'Suggested edit: ' : '建议改法：'}</strong>
                            <span lang={activeAudit.uiLanguage} data-i18n-skip="">
                              {finding.suggestedDirection}
                            </span>
                          </p>
                          {!isApplied && (
                            <button
                              type="button"
                              className="ost-btn-secondary is-sm"
                              disabled={isBusyOne || Boolean(busyBatchOp)}
                              onClick={() => void handlePreviewSingle(finding.id)}
                            >
                              {isBusyOne ? (
                                <Loader2 size={13} className="ost-spin" />
                              ) : (
                                <Sparkles size={13} />
                              )}
                              <span>
                                {isBusyOne
                                  ? isEn
                                    ? 'Writing…'
                                    : '生成中…'
                                  : isEn
                                    ? 'Write suggested edit'
                                    : '生成修改建议'}
                              </span>
                            </button>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>

            {markingLiveScope === 'modal' && (
              <div className="oap-mark-sent-box oap-modal-mark-live-box">
                <input
                  type="url"
                  value={liveUrlInput}
                  onChange={(e) => setLiveUrlInput(e.target.value)}
                  placeholder={
                    isEn
                      ? 'Required: paste the live public page URL (https://...)'
                      : '必填：粘贴已上线的公开网页链接（https://...），记入「已发布」并开始复测计时'
                  }
                />
                <div className="oap-mark-sent-btns">
                  <button
                    type="button"
                    className="ost-btn-secondary is-sm"
                    onClick={() => setMarkingLiveScope(null)}
                  >
                    {isEn ? 'Cancel' : '取消'}
                  </button>
                  <button
                    type="button"
                    className="ost-btn-primary is-sm"
                    disabled={
                      busyBatchOp === 'mark_live' ||
                      markLiveCandidateIds.length === 0 ||
                      !/^https?:\/\/\S+/i.test(liveUrlInput.trim())
                    }
                    onClick={() => void handleConfirmMarkLive()}
                  >
                    {busyBatchOp === 'mark_live' ? (
                      <Loader2 size={13} className="ost-spin" />
                    ) : (
                      <Check size={13} />
                    )}
                    <span>{isEn ? 'Confirm live & log' : '确认已上线并入账'}</span>
                  </button>
                </div>
              </div>
            )}

            <footer className="oap-modal-footer">
              <span className="oap-modal-footer-meta">
                {allApplied
                  ? hasShippedCurrentAudit
                    ? isEn
                      ? 'Logged live to Published'
                      : '已记入「已发布」'
                    : isEn
                      ? 'Written to local file'
                      : '全部改动已写入本地文件'
                  : isEn
                    ? `${selectedOpenIds.length} of ${openFindings.length} suggested edits selected`
                    : `已选 ${selectedOpenIds.length} / ${openFindings.length} 条修改建议`}
              </span>
              <div className="oap-modal-footer-actions">
                {(!canWriteLocalFile || (allApplied && !hasShippedCurrentAudit)) &&
                  markLiveCandidateIds.length > 0 && (
                    <button
                      type="button"
                      className="ost-btn-secondary is-sm"
                      disabled={Boolean(busyBatchOp) || Boolean(busyFindingId)}
                      onClick={() => openMarkLiveBar('modal')}
                    >
                      <Check size={13} />
                      <span>{isEn ? 'Mark live' : '我已上线'}</span>
                    </button>
                  )}
                {!allApplied && (
                  <button
                    type="button"
                    className="ost-btn-primary is-sm"
                    disabled={
                      selectedOpenIds.length === 0 || Boolean(busyBatchOp) || Boolean(busyFindingId)
                    }
                    onClick={() => void handlePrimaryShip(true)}
                  >
                    {busyBatchOp === 'preview' || busyBatchOp === 'apply' ? (
                      <Loader2 size={14} className="ost-spin" />
                    ) : !canWriteLocalFile ? (
                      <Copy size={13} />
                    ) : (
                      <Check size={14} />
                    )}
                    <span>
                      {busyBatchOp === 'preview'
                        ? isEn
                          ? 'Writing suggested edits…'
                          : '正在生成修改建议…'
                        : busyBatchOp === 'apply'
                          ? isEn
                            ? 'Writing locally…'
                            : '正在写入本地…'
                          : !canWriteLocalFile
                            ? isEn
                              ? `Copy ${plural('en', selectedOpenIds.length, { one: '{n} suggested edit', other: '{n} suggested edits' })}`
                              : `复制已选 ${selectedOpenIds.length} 条修改建议`
                            : isEn
                              ? `Apply ${selectedOpenIds.length} locally to ${activeAudit.targetLabel}`
                              : `写入本地已选 ${selectedOpenIds.length} 处`}
                    </span>
                  </button>
                )}
              </div>
            </footer>
          </>
        )}
      </dialog>
    </>
  );
}
