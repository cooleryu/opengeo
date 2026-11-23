'use client';

import { useMemo, useState } from 'react';
import { Check, ExternalLink, GitBranch, Loader2, RefreshCw, ScanSearch, Sparkles } from 'lucide-react';
import type { ActionBoardCard } from '@/lib/geo/optimization/action-board-catalog';
import type { PageAuditRecord } from '@/lib/geo/optimization/page-audit';
import { editPlace, editTitle, liveEdits } from './ActionBoardCards';
import { EditDiffView, Segmented, ShotViewer, type DiffMode } from './EditDiff';
import { auditShotUrl, CopyButton, postJson, type BoardActions, type BoardText } from './action-board-shared';

type Busy = 'preview' | 'push' | 'write' | 'live' | null;

export function FileChangeEdits({
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
  const { tk, tn, pick } = text;
  const audit = actions.pageAudit;
  const edits = liveEdits(card, audit);
  const labels = useMemo(
    () => new Map((card.payload?.kind === 'page_diff' ? card.payload.edits : []).map((e) => [e.findingId, e])),
    [card.payload],
  );
  const [selectedId, setSelectedId] = useState<string | null>(initialFindingId ?? null);
  const [mode, setMode] = useState<DiffMode>('changes');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Busy>(null);
  const [busyFindingId, setBusyFindingId] = useState<string | null>(null);
  const [confirmPush, setConfirmPush] = useState(false);
  const [liveUrl, setLiveUrl] = useState('');

  if (!audit || !edits.length) {
    return (
      <div className="ab-empty-pane">
        <ScanSearch size={28} />
        <strong>{tk('fc.noAuditTitle', { target: card.target.label })}</strong>
        <p>{tk('fc.noAuditBody')}</p>
        <button type="button" className="ost-btn-primary is-sm" disabled={actions.auditRunning} onClick={() => void actions.onRunAudit(card.target.assetId)}>
          {actions.auditRunning ? <Loader2 size={14} className="ost-spin" /> : <ScanSearch size={14} />}
          <span>{tk(actions.auditRunning ? 'fc.auditing' : 'fc.runAudit')}</span>
        </button>
      </div>
    );
  }

  const selected = edits.find((f) => f.id === selectedId) ?? edits[0];
  const drafted = edits.filter((f) => f.patchPreview && f.status === 'open');
  const included = drafted.filter((f) => !excluded.has(f.id));
  const includedIds = included.map((f) => f.id);
  const canPush = audit.targetKind === 'repo_doc' && /github\.com\//i.test(audit.targetUrl ?? '');
  const fileName = audit.localFilePath ?? audit.targetLabel;
  const shot = auditShotUrl(actions.projectId, audit, selected.screenshotFile);
  const label = labels.get(selected.id);

  const call = async (kind: Busy, body: Record<string, unknown>) => {
    setBusy(kind);
    try {
      const { ok, data } = await postJson<{ pageAudit?: PageAuditRecord; branch?: string; commitHash?: string; writtenPath?: string }>(
        '/api/geo/optimization',
        { projectId: actions.projectId, uiLanguage: text.uiLanguage, ...body },
      );
      if (!ok || !data.pageAudit) throw new Error(data.error || tk('board.errAction'));
      actions.onPageAuditChange(data.pageAudit);
      return data;
    } catch (error) {
      actions.onError(error instanceof Error ? error.message : tk('board.errAction'));
      return null;
    } finally {
      setBusy(null);
      setBusyFindingId(null);
    }
  };

  const draftOne = (findingId: string, forceRegenerate: boolean) => {
    setBusyFindingId(findingId);
    void call('preview', { action: 'preview_finding_batch', findingIds: [findingId], forceRegenerate });
  };

  const push = async () => {
    setConfirmPush(false);
    const data = await call('push', { action: 'publish_findings_github', findingIds: includedIds });
    if (data?.branch) {
      actions.onNotice(tk('fc.pushed', { branch: data.branch, commit: (data.commitHash ?? '').slice(0, 7) }));
      await actions.onMarkDone(card.id);
    }
  };

  const writeLocal = async () => {
    const data = await call('write', { action: 'apply_finding_batch', findingIds: includedIds });
    if (data) actions.onNotice(tk('fc.written', { file: data.writtenPath ?? fileName }));
  };

  const markLive = async () => {
    const url = liveUrl.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return;
    const data = await call('live', { action: 'mark_findings_live', findingIds: includedIds, liveUrl: url });
    if (data) await actions.onMarkDone(card.id, url);
  };

  return (
    <div className="ab-fc">
      <div className="ab-fc-bar">
        <span className="ab-file-path">{fileName}</span>
        {audit.targetUrl && (
          <a className="ab-link" href={audit.targetUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={13} />
            {tk('fc.openLive')}
          </a>
        )}
        <span className="ab-fc-count">{tk('fc.includedCount', { n: included.length, total: drafted.length })}</span>
      </div>

      <div className="ab-fc-grid">
        <ol className="ab-edit-list" aria-label={tk('fc.edits')}>
          {edits.map((finding) => {
            const isOn = finding.patchPreview && finding.status === 'open' && !excluded.has(finding.id);
            return (
              <li key={finding.id} className={finding.id === selected.id ? 'is-active' : ''}>
                <input
                  type="checkbox"
                  aria-label={tk('fc.include')}
                  checked={Boolean(isOn)}
                  disabled={!finding.patchPreview || finding.status !== 'open'}
                  onChange={() =>
                    setExcluded((prev) => {
                      const next = new Set(prev);
                      if (next.has(finding.id)) next.delete(finding.id);
                      else next.add(finding.id);
                      return next;
                    })
                  }
                />
                <button type="button" onClick={() => setSelectedId(finding.id)}>
                  <span className="ab-edit-tags">
                    <span className={`ab-tag is-${finding.impact}`}>{tk(`fc.impact.${finding.impact}`)}</span>
                    <span className="ab-tag">{tk(`fc.cat.${finding.category}`)}</span>
                    {finding.status === 'applied' && <span className="ab-tag is-live">{tk('fc.applied')}</span>}
                  </span>
                  <strong>{editTitle(card, finding, text)}</strong>
                  <span className="ab-edit-where">{editPlace(finding, text)}</span>
                </button>
              </li>
            );
          })}
        </ol>

        <div className="ab-edit-detail">
          {shot && <ShotViewer key={shot} src={shot} alt={editPlace(selected, text)} />}
          {label?.why && (
            <p className="ab-why">
              <span>{tk('fc.why')}</span>
              {pick(label.why)}
            </p>
          )}
          {selected.patchPreview ? (
            <>
              <div className="ab-diff-pane">
                <Segmented
                  value={mode}
                  onChange={setMode}
                  label={tk('hero.view')}
                  options={[
                    { value: 'changes', label: tk('hero.changes') },
                    { value: 'after', label: tk('hero.after') },
                    { value: 'source', label: tk('hero.source') },
                  ]}
                />
                <EditDiffView
                  before={selected.patchPreview.beforeExcerpt}
                  after={selected.patchPreview.afterExcerpt}
                  unifiedDiff={selected.patchPreview.unifiedDiff}
                  mode={mode}
                  lang={audit.targetLanguage}
                />
              </div>
              <div className="ab-inline-actions">
                <button
                  type="button"
                  className="ost-btn-secondary is-sm"
                  disabled={busy !== null || selected.status !== 'open'}
                  onClick={() => draftOne(selected.id, true)}
                >
                  {busyFindingId === selected.id ? <Loader2 size={14} className="ost-spin" /> : <RefreshCw size={14} />}
                  <span>{tk(busyFindingId === selected.id ? 'fc.writing' : 'fc.anotherVersion')}</span>
                </button>
                <CopyButton value={selected.patchPreview.afterExcerpt} label={tk('fc.copyPatch')} />
              </div>
            </>
          ) : (
            <div className="ab-diff-empty">
              <span lang={audit.targetLanguage}>{selected.anchorQuote || selected.sectionExcerpt.slice(0, 220)}</span>
              <button type="button" className="ost-btn-primary is-sm" disabled={busy !== null} onClick={() => draftOne(selected.id, false)}>
                {busyFindingId === selected.id ? <Loader2 size={14} className="ost-spin" /> : <Sparkles size={14} />}
                <span>{tk(busyFindingId === selected.id ? 'fc.writing' : 'fc.writeEdit')}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <footer className="ab-fc-foot">
        {canPush ? (
          confirmPush ? (
            <>
              <button type="button" className="ost-btn-primary is-sm" disabled={busy !== null} onClick={() => void push()}>
                <GitBranch size={14} />
                <span>{tk('fc.pushConfirm')}</span>
              </button>
              <button type="button" className="ost-btn-secondary is-sm" onClick={() => setConfirmPush(false)}>
                {tk('dlg.close')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="ost-btn-primary is-sm"
              disabled={busy !== null || !included.length}
              onClick={() => setConfirmPush(true)}
            >
              {busy === 'push' ? <Loader2 size={14} className="ost-spin" /> : <GitBranch size={14} />}
              <span>{busy === 'push' ? tk('fc.pushing') : tn('fc.push', included.length)}</span>
            </button>
          )
        ) : (
          <>
            <CopyButton value={included.map((f) => f.patchPreview?.afterExcerpt ?? '').join('\n\n')} label={tk('fc.copyPatch')} />
            <input
              className="ab-input"
              type="url"
              value={liveUrl}
              placeholder={tk('fc.liveUrl')}
              aria-label={tk('fc.liveUrl')}
              onChange={(e) => setLiveUrl(e.target.value)}
            />
            <button
              type="button"
              className="ost-btn-primary is-sm"
              disabled={busy !== null || !included.length || !/^https?:\/\/\S+$/i.test(liveUrl.trim())}
              onClick={() => void markLive()}
            >
              {busy === 'live' ? <Loader2 size={14} className="ost-spin" /> : <Check size={14} />}
              <span>{tk('fc.markLive')}</span>
            </button>
          </>
        )}
        {canPush && audit.localFilePath && (
          <button type="button" className="ab-text-btn" disabled={busy !== null || !included.length} onClick={() => void writeLocal()}>
            {busy === 'write' && <Loader2 size={13} className="ost-spin" />}
            {tn('fc.writeLocal', included.length, { file: audit.localFilePath })}
          </button>
        )}
      </footer>
    </div>
  );
}
