'use client';

import { X } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { useUiLanguage } from '../UiLanguageContext';

export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = previous;
    };
  }, [onClose]);
  return (
    <div className="og-modal-backdrop" onClick={onClose}>
      <section
        className={`og-modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button
            className="og-icon-button"
            onClick={onClose}
            aria-label={isEn ? 'Close' : '关闭'}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
