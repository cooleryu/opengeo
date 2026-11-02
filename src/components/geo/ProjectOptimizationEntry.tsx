'use client';

import { useState } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import {
  ArrowRight,
  Check,
  Compass,
  Layers3,
  Loader2,
  Target,
  X,
} from 'lucide-react';
import type { GeoTask } from '@/lib/geo/types';
import type { ProjectOptimizationMode } from '@/lib/geo/project-optimization-types';
import { getProjectOptimizationProgress } from './project-optimization-progress';
import './project-optimization-entry.css';

type Props = {
  projectName: string;
  questionCount: number;
  activeTask?: GeoTask;
  onStart: (mode: ProjectOptimizationMode) => Promise<void>;
  onContinue: (taskId: string) => void;
  onQuestions: () => void;
};

export default function ProjectOptimizationEntry({
  projectName,
  questionCount,
  activeTask,
  onStart,
  onContinue,
  onQuestions,
}: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ProjectOptimizationMode>('focus');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const progress = activeTask?.projectOptimization
    ? getProjectOptimizationProgress(activeTask.projectOptimization)
    : null;

  const begin = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await onStart(mode);
      setOpen(false);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : '暂时无法开始，请重试。',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="po-entry">
        <div className="po-entry-heading">
          <span>项目优化</span>
          <span>{questionCount} 个监测问题</span>
        </div>
        <div className="po-entry-content">
          <div className="po-entry-copy">
            <h3>
              {progress?.label || '下一步，改善你的项目表现'}
              {progress?.roundLabel && (
                <span className="po-entry-round">{progress.roundLabel}</span>
              )}
            </h3>
            <p role={activeTask ? 'status' : undefined}>
              {progress?.message ||
                '综合已有回答与内容，找到值得优先做的改进。'}
            </p>
            <button
              className="po-primary"
              disabled={!activeTask && !questionCount}
              onClick={() => {
                if (activeTask) onContinue(activeTask.id);
                else {
                  setMode('focus');
                  setError('');
                  setOpen(true);
                }
              }}
            >
              {progress?.actionLabel || '开始优化'}
              <ArrowRight size={19} />
            </button>
            {!activeTask && !questionCount && (
              <p className="po-entry-empty">先添加需要监测的问题。</p>
            )}
          </div>
          <div className="po-entry-art" aria-hidden="true">
            <span />
            <span />
            <div>
              <Target size={44} strokeWidth={1.3} />
            </div>
          </div>
        </div>
        <button className="po-evidence-link" onClick={onQuestions}>
          查看问题与依据
          <ArrowRight size={15} />
        </button>
      </div>

      <Dialog
        open={open}
        onClose={() => {
          if (!submitting) setOpen(false);
        }}
        className="po-modal"
      >
        <div className="po-backdrop" aria-hidden="true" />
        <div className="po-modal-position">
          <DialogPanel className="po-dialog">
            <header>
              <div>
                <DialogTitle>选择优化方式</DialogTitle>
                <p>
                  {projectName} · 全部 {questionCount} 个监测问题
                </p>
              </div>
              <button
                className="po-close"
                aria-label="关闭优化方式选择"
                disabled={submitting}
                onClick={() => setOpen(false)}
              >
                <X size={20} />
              </button>
            </header>
            <fieldset disabled={submitting} className="po-mode-options">
              <legend className="sr-only">优化方式</legend>
              <label
                className={`po-mode po-mode-focus ${mode === 'focus' ? 'is-selected' : ''}`}
              >
                <input
                  type="radio"
                  name="project-optimization-mode"
                  aria-label="重点优化"
                  value="focus"
                  checked={mode === 'focus'}
                  onChange={() => setMode('focus')}
                  autoFocus
                />
                <span className="po-mode-icon">
                  <Target size={25} />
                </span>
                <span className="po-mode-copy">
                  <span className="po-mode-title">
                    重点优化 <small>推荐</small>
                  </span>
                  <span>优先解决最值得改善的问题</span>
                </span>
                <span className="po-radio" aria-hidden="true">
                  {mode === 'focus' && <Check size={14} />}
                </span>
              </label>
              <label
                className={`po-mode po-mode-deep ${mode === 'deep' ? 'is-selected' : ''}`}
              >
                <input
                  type="radio"
                  name="project-optimization-mode"
                  aria-label="深度优化"
                  value="deep"
                  checked={mode === 'deep'}
                  onChange={() => setMode('deep')}
                />
                <span className="po-mode-icon">
                  <Layers3 size={20} />
                </span>
                <span className="po-mode-copy">
                  <span className="po-mode-title">深度优化</span>
                  <span>全面排查，形成更完整的改进方案</span>
                  <span className="po-mode-cost">耗时与 Token 消耗更多</span>
                </span>
                <span className="po-radio" aria-hidden="true">
                  {mode === 'deep' && <Check size={14} />}
                </span>
              </label>
            </fieldset>
            <p className="po-shared-goal">
              （均以真实提升 AI 提及率和自有内容引用率为目标。）
            </p>
            {error && (
              <p className="po-start-error" role="alert">
                {error}
              </p>
            )}
            <footer>
              <p>
                <Compass size={14} />
                基于已保存的回答与内容
              </p>
              <button
                className="po-primary"
                disabled={submitting}
                onClick={() => void begin()}
              >
                {submitting ? (
                  <>
                    <Loader2 size={17} className="animate-spin" />
                    正在创建任务
                  </>
                ) : (
                  <>
                    生成优化方案
                    <ArrowRight size={17} />
                  </>
                )}
              </button>
            </footer>
          </DialogPanel>
        </div>
      </Dialog>
    </>
  );
}
