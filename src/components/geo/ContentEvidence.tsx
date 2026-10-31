'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Markdown from 'markdown-to-jsx';
import { ChevronDown, FileText } from 'lucide-react';

export function contentWebUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Reads only the existing, project-scoped evidence API on expansion. */
export default function ContentEvidence({
  projectId,
  path,
  label,
}: {
  projectId: string;
  path: string;
  label?: string;
}) {
  const [document, setDocument] = useState<{
    content: string;
    format: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function load() {
    if (document || loading) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ project: projectId, path });
      const response = await fetch('/api/geo/evidence?' + params, {
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '这份材料暂时无法读取');
      setDocument(result);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : '读取失败');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return (
    <details
      className="ka-evidence"
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary>
        <FileText size={15} />
        <span>{label || '查看原始材料'}</span>
        <ChevronDown size={14} />
      </summary>
      <div className="ka-evidence-body">
        <small className="ka-path">{path}</small>
        {loading && <p role="status">正在读取已保存的材料…</p>}
        {error && (
          <p role="alert">
            {error} <button onClick={() => void load()}>重试</button>
          </p>
        )}
        {document &&
          (document.format === 'markdown' ? (
            <Markdown
              options={{
                disableParsingRawHTML: true,
                overrides: {
                  a: {
                    component: ({
                      href,
                      children,
                    }: {
                      href?: string;
                      children?: ReactNode;
                    }) =>
                      contentWebUrl(href) ? (
                        <a
                          href={contentWebUrl(href)!}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {children}
                        </a>
                      ) : (
                        <span>{children}</span>
                      ),
                  },
                },
              }}
            >
              {document.content}
            </Markdown>
          ) : (
            <pre>{document.content}</pre>
          ))}
      </div>
    </details>
  );
}
