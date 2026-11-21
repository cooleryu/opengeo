'use client';

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { QuestionGenerationProgress } from '@/lib/geo/question-types';
import type { GeoAsset, GeoState } from '@/lib/geo/types';
import QuestionPlanPanel from '../QuestionPlanPanel';
import { useUiLanguage } from '../UiLanguageContext';
import { Modal } from './Modal';
import type { Page } from './pages';

/** Which setup pop-up is open over the page (`?setup=questions`). */
export type Dialog = 'questions' | null;

type QuestionSetupDialogProps = {
  setDialog: Dispatch<SetStateAction<Dialog>>;
  data: GeoState;
  busy: string;
  questionGenerationProgress: QuestionGenerationProgress | undefined;
  setAsset: Dispatch<SetStateAction<GeoAsset | null>>;
  openModelSettings: () => void;
  act: (action: string, payload?: Record<string, unknown>, message?: string) => Promise<GeoState | null>;
  actionError: MutableRefObject<string>;
  projectId: string;
  questionRequest: MutableRefObject<{ key: string; id: string } | null>;
  navigate: (nextPage: Page, taskId?: string, batchId?: string, hash?: string) => void;
};

export function QuestionSetupDialog({
  setDialog,
  data,
  busy,
  questionGenerationProgress,
  setAsset,
  openModelSettings,
  act,
  actionError,
  projectId,
  questionRequest,
  navigate,
}: QuestionSetupDialogProps) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
    <Modal
      title={isEn ? 'How buyers ask AI' : '用户会怎么问'}
      onClose={() => setDialog(null)}
    >
      <div className="og-question-editor">
        <QuestionPlanPanel
          plan={data.questionPlan}
          assets={data.assets}
          modelConfigured={data.settings.questionModelConfigured ?? data.settings.modelConfigured}
          busy={!!busy}
          generationProgress={questionGenerationProgress}
          generationJob={data.questionGeneration}
          onAsset={setAsset}
          onConfigureModel={() => openModelSettings()}
          onAuditCandidate={async (candidateId) => {
            const result = await act(
              'audit_question',
              {
                candidateId,
                planId: data.questionPlan.id,
                revision: data.questionPlan.revision,
              },
              isEn
                ? 'Re-evaluated this question'
                : '已重新评估这个问题',
            );
            if (!result) {
              throw new Error(
                actionError.current ||
                  (isEn
                    ? 'Evaluation did not finish. Please try again.'
                    : '评估未完成，请重试。'),
              );
            }
          }}
          onGenerate={async (positioning) => {
            const key = `${projectId}:${data.questionPlan.id}:${data.questionPlan.revision}:${positioning}`;
            if (questionRequest.current?.key !== key) {
              // A ref owned by OpenGeoApp: keeps one request id per plan revision across renders.
              // eslint-disable-next-line react-hooks/immutability
              questionRequest.current = { key, id: crypto.randomUUID() };
            }
            const result = await act(
              'start_question_generation',
              {
                positioning,
                planId: data.questionPlan.id,
                revision: data.questionPlan.revision,
                requestId: questionRequest.current.id,
              },
              isEn
                ? 'Preparing buyer questions in the background'
                : '正在后台准备问题',
            );
            if (!result) {
              throw new Error(
                actionError.current ||
                  (isEn
                    ? 'Question generation did not finish. Please try again.'
                    : '生成未完成，请重试。'),
              );
            }
            questionRequest.current = null;
          }}
          onToggle={async (candidateId, selected) => {
            await act(
              'select_question',
              {
                candidateId,
                selected,
                planId: data.questionPlan.id,
                revision: data.questionPlan.revision,
              },
              isEn ? 'Question selection saved' : '已保存所选问题',
            );
          }}
          onConfirm={async () => {
            await act(
              'confirm_questions',
              {
                planId: data.questionPlan.id,
                revision: data.questionPlan.revision,
              },
              isEn
                ? 'Confirmed buyer questions to track'
                : '已确认要监测的问题',
            );
          }}
          onContinue={() => navigate('tasks')}
        />
      </div>
    </Modal>
  );
}
