'use client';

import { useState } from 'react';
import { ExternalLink, Play, Upload } from 'lucide-react';
import type {
  ActionBoardCard,
  FormPackPayload,
  StoryboardScreen,
  VideoScriptPayload,
} from '@/lib/geo/optimization/action-board-catalog';
import { SCREEN_ICON } from './ActionBoardCards';
import { CopyButton, hostOf, PostedLink, PostZone, type BoardActions, type BoardText } from './action-board-shared';

export function FormPack({ card, payload, actions, text }: { card: ActionBoardCard; payload: FormPackPayload; actions: BoardActions; text: BoardText }) {
  const { tk } = text;
  return (
    <div className="ab-form">
      <div className="ab-form-targets">
        <span className="ab-field-label">{tk('form.submitTo')}</span>
        {payload.targets.map((target) => (
          <a key={target.url} className="ab-site-chip" href={target.url} target="_blank" rel="noreferrer">
            {hostOf(target.url)}
            <ExternalLink size={12} />
          </a>
        ))}
      </div>
      <PostZone language={actions.board.targetLanguage}>
        <dl className="ab-form-fields">
          {payload.fields.map((field) => (
            <div key={field.key} className="ab-form-row">
              <dt>{tk(`form.field.${field.key}`)}</dt>
              <dd className={field.key === 'description' ? 'ab-pre' : ''}>{field.value}</dd>
              <CopyButton value={field.value} iconOnly />
            </div>
          ))}
        </dl>
      </PostZone>
      <footer className="ab-fc-foot">
        {payload.targets[0]?.url && (
          <a className="ost-btn-primary is-sm" href={payload.targets[0].url} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            <span>{tk('form.openSite')}</span>
          </a>
        )}
        <PostedLink card={card} actions={actions} text={text} />
      </footer>
    </div>
  );
}

/** A frame is a sketch of what is on screen, not a shrunken screenshot nobody could read. */
function ScreenTile({ screen, caption, lang }: { screen: StoryboardScreen; caption: string; lang: 'en' | 'zh' }) {
  return (
    <span className={`ab-screen is-${screen}`}>
      <span className="ab-screen-icon" aria-hidden="true">
        {SCREEN_ICON[screen]}
      </span>
      <span className="ab-screen-caption" lang={lang}>
        {caption}
      </span>
    </span>
  );
}

export function Storyboard({ card, payload, actions, text }: { card: ActionBoardCard; payload: VideoScriptPayload; actions: BoardActions; text: BoardText }) {
  const { tk, tn, pick } = text;
  const lang = actions.board.targetLanguage;
  const [titleIndex, setTitleIndex] = useState(0);
  const title = payload.titles[titleIndex] ?? payload.titles[0];
  const script = [
    title,
    '',
    ...payload.beats.flatMap((beat) => [`[${beat.t}] ${beat.onScreen}`, ...beat.lines.map((l) => `  ${l}`), '']),
    payload.description,
  ].join('\n');

  return (
    <div className="ab-story">
      <div className="ab-story-top">
        <span className="ab-video-thumb">
          <span className="ab-video-kicker">{tk('vid.thumbIdea')}</span>
          <span className="ab-video-text" lang={lang}>
            {payload.thumbText}
          </span>
          <span className="ab-video-meta">
            <Play size={12} fill="currentColor" />
            {payload.platform} · {payload.duration} · {tn('vid.shots', payload.beats.length)}
          </span>
        </span>
        <fieldset className="ab-title-pick">
          <legend className="ab-field-label">{tk('vid.title')}</legend>
          {payload.titles.map((option, i) => (
            <label key={option} className={i === titleIndex ? 'is-active' : ''}>
              <input type="radio" name={`title-${card.id}`} checked={i === titleIndex} onChange={() => setTitleIndex(i)} />
              <span lang={lang}>{option}</span>
            </label>
          ))}
        </fieldset>
      </div>

      <ol className="ab-strip">
        {payload.beats.map((beat, i) => (
          <li key={i} className="ab-beat">
            <ScreenTile screen={beat.screen} caption={beat.onScreen} lang={lang} />
            <span className="ab-beat-meta">
              <span className="ab-beat-time">{beat.t}</span>
              <span className="ab-tag">{tk(`vid.screen.${beat.screen}`)}</span>
            </span>
            <span className="ab-beat-shot">{pick(beat.shot)}</span>
            <span className="ab-beat-lines" lang={lang}>
              {beat.lines.map((line, j) => (
                <span key={j}>{line}</span>
              ))}
            </span>
          </li>
        ))}
      </ol>

      <PostZone language={lang} actions={<CopyButton value={payload.description} />}>
        <span className="ab-field-label">{tk('vid.description')}</span>
        <p className="ab-pre">{payload.description}</p>
      </PostZone>

      <footer className="ab-fc-foot">
        <CopyButton value={script} label={tk('vid.copyScript')} className="ost-btn-primary is-sm" />
        {payload.studioUrl && (
          <a className="ost-btn-secondary is-sm" href={payload.studioUrl} target="_blank" rel="noreferrer">
            <Upload size={14} />
            <span>{tk('vid.openStudio')}</span>
          </a>
        )}
        <PostedLink card={card} actions={actions} text={text} />
      </footer>
    </div>
  );
}
