'use client';

import { createElement, useEffect, useId, useRef, useState } from 'react';
import Markdown from 'markdown-to-jsx';
import { ChevronDown, ChevronUp, LocateFixed } from 'lucide-react';
import { useUiLanguage } from './UiLanguageContext';

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
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const requestKey = path ? `${projectId}:${path}` : '';
  const [loaded, setLoaded] = useState<{
    key: string;
    content: string | null;
    error: string;
  }>({ key: '', content: null, error: '' });
  const isCurrent = Boolean(requestKey) && loaded.key === requestKey;
  const loading = Boolean(path) && !isCurrent;
  const content = isCurrent ? loaded.content : null;
  const error = isCurrent ? loaded.error : '';
  const [long, setLong] = useState(false);
  const [hasProjectMatch, setHasProjectMatch] = useState(false);
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
  const matchKey = `${requestKey}::${namePattern}`;
  const [uiState, setUiState] = useState<{
    key: string;
    expanded: boolean;
    locationRequest: number;
  }>({ key: '', expanded: false, locationRequest: 0 });
  const expanded = uiState.key === matchKey ? uiState.expanded : false;
  const locationRequest = uiState.key === matchKey ? uiState.locationRequest : 0;

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
    if (!path) return;
    const controller = new AbortController();
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
          setLoaded({
            key: requestKey,
            content:
              result.status === 'available' && typeof result.content === 'string'
                ? result.content
                : null,
            error: '',
          });
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setLoaded({
            key: requestKey,
            content: null,
            error: reason instanceof Error ? reason.message : '回答暂时无法读取。',
          });
        }
      });
    return () => controller.abort();
  }, [projectId, path, requestKey]);

  useEffect(() => {
    if (!body.current) return;
    const update = () => {
      setLong((body.current?.scrollHeight ?? 0) > 420);
      setHasProjectMatch(Boolean(body.current?.querySelector('.rw-answer-project-match')));
    };
    const observer = new ResizeObserver(update);
    observer.observe(body.current);
    update();
    return () => observer.disconnect();
  }, [content, namePattern, loading]);

  useEffect(() => {
    if (!locationRequest) return;
    body.current
      ?.querySelector('.rw-answer-project-match')
      ?.scrollIntoView({ block: 'center' });
  }, [locationRequest]);

  return (
    <section className="rw-answer-text" ref={section} aria-label={isEn ? 'Answer body' : '回答原文'}>
      <div className="rw-answer-header">
        <h3>{isEn ? 'Answer' : '回答'}</h3>
        {!loading && !error && Boolean(content && namePattern) && hasProjectMatch && (
          <button
            type="button"
            className="rw-answer-locate"
            aria-controls={id}
            onClick={() => {
              setUiState((prev) => ({
                key: matchKey,
                expanded: true,
                locationRequest: (prev.key === matchKey ? prev.locationRequest : 0) + 1,
              }));
            }}
          >
            <LocateFixed size={14} aria-hidden="true" />
            {isEn ? 'Highlight brand' : '定位项目名称'}
          </button>
        )}
      </div>
      {loading ? (
        <p className="rw-answer-placeholder" role="status">
          {isEn ? 'Loading answer…' : '正在读取回答…'}
        </p>
      ) : error ? (
        <p className="rw-answer-placeholder" role="alert">
          {error}
        </p>
      ) : !content ? (
        <p className="rw-answer-placeholder">
          {isEn ? 'No saved answer body for this record yet.' : '这条记录尚未保存回答正文。'}
        </p>
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
                setUiState((prev) => ({
                  key: matchKey,
                  expanded: !expanded,
                  locationRequest: prev.key === matchKey ? prev.locationRequest : 0,
                }));
              }}
            >
              {expanded ? (isEn ? 'Show less' : '收起全文') : (isEn ? 'Read full answer' : '展开全文')}{' '}
              {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
          )}
        </>
      )}
    </section>
  );
}
