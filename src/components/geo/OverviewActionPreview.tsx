'use client';

import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import './overview-action-preview.css';

type Props = {
  question: string;
  action: string;
  onClose: () => void;
};

const previewSteps = [
  '核对现有内容与回答依据',
  '补齐缺口并完成独立审核',
  '实施后按同题条件观察效果',
];

export default function OverviewActionPreview({
  question,
  action,
  onClose,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backdropPointerDown = useRef(false);
  const titleId = useId();
  const noticeId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = 'hidden';

    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  const isOutside = (clientX: number, clientY: number) => {
    const bounds = dialogRef.current?.getBoundingClientRect();
    return (
      !!bounds &&
      (clientX < bounds.left ||
        clientX > bounds.right ||
        clientY < bounds.top ||
        clientY > bounds.bottom)
    );
  };

  return (
    <dialog
      ref={dialogRef}
      className="pov-action-preview"
      aria-labelledby={titleId}
      aria-describedby={noticeId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        backdropPointerDown.current = isOutside(event.clientX, event.clientY);
      }}
      onClick={(event) => {
        if (
          backdropPointerDown.current &&
          isOutside(event.clientX, event.clientY)
        ) {
          onClose();
        }
        backdropPointerDown.current = false;
      }}
    >
      <header className="pov-action-preview-header">
        <div className="pov-action-preview-heading">
          <h2 id={titleId} className="pov-action-preview-title">
            改进方案
          </h2>
          <span className="pov-action-preview-badge">样式预览</span>
        </div>
        <button
          type="button"
          className="pov-action-preview-close"
          onClick={onClose}
          aria-label="关闭改进方案预览"
        >
          <X size={19} strokeWidth={1.7} aria-hidden="true" />
        </button>
      </header>

      <div className="pov-action-preview-content">
        <blockquote className="pov-action-preview-question">
          {question}
        </blockquote>
        <h3 className="pov-action-preview-action">{action}</h3>
        <ol className="pov-action-preview-steps">
          {previewSteps.map((step, index) => (
            <li key={step}>
              <span className="pov-action-preview-number" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <p id={noticeId} className="pov-action-preview-notice">
          以下为交互示意，不代表已生成或审核的真实方案。
        </p>
      </div>

      <footer className="pov-action-preview-footer">
        <button
          type="button"
          className="pov-action-preview-return"
          onClick={onClose}
        >
          返回概览
        </button>
      </footer>
    </dialog>
  );
}
