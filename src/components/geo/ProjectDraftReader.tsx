'use client';

import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { X } from 'lucide-react';
import Markdown from 'markdown-to-jsx';
import { useRef, useState, type ReactNode } from 'react';
import { draftPreviewOptions } from './draft-preview';
import { projectDraftDocuments } from './project-draft-preview';

export default function ProjectDraftReader({
  title, change, repositoryUrl, onClose, children,
}: {
  title: string;
  change: string;
  repositoryUrl?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const documents = projectDraftDocuments(change);
  const [selected, setSelected] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const current = documents[selected];
  const sourceUrl = repositoryUrl && current.filename
    ? `${repositoryUrl.replace(/\.git$|\/$/g, '')}/blob/main/${current.filename}`
    : undefined;

  return (
    <Dialog open onClose={onClose} initialFocus={close} className="og-draft-modal">
      <div className="og-draft-backdrop" aria-hidden="true" />
      <div className="og-draft-position">
        <DialogPanel className="og-draft-reader">
          <header className="og-draft-reader-heading">
            <div>
              <span className="og-draft-reader-eyebrow">稿件预览</span>
              <DialogTitle>{title}</DialogTitle>
            </div>
            <button ref={close} type="button" className="og-draft-close" onClick={onClose} aria-label="关闭稿件预览">
              <X size={18} aria-hidden="true" /> <span>关闭</span>
            </button>
          </header>
          <div className="og-draft-reader-toolbar">
            {documents.length > 1 ? (
              <div className="og-draft-languages" aria-label="稿件语言">
                {documents.map((document, index) => (
                  <button type="button" key={document.label} aria-pressed={selected === index}
                    onClick={() => { setSelected(index); scroll.current?.scrollTo({ top: 0 }); }}>
                    {document.label}
                  </button>
                ))}
              </div>
            ) : <span>文章全文</span>}
            <span>{current.partial ? '修改后的段落 · 待你确认' : '待你确认'}</span>
          </div>
          <div className="og-draft-reader-scroll" ref={scroll}>
            <div className="og-draft-reader-content">
              <article className="og-markdown og-draft-prose" lang={current.label === 'English' ? 'en' : 'zh-CN'}>
                <Markdown options={draftPreviewOptions(sourceUrl)}>{current.content}</Markdown>
              </article>
              <details className="og-draft-supporting">
                <summary>为什么建议这样改</summary>
                {children}
              </details>
              <details className="og-draft-supporting">
                <summary>修改位置与完整原稿</summary>
                <pre className="og-draft-source">{change}</pre>
              </details>
            </div>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
