import { createElement, Fragment } from 'react';
import type { MarkdownToJSX } from 'markdown-to-jsx';

const readableTags = new Set([
  'a', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'hr', 'img', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong',
  'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
]);

function previewUrl(value: unknown, sourceUrl?: string, image = false) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value, sourceUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    if (image && url.hostname === 'github.com') {
      const parts = url.pathname.split('/');
      if (parts[3] === 'blob') {
        url.hostname = 'raw.githubusercontent.com';
        parts.splice(3, 1);
        url.pathname = parts.join('/');
      }
    }
    return url.href;
  } catch {
    return undefined;
  }
}

/** Readable preview only; copying, editing and review digests keep the original text. */
export function draftPreviewOptions(sourceUrl?: string): MarkdownToJSX.Options {
  return {
    createElement(tag, props, ...children) {
      if (tag === Fragment)
        return createElement(Fragment, { key: props?.key }, ...children);
      if (typeof tag !== 'string' || !readableTags.has(tag)) return null;
      const input = (props ?? {}) as Record<string, unknown>;
      // Never forward raw HTML attributes, styles, event handlers or injected markup.
      const safe: Record<string, unknown> = { key: props?.key };
      if (tag === 'a') {
        safe.href = previewUrl(input.href, sourceUrl);
        safe.target = '_blank';
        safe.rel = 'noopener noreferrer';
      }
      if (tag === 'img') {
        safe.src = previewUrl(input.src, sourceUrl, true);
        safe.alt = typeof input.alt === 'string' ? input.alt : '';
        safe.loading = 'lazy';
        if (!safe.src) return createElement('span', { key: props?.key }, safe.alt as string);
      }
      return createElement(tag, safe, ...children);
    },
  };
}
