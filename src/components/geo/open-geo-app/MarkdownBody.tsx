'use client';

import Markdown from 'markdown-to-jsx';
import type { ReactNode } from 'react';

export function MarkdownBody({
  content,
  evidencePath,
  onEvidence,
}: {
  content: string;
  evidencePath?: string;
  onEvidence?: (path: string) => void;
}) {
  return (
    <div className="og-markdown">
      <Markdown
        options={{
          disableParsingRawHTML: true,
          overrides: {
            a: {
              component: ({
                href = '',
                children,
              }: {
                href?: string;
                children?: ReactNode;
              }) => {
                if (
                  evidencePath &&
                  onEvidence &&
                  href &&
                  !href.startsWith('#') &&
                  !/^[a-z][a-z0-9+.-]*:/i.test(href) &&
                  !href.startsWith('//')
                ) {
                  const resolved = new URL(
                    href,
                    `https://local-evidence.invalid/${evidencePath}`,
                  ).pathname.slice(1);
                  return (
                    <button
                      className="og-text-button"
                      onClick={() => onEvidence(decodeURIComponent(resolved))}
                    >
                      {children}
                    </button>
                  );
                }
                return (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                );
              },
            },
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
