'use client';

import { createElement, useEffect, useId, useRef, useState } from 'react';
import Markdown from 'markdown-to-jsx';
import { ChevronDown, ChevronUp, LocateFixed } from 'lucide-react';

function safeLink(href?: string) {
  if (!href) return undefined;
  try {
    const url = new URL(href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export default function AnswerText({
  projectId,
  path,
  projectNames = [],
}: {
  projectId: string;
  path?: string;
  projectNames?: string[];
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  const [hasProjectMatch, setHasProjectMatch] = useState(false);
  const [locationRequest, setLocationRequest] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const id = useId();
  const namePattern = [...new Set(projectNames.map((name) => name.trim()))]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map((name) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return `${/^[a-z0-9_]/i.test(name) ? '(?<![a-z0-9_])' : ''}${escaped}${/[a-z0-9_]$/i.test(name) ? '(?![a-z0-9_])' : ''}`;
    })
    .join('|');

  // Match only rendered text children; Markdown syntax and link targets stay intact.
  const markProjectNames = (node: React.ReactNode): React.ReactNode => {
    if (Array.isArray(node)) return node.map(markProjectNames);
    if (typeof node !== 'string' || !namePattern) return node;
    const parts: React.ReactNode[] = [];
    let offset = 0;
    for (const match of node.matchAll(new RegExp(namePattern, 'giu'))) {
      if (match.index > offset) parts.push(node.slice(offset, match.index));
      parts.push(
        <span
          key={match.index}
          className={`rw-answer-project-match${locationRequest ? ' is-highlighted' : ''}`}
        >
          {match[0]}
        </span>,
      );
      offset = match.index + match[0].length;
    }
    if (!parts.length) return node;
    parts.push(node.slice(offset));
    return parts;
  };

  useEffect(() => {
    const controller = new AbortController();
    setContent(null);
    setError('');
    setExpanded(false);
    setLong(false);
    setHasProjectMatch(false);
    setLocationRequest(0);
    setLoading(!!path);
    if (!path) return () => controller.abort();
    const params = new URLSearchParams({
      project: projectId,
      path,
      view: 'answer',
    });
    void fetch(`/api/geo/evidence?${params}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '回答暂时无法读取。');
        if (!controller.signal.aborted) {
          setContent(
            result.status === 'available' && typeof result.content === 'string'
              ? result.content
              : null,
          );
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : '回答暂时无法读取。',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, path]);

  useEffect(() => {
    if (!body.current) return;
    const update = () => setLong((body.current?.scrollHeight ?? 0) > 420);
    const observer = new ResizeObserver(update);
    observer.observe(body.current);
    update();
    return () => observer.disconnect();
  }, [content, loading]);

  useEffect(() => {
    setHasProjectMatch(
      !!body.current?.querySelector('.rw-answer-project-match'),
    );
    setLocationRequest(0);
  }, [content, namePattern, loading]);

  useEffect(() => {
    if (!locationRequest) return;
    body.current
      ?.querySelector('.rw-answer-project-match')
      ?.scrollIntoView({ block: 'center' });
  }, [locationRequest]);

  return (
    <section className="rw-answer-text" ref={section} aria-label="回答原文">
      <div className="rw-answer-header">
        <h3>回答</h3>
        {!loading && !error && content && hasProjectMatch && (
          <button
            type="button"
            className="rw-answer-locate"
            aria-controls={id}
            onClick={() => {
              setExpanded(true);
              setLocationRequest((request) => request + 1);
            }}
          >
            <LocateFixed size={14} aria-hidden="true" />
            定位项目名称
          </button>
        )}
      </div>
      {loading ? (
        <p className="rw-answer-placeholder" role="status">
          正在读取回答…
        </p>
      ) : error ? (
        <p className="rw-answer-placeholder" role="alert">
          {error}
        </p>
      ) : !content ? (
        <p className="rw-answer-placeholder">这条记录尚未保存回答正文。</p>
      ) : (
        <>
          <div
            className={`rw-answer-excerpt${!expanded && long ? ' is-clipped' : ''}`}
            id={id}
          >
            <div className="rw-answer-prose" ref={body}>
              <Markdown
                options={{
                  disableParsingRawHTML: true,
                  createElement: (tag, props, ...children) =>
                    createElement(
                      tag,
                      props,
                      ...children.map(markProjectNames),
                    ),
                  overrides: {
                    a: {
                      component: ({
                        href,
                        children,
                      }: {
                        href?: string;
                        children: React.ReactNode;
                      }) => {
                        const link = safeLink(href);
                        return link ? (
                          <a
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {children}
                          </a>
                        ) : (
                          <span>{children}</span>
                        );
                      },
                    },
                    img: {
                      component: ({
                        src,
                        alt,
                      }: {
                        src?: string;
                        alt?: string;
                      }) => {
                        const link = safeLink(src);
                        return link ? (
                          <a
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {markProjectNames(alt || '查看图片')}
                          </a>
                        ) : null;
                      },
                    },
                  },
                }}
              >
                {content}
              </Markdown>
            </div>
          </div>
          {long && (
            <button
              className="rw-answer-expand"
              aria-expanded={expanded}
              aria-controls={id}
              onClick={() => {
                if (expanded)
                  section.current?.scrollIntoView({ block: 'start' });
                setExpanded(!expanded);
              }}
            >
              {expanded ? '收起全文' : '展开全文'}{' '}
              {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
          )}
        </>
      )}
    </section>
  );
}
