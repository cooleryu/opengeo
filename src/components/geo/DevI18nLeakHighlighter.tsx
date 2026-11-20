'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useUiLanguage } from './UiLanguageContext';

const SESSION_KEY = 'opengeo:i18n-check';
const HAN_RE = /\p{Script=Han}/u;
const URL_OR_DOMAIN_RE =
  /https?:\/\/\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?\b/gi;
const LATIN_WORD_RE = /\b[A-Za-z]{3,}\b/g;

function readHighlighterActive(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  const param = params.get('i18n-check');
  if (param === '1') {
    window.sessionStorage.setItem(SESSION_KEY, '1');
    return true;
  }
  if (param === '0') {
    window.sessionStorage.removeItem(SESSION_KEY);
    return false;
  }
  return window.sessionStorage.getItem(SESSION_KEY) === '1';
}

function subscribePopstate(cb: () => void): () => void {
  window.addEventListener('popstate', cb);
  return () => window.removeEventListener('popstate', cb);
}

// Allowlisted technical / brand terms allowed inside ZH UI (spec §2.2)
const ZH_LATIN_ALLOWLIST = new Set([
  'opengeo',
  'chatgpt',
  'google',
  'gemini',
  'deepseek',
  'openai',
  'github',
  'chrome',
  'api',
  'url',
  'urls',
  'readme',
  'markdown',
  'overview',
  'overviews',
  'key',
  'keys',
  'agent',
  'token',
  'umami',
  'english',
]);

interface LeakItem {
  text: string;
  selector: string;
  kind: string;
}

function shortSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls =
    typeof el.className === 'string' && el.className.trim()
      ? `.${el.className
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .join('.')}`
      : '';
  return `${tag}${id}${cls}`;
}

function normalizeLangPrefix(lang: string): 'en' | 'zh' | null {
  const lower = lang.trim().toLowerCase();
  if (!lower) return null;
  if (lower.startsWith('zh')) return 'zh';
  if (lower.startsWith('en')) return 'en';
  return null;
}

function isSkippedElement(el: Element | null, uiLang: 'en' | 'zh'): boolean {
  let curr: Element | null = el;
  while (curr && curr !== document.documentElement) {
    const tag = curr.tagName;
    if (tag === 'CODE' || tag === 'PRE' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
      return true;
    }
    if (curr.hasAttribute('data-i18n-skip')) return true;
    const explicitLang = curr.getAttribute('lang');
    if (explicitLang) {
      const normalized = normalizeLangPrefix(explicitLang);
      if (normalized && normalized !== uiLang) return true;
    }
    curr = curr.parentElement;
  }
  return false;
}

function findLeakText(raw: string, uiLang: 'en' | 'zh'): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (uiLang === 'en') {
    return HAN_RE.test(trimmed) ? trimmed.slice(0, 80) : null;
  }
  const stripped = trimmed.replace(URL_OR_DOMAIN_RE, ' ');
  const matches = stripped.match(LATIN_WORD_RE);
  if (!matches) return null;
  const stray = matches.filter((w) => !ZH_LATIN_ALLOWLIST.has(w.toLowerCase()));
  return stray.length > 0 ? `${stray.slice(0, 4).join(', ')} — ${trimmed.slice(0, 60)}` : null;
}

function DevI18nLeakHighlighterInner() {
  const { uiLanguage } = useUiLanguage();
  const active = useSyncExternalStore(subscribePopstate, readHighlighterActive, () => false);
  const [leaks, setLeaks] = useState<LeakItem[]>([]);
  const [scanMs, setScanMs] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    if (!active || typeof document === 'undefined') return;

    const styleId = 'opengeo-dev-i18n-leak-style';
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      styleEl.textContent = '[data-i18n-leak="1"] { outline: 2px dashed #dc2626 !important; outline-offset: 1px; }';
      document.head.appendChild(styleEl);
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearMarks = () => {
      document.querySelectorAll('[data-i18n-leak="1"]').forEach((el) => {
        el.removeAttribute('data-i18n-leak');
      });
    };

    const runScan = () => {
      const start = performance.now();
      clearMarks();
      const found: LeakItem[] = [];
      const marked = new Set<Element>();

      // 1. Text nodes
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const parent = node.parentElement;
        if (parent && !isSkippedElement(parent, uiLanguage)) {
          const tag = parent.tagName;
          if (tag !== 'TEXTAREA' && tag !== 'OPTION') {
            const hit = findLeakText(node.nodeValue ?? '', uiLanguage);
            if (hit) {
              if (!marked.has(parent)) {
                parent.setAttribute('data-i18n-leak', '1');
                marked.add(parent);
              }
              found.push({ text: hit, selector: shortSelector(parent), kind: 'text' });
            }
          }
        }
        node = walker.nextNode();
      }

      // 2. Attributes: title, aria-label, placeholder, alt
      const attrEls = document.body.querySelectorAll('[title], [aria-label], [placeholder], [alt]');
      attrEls.forEach((el) => {
        if (isSkippedElement(el, uiLanguage)) return;
        for (const attr of ['title', 'aria-label', 'placeholder', 'alt']) {
          const val = el.getAttribute(attr);
          if (!val) continue;
          const hit = findLeakText(val, uiLanguage);
          if (hit) {
            if (!marked.has(el)) {
              el.setAttribute('data-i18n-leak', '1');
              marked.add(el);
            }
            found.push({ text: hit, selector: shortSelector(el), kind: attr });
          }
        }
      });

      const elapsed = Math.max(1, Math.round(performance.now() - start));
      setLeaks(found);
      setScanMs(elapsed);
    };

    const scheduleScan = (delay = 300) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(runScan, delay);
    };

    scheduleScan(0);
    const observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((m) => {
        if (m.type === 'attributes' && m.attributeName === 'data-i18n-leak') return false;
        const targetEl = m.target instanceof Element ? m.target : m.target.parentElement;
        return !targetEl?.closest('[data-i18n-skip]');
      });
      if (relevant) scheduleScan(300);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['title', 'aria-label', 'placeholder', 'alt', 'lang'],
    });

    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
      clearMarks();
    };
  }, [active, uiLanguage]);

  if (!active) return null;

  return (
    <div
      data-i18n-skip="true"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 99999,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
      }}
    >
      {panelOpen && (
        <div
          style={{
            marginBottom: 8,
            width: 380,
            maxHeight: 320,
            overflowY: 'auto',
            background: '#18181b',
            color: '#f4f4f5',
            borderRadius: 10,
            padding: 12,
            boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            First {Math.min(50, leaks.length)} of {leaks.length} leaks ({uiLanguage})
          </div>
          {leaks.length === 0 ? (
            <div style={{ color: '#4ade80' }}>Clean — 0 leaks found.</div>
          ) : (
            <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {leaks.slice(0, 50).map((item, idx) => (
                <li key={`${item.selector}-${idx}`} style={{ lineHeight: 1.4 }}>
                  <span style={{ color: '#fca5a5' }}>[{item.kind}]</span> {item.text}{' '}
                  <span style={{ color: '#a1a1aa' }}>({item.selector})</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          setPanelOpen((v) => !v);
          if (leaks.length > 0) {
            console.table(leaks.slice(0, 50));
          }
        }}
        style={{
          background: leaks.length > 0 ? '#dc2626' : '#15803d',
          color: '#ffffff',
          border: 'none',
          borderRadius: 999,
          padding: '6px 12px',
          fontWeight: 600,
          cursor: 'pointer',
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
        }}
      >
        i18n leaks: {leaks.length} · {scanMs}ms
      </button>
    </div>
  );
}

export default function DevI18nLeakHighlighter() {
  if (process.env.NODE_ENV === 'production') return null;
  return <DevI18nLeakHighlighterInner />;
}
