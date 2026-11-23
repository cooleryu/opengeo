'use client';

import { useState } from 'react';
import { ArrowUp, CheckCircle2, ExternalLink, Globe, Info, Loader2, Lock } from 'lucide-react';
import type {
  ActionBoardCard,
  CommunityReplyPayload,
  OutreachEmailPayload,
} from '@/lib/geo/optimization/action-board-catalog';
import type { ActionBoardMessageKey } from '@/lib/geo/optimization/action-board-messages';
import { cleanThreadTitle } from './ActionBoardCards';
import { CopyButton, PostedLink, PostZone, type BoardActions, type BoardText } from './action-board-shared';

function Tabs({ items, active, onPick }: { items: string[]; active: number; onPick: (i: number) => void }) {
  if (items.length < 2) return null;
  return (
    <div className="ab-tabs is-wide" role="tablist">
      {items.map((item, i) => (
        <button key={i} type="button" role="tab" aria-selected={i === active} className={i === active ? 'is-active' : ''} onClick={() => onPick(i)}>
          {item}
        </button>
      ))}
    </div>
  );
}

function Checklist({
  titleKey = 'msg.checklist',
  keys,
  text,
}: {
  titleKey?: ActionBoardMessageKey;
  keys: ActionBoardMessageKey[];
  text: BoardText;
}) {
  return (
    <div className="ab-checklist">
      <h3>{text.tk(titleKey)}</h3>
      <ul>
        {keys.map((key) => (
          <li key={key}>
            <span className="ab-rule-dot" aria-hidden="true" />
            <span>{text.tk(key)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const wordCount = (value: string) => value.split(/\s+/).filter(Boolean).length;

export function ReplyComposer({
  card,
  payload,
  actions,
  text,
}: {
  card: ActionBoardCard;
  payload: CommunityReplyPayload;
  actions: BoardActions;
  text: BoardText;
}) {
  const { tk, tn, pick } = text;
  const lang = actions.board.targetLanguage;
  const [active, setActive] = useState(0);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [readingUrl, setReadingUrl] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [pasting, setPasting] = useState(false);
  const thread = payload.threads[active] ?? payload.threads[0];
  if (!thread) return null;
  const body = bodies[thread.url] ?? thread.body;
  const disclosureText = thread.disclosure?.trim() || '';
  const bodyHasDisclosure =
    Boolean(disclosureText) &&
    (/\b(?:i|we)\s+(?:maintain|built|build|created|work on)\b/i.test(body) ||
      body.toLowerCase().includes(disclosureText.toLowerCase().slice(0, 24)));
  const full = bodyHasDisclosure || !disclosureText ? body.trim() : `${body.trim()}\n\n${disclosureText}`;
  const source = thread.source;
  const isReading = readingUrl === thread.url;

  const readInChrome = async () => {
    setReadingUrl(thread.url);
    try {
      const ok = await actions.onReadThreadBrowser(card.id, thread.url);
      if (ok) {
        setBodies((prev) => {
          const next = { ...prev };
          delete next[thread.url];
          return next;
        });
      }
    } finally {
      setReadingUrl(null);
    }
  };

  const submitPaste = async () => {
    if (pasteText.trim().length < 15) return;
    setPasting(true);
    try {
      const ok = await actions.onRedraftThreadText(card.id, thread.url, pasteText);
      if (ok) {
        setPasteText('');
        setBodies((prev) => {
          const next = { ...prev };
          delete next[thread.url];
          return next;
        });
      }
    } finally {
      setPasting(false);
    }
  };

  return (
    <div className="ab-msg">
      <Tabs items={payload.threads.map((t) => `${t.community}`)} active={active} onPick={setActive} />
      <div className="ab-msg-grid">
        <section className="ab-thread">
          <div className="ab-thread-head">
            <span className="ab-quote-src">
              {thread.platform} · {thread.community}
            </span>
            <a className="ab-link" href={thread.url} target="_blank" rel="noreferrer">
              <ExternalLink size={13} />
              {tk('msg.openThread')}
            </a>
          </div>
          <h3 className="ab-thread-title" lang={lang}>
            {cleanThreadTitle(thread.title, thread.community)}
          </h3>
          {source.status === 'fetched' ? (
            <>
              <span className="ab-source is-ok">
                <CheckCircle2 size={13} />
                {tk('msg.loaded')}
                {typeof source.commentCount === 'number' && <> · {tn('msg.comments', source.commentCount)}</>}
              </span>
              {source.locked && (
                <span className="ab-source is-warn">
                  <Lock size={13} />
                  {tk('msg.locked')}
                </span>
              )}
              <div className="ab-op">
                <span className="ab-field-label">
                  {tk('msg.op')}
                  {source.op?.author ? ` · u/${source.op.author}` : ''}
                </span>
                <p className="ab-pre" lang={lang}>
                  {source.op?.body || tk('msg.noBody')}
                </p>
              </div>
              {source.replies?.length ? (
                <div className="ab-replies">
                  <span className="ab-field-label">{tk('msg.topReplies')}</span>
                  {source.replies.map((reply, i) => (
                    <blockquote key={i} lang={lang}>
                      <span className="ab-reply-meta">
                        <ArrowUp size={11} />
                        {reply.score ?? 0}
                        {reply.author ? ` · ${reply.author}` : ''}
                      </span>
                      {reply.body}
                    </blockquote>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div className="ab-thread-unblock">
              <span className="ab-source is-warn">
                <Info size={13} />
                {tk('msg.titleOnly', { reason: tk(`msg.reason.${source.reason ?? 'error'}`) })}
              </span>
              <button
                type="button"
                className="ost-btn-secondary is-sm"
                disabled={isReading || pasting}
                onClick={() => void readInChrome()}
              >
                {isReading ? <Loader2 size={13} className="ost-spin" /> : <Globe size={13} />}
                <span>{tk(isReading ? 'msg.readingChrome' : 'msg.readInChrome')}</span>
              </button>
              <p className="ab-chrome-hint">{tk('msg.chromeHint')}</p>
              <details className="ab-paste-box">
                <summary>{tk('msg.pasteToggle')}</summary>
                <div className="ab-paste-form">
                  <textarea
                    className="ab-paste-input"
                    rows={4}
                    value={pasteText}
                    placeholder={tk('msg.pastePlaceholder')}
                    onChange={(e) => setPasteText(e.target.value)}
                  />
                  <button
                    type="button"
                    className="ost-btn-secondary is-sm"
                    disabled={pasting || isReading || pasteText.trim().length < 15}
                    onClick={() => void submitPaste()}
                  >
                    {pasting && <Loader2 size={13} className="ost-spin" />}
                    <span>{tk(pasting ? 'msg.redraftingThread' : 'msg.pasteSubmit')}</span>
                  </button>
                </div>
              </details>
            </div>
          )}
          <Checklist keys={['msg.check.read', 'msg.check.answer', 'msg.check.link', 'msg.check.disclose']} text={text} />
        </section>

        <section className="ab-composer">
          {thread.angle && (
            <div className="ab-angle-row">
              <span className="ab-field-label">{tk('msg.angleLabel')}</span>
              <span className="ab-angle">{pick(thread.angle)}</span>
            </div>
          )}
          <PostZone language={lang} actions={<span className="ab-fc-count">{tn('doc.words', wordCount(body))}</span>}>
            <textarea
              className="ab-textarea"
              value={body}
              aria-label={tk('msg.yourReply')}
              onChange={(e) => setBodies((prev) => ({ ...prev, [thread.url]: e.target.value }))}
            />
            {!bodyHasDisclosure && disclosureText && (
              <p className="ab-disclosure">
                <span className="ab-field-label">{tk('msg.disclosure')}</span>
                {disclosureText}
              </p>
            )}
          </PostZone>
        </section>
      </div>
      <footer className="ab-fc-foot">
        <button
          type="button"
          className="ost-btn-primary is-sm"
          onClick={() => {
            void navigator.clipboard.writeText(full).finally(() => window.open(thread.url, '_blank', 'noopener'));
          }}
        >
          <ExternalLink size={14} />
          <span>{tk('msg.copyOpen')}</span>
        </button>
        <CopyButton value={full} />
        <PostedLink card={card} actions={actions} text={text} />
      </footer>
    </div>
  );
}

export function EmailComposer({
  card,
  payload,
  actions,
  text,
}: {
  card: ActionBoardCard;
  payload: OutreachEmailPayload;
  actions: BoardActions;
  text: BoardText;
}) {
  const { tk } = text;
  const [active, setActive] = useState(0);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const target = payload.targets[active] ?? payload.targets[0];
  if (!target) return null;
  const body = bodies[target.siteName] ?? target.body;
  const email = `Subject: ${target.subject}\n\n${body.trim()}`;
  const articles = target.articles?.length ? target.articles : [{ title: target.articleTitle, url: target.articleUrl }];
  const contactHref = target.contactHint
    ? target.contactHint.includes('@') && !/^mailto:/i.test(target.contactHint)
      ? `mailto:${target.contactHint}?subject=${encodeURIComponent(target.subject)}`
      : target.contactHint
    : null;
  return (
    <div className="ab-msg">
      <Tabs items={payload.targets.map((t) => t.siteName)} active={active} onPick={setActive} />
      <div className="ab-msg-grid">
        <section className="ab-thread">
          <div className="ab-thread-head">
            <span className="ab-quote-src">{target.siteName}</span>
            <a className="ab-link" href={target.articleUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={13} />
              {tk('msg.openArticle')}
            </a>
          </div>
          <h3 className="ab-thread-title">{target.articleTitle}</h3>
          {articles.length > 1 && (
            <div className="ab-site-articles">
              <span className="ab-field-label">{tk('msg.articlesCount', { n: articles.length })}</span>
              <ul>
                {articles.map((art) => (
                  <li key={art.url}>
                    <a className="ab-link" href={art.url} target="_blank" rel="noreferrer">
                      <ExternalLink size={11} />
                      <span>{art.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {contactHref && (
            <a className="ab-site-chip" href={contactHref} target={contactHref.startsWith('mailto:') ? undefined : '_blank'} rel="noreferrer">
              <ExternalLink size={12} />
              <span>{target.contactHint}</span>
            </a>
          )}
          <Checklist titleKey="msg.checklistEmail" keys={['msg.check.contact', 'msg.check.paid', 'msg.check.disclose']} text={text} />
        </section>
        <section className="ab-composer">
          <PostZone language={payload.language}>
            <div className="ab-field-block is-inline">
              <div className="ab-field-grow">
                <span className="ab-field-label">{tk('msg.subject')}</span>
                <p>{target.subject}</p>
              </div>
              <CopyButton value={target.subject} iconOnly />
            </div>
            <div className="ab-field-block">
              <div className="ab-field-head">
                <span className="ab-field-label">{tk('msg.email')}</span>
                <CopyButton value={body.trim()} iconOnly />
              </div>
              <textarea
                className="ab-textarea is-email"
                rows={Math.max(12, body.split('\n').length + 2)}
                value={body}
                aria-label={tk('msg.email')}
                onChange={(e) => setBodies((prev) => ({ ...prev, [target.siteName]: e.target.value }))}
              />
            </div>
          </PostZone>
        </section>
      </div>
      <footer className="ab-fc-foot">
        <CopyButton value={email} label={tk('msg.copyEmail')} className="ost-btn-primary is-sm" />
        {contactHref && (
          <a
            className="ost-btn-secondary is-sm"
            href={contactHref}
            target={contactHref.startsWith('mailto:') ? undefined : '_blank'}
            rel="noreferrer"
          >
            <ExternalLink size={14} />
            <span>{tk('msg.openContact')}</span>
          </a>
        )}
      </footer>
    </div>
  );
}
