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
                  : isEn
                    ? 'Community Post Draft'
                    : '社区补充草稿'}
              </h2>
              <p>
                {outreachModal.mode === 'external_pack'
                  ? isEn
                    ? 'Inspect and edit each entry before submitting PRs or opening directory forms.'
                    : '提交前可逐项核对或微调插入行与提交材料，一切由你确认后才发出。'
                  : isEn
                    ? 'Edit freely, copy to clipboard, and open the target page.'
                    : '可按需微调措辞，一键复制并打开目标页面。'}
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
                  outreachModal.mode === 'community_item'
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
