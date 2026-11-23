'use client';

import { X } from 'lucide-react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { OutreachActionRecord } from '@/lib/geo/outreach/outreach-store';
import OutreachActionCards from '../OutreachActionCards';
import { useUiLanguage } from '../UiLanguageContext';
import type { OutreachModalState } from './studio-format';

type StudioOutreachDialogProps = {
  outreachDialogRef: MutableRefObject<HTMLDialogElement | null>;
  setOutreachModal: Dispatch<SetStateAction<OutreachModalState>>;
  outreachModal: OutreachModalState;
  externalPackTitle: string;
  projectId: string;
  modalOutreachItems: OutreachActionRecord[];
  setOutreachActions: Dispatch<SetStateAction<OutreachActionRecord[]>>;
  notice: string;
  error: string;
  setError: Dispatch<SetStateAction<string>>;
  setNotice: Dispatch<SetStateAction<string>>;
};

export function StudioOutreachDialog({
  outreachDialogRef,
  setOutreachModal,
  outreachModal,
  externalPackTitle,
  projectId,
  modalOutreachItems,
  setOutreachActions,
  notice,
  error,
  setError,
  setNotice,
}: StudioOutreachDialogProps) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
    <dialog
      ref={outreachDialogRef}
      className="oap-clean-modal"
      aria-labelledby="oap-outreach-modal-title"
      onClose={() => setOutreachModal(null)}
      onClick={(e) => {
        if (e.target === outreachDialogRef.current) setOutreachModal(null);
      }}
    >
      {outreachModal && (
        <>
          <header className="oap-modal-head">
            <div className="oap-modal-head-copy">
              <h2 id="oap-outreach-modal-title">
                {outreachModal.mode === 'external_pack'
                  ? externalPackTitle
                  : outreachModal.mode === 'external_item'
                    ? isEn
                      ? 'External Citation Outreach'
                      : '外部引用渠道详情'
                    : isEn
                      ? 'Community Reply Draft'
                      : '社区补充回复草稿'}
              </h2>
              <p>
                {outreachModal.mode === 'external_pack'
                  ? isEn
                    ? 'Inspect each entry, copy the draft if needed, and open the target URL directly.'
                    : '逐项查看原因与草稿：先打开原网页确认，再按需复制文案。'
                  : outreachModal.mode === 'external_item'
                    ? isEn
                      ? 'Open the cited page first to see what it covers, then copy or edit the note below.'
                      : '先点「打开原文章/目录页」看清网页内容，觉得合适再复制或微调下方文案。'
                    : isEn
                      ? 'Edit freely, copy the draft, and open the thread directly in a new tab.'
                      : '可先微调措辞，点「复制草稿」后再点「打开原帖」去评论区发布。'}
              </p>
            </div>
            <button
              type="button"
              className="oap-modal-close-btn"
              aria-label={isEn ? 'Close' : '关闭'}
              onClick={() => setOutreachModal(null)}
            >
              <X size={15} />
              <span>{isEn ? 'Close' : '关闭'}</span>
            </button>
          </header>

          {error && (
            <div className="oap-modal-alert is-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => setError('')}>
                {isEn ? 'Dismiss' : '知道了'}
              </button>
            </div>
          )}

          {notice && (
            <div className="oap-modal-alert is-success" role="status">
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice('')}>
                {isEn ? 'Dismiss' : '知道了'}
              </button>
            </div>
          )}

          <div className="oap-modal-body oap-modal-outreach-pad">
            <OutreachActionCards
              projectId={projectId}
              lang={uiLanguage}
              actions={modalOutreachItems}
              loading={false}
              highlightFirst={outreachModal.mode === 'external_pack'}
              onActionsUpdated={(nextActions) => {
                setOutreachActions(nextActions);
                const stillLeft =
                  outreachModal.mode === 'community_item' ||
                  outreachModal.mode === 'external_item'
                    ? nextActions.some(
                        (a) =>
                          a.id === outreachModal.actionId &&
                          a.status !== 'completed' &&
                          a.status !== 'skipped',
                      )
                    : nextActions.some(
                        (a) =>
                          a.kind !== 'community_post' &&
                          a.status !== 'completed' &&
                          a.status !== 'skipped',
                      );
                if (!stillLeft) setOutreachModal(null);
              }}
              onError={setError}
              onNotice={setNotice}
            />
          </div>
        </>
      )}
    </dialog>
  );
}
