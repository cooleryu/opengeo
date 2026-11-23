#!/usr/bin/env node
/**
 * On-demand layout check for the running app at 1440×960, in English and Chinese.
 *
 * Usage: node scripts/check-layout.mjs [--base http://127.0.0.1:4327] [--project <id>] [--out <dir>] [--lang en,zh]
 *
 * It opens Overview, Questions, Competitors and the Action Plan, then every Action Plan pop-up,
 * saves a screenshot of each, and fails on geometry a person would call broken:
 *   card-edge        a card with no visible edge (no border, no shadow, same colour as behind it)
 *   clipped-heading  a heading, title, name or table header cut off
 *   clipped-text     other text cut off (warning; mark intentional excerpts with data-clamp)
 *   image-crop       an image with more than 10% of its width or height cut away
 *   unreadable-shot  a screenshot drawn so small its text would be under 11px
 *   overflows-card   anything sticking out of its card
 *   page-overflow-x  the page scrolls sideways
 * Exit code 1 when anything fails. Nothing is written to the app; screenshots go to --out.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const BASE = (args.base || 'http://127.0.0.1:4327').replace(/\/+$/, '');
const OUT = path.resolve(args.out || path.join(os.tmpdir(), 'opengeo-layout-check'));
const LANGS = (args.lang || 'en,zh').split(',');
const VIEWS = [
  ['overview', 'overview'],
  ['questions', 'question-plan'],
  ['competitors', 'competitor'],
  ['action-plan', 'tasks'],
];

/** Runs inside the page. Returns { fails, warns } for everything under `scopeSelector`. */
function auditLayout(scopeSelector) {
  const BASE_TEXT_PX = 14;
  const MIN_TEXT_PX = 11;
  const scope = document.querySelector(scopeSelector) || document.body;
  const fails = [];
  const warns = [];
  const describe = (el) => {
    const cls = [...el.classList].slice(0, 2).join('.');
    const text = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 48);
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${text ? ` "${text}"` : ''}`;
  };
  const style = (el) => getComputedStyle(el);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = style(el);
    return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const scrollable = (cs) => /(auto|scroll)/.test(`${cs.overflowX} ${cs.overflowY}`);
  const clips = (cs) => /(hidden|clip)/.test(`${cs.overflowX} ${cs.overflowY}`);
  /** Ancestors that can clip `el`: up to the first scroller, and never past an open dialog (it sits in the top layer). */
  const clippers = (el) => {
    const out = [];
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const ns = style(n);
      if (scrollable(ns)) break;
      if (clips(ns)) out.push(n);
      if (n.tagName === 'DIALOG' || ns.position === 'fixed') break;
    }
    return out;
  };
  const transparent = (color) => color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(color);
  const backdrop = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const bg = style(n).backgroundColor;
      if (!transparent(bg)) return bg;
    }
    return 'rgb(255, 255, 255)';
  };
  const isCard = (el) =>
    el.matches('.ab-hero, .ab-card, .ab-row, .ab-modal, [data-layout-card]') || [...el.classList].some((c) => /(^|-)card$/.test(c));
  const all = [scope, ...scope.querySelectorAll('*')].filter((el) => !el.closest('svg') || el.tagName === 'svg');

  // card-edge + overflows-card
  for (const card of all.filter((el) => isCard(el) && visible(el))) {
    const cs = style(card);
    const r = card.getBoundingClientRect();
    if (r.width < 40 || r.height < 24) continue;
    const sides = ['Top', 'Right', 'Bottom', 'Left'].filter(
      (s) => parseFloat(cs[`border${s}Width`]) >= 0.5 && cs[`border${s}Style`] !== 'none' && !transparent(cs[`border${s}Color`]),
    );
    const ownBg = transparent(cs.backgroundColor) ? null : cs.backgroundColor;
    const edge = sides.length >= 3 || cs.boxShadow !== 'none' || (ownBg && ownBg !== backdrop(card));
    if (!edge) fails.push({ rule: 'card-edge', what: describe(card), detail: `border ${cs.borderTopWidth} ${cs.borderTopStyle}, background ${cs.backgroundColor}, no shadow` });
    if (scrollable(cs)) continue;
    for (const child of card.querySelectorAll('*')) {
      if (!visible(child) || (child.closest('svg') !== null && child.tagName !== 'svg')) continue;
      let inScroller = false;
      for (let n = child.parentElement; n && n !== card; n = n.parentElement) if (scrollable(style(n))) inScroller = true;
      if (inScroller || style(child).position === 'fixed') continue;
      const c = child.getBoundingClientRect();
      const out = Math.max(r.left - c.left, c.right - r.right, r.top - c.top, c.bottom - r.bottom);
      if (out > 1) {
        fails.push({ rule: 'overflows-card', what: describe(child), detail: `${Math.round(out)}px outside ${describe(card)}` });
        break;
      }
    }
  }

  // clipped-heading / clipped-text: text elements cut by themselves or by a clipping ancestor
  const headingLike = (el) =>
    el.matches('h1,h2,h3,h4,h5,h6,th,[role="heading"],[role="columnheader"],[data-noclip]') ||
    [...el.classList].some((c) => /(title|heading|name)/.test(c)) ||
    Boolean(el.parentElement?.closest('thead, [class*="head"]'));
  for (const el of all) {
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!ownText || !visible(el) || el.closest('[data-clamp]')) continue;
    const cs = style(el);
    let cut = '';
    if (!scrollable(cs) && (clips(cs) || cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none')) {
      if (el.scrollWidth > el.clientWidth + 1) cut = 'cut off at the side';
      else if (el.scrollHeight > el.clientHeight + 1) cut = 'cut off at the bottom';
    }
    if (!cut) {
      const r = el.getBoundingClientRect();
      for (const n of clippers(el)) {
        const b = n.getBoundingClientRect();
        if (r.right > b.right + 1 || r.left < b.left - 1 || r.bottom > b.bottom + 1 || r.top < b.top - 1) {
          cut = `hidden by ${describe(n)}`;
          break;
        }
      }
    }
    if (!cut) continue;
    const item = { rule: headingLike(el) ? 'clipped-heading' : 'clipped-text', what: describe(el), detail: cut };
    (item.rule === 'clipped-heading' ? fails : warns).push(item);
  }

  // image-crop + unreadable-shot
  for (const img of all.filter((el) => el.tagName === 'IMG' && visible(el) && el.naturalWidth > 0)) {
    const r = img.getBoundingClientRect();
    if (r.width < 48 || r.height < 48) continue;
    const cs = style(img);
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    let drawScale = Math.min(r.width / nw, r.height / nh);
    let fx = 1;
    let fy = 1;
    if (cs.objectFit === 'cover') {
      drawScale = Math.max(r.width / nw, r.height / nh);
      fx = r.width / (nw * drawScale);
      fy = r.height / (nh * drawScale);
    } else if (cs.objectFit === 'fill' || cs.objectFit === '') {
      drawScale = r.width / nw;
    }
    for (const n of clippers(img)) {
      const b = n.getBoundingClientRect();
      fx *= Math.max(0, Math.min(r.right, b.right) - Math.max(r.left, b.left)) / r.width;
      fy *= Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top)) / r.height;
    }
    if (!img.closest('[data-crop-ok]') && (fx < 0.9 || fy < 0.9)) {
      fails.push({ rule: 'image-crop', what: describe(img), detail: `${Math.round(fx * 100)}% of width, ${Math.round(fy * 100)}% of height visible` });
    }
    const declared = Number(img.dataset.shotDpr);
    const isShot = declared > 0 || /auditShot|screenshot|shot/i.test(img.currentSrc || img.src) || nw >= 1000;
    if (isShot) {
      const dpr = declared > 0 ? declared : nw >= 1600 ? 2 : 1;
      const textPx = BASE_TEXT_PX * drawScale * dpr;
      if (textPx < MIN_TEXT_PX) {
        fails.push({ rule: 'unreadable-shot', what: describe(img), detail: `page text drawn at about ${textPx.toFixed(1)}px` });
      }
    }
  }

  const doc = document.scrollingElement;
  if (doc && doc.scrollWidth > window.innerWidth + 1) {
    fails.push({ rule: 'page-overflow-x', what: 'page', detail: `${doc.scrollWidth}px wide in a ${window.innerWidth}px window` });
  }
  return { fails, warns };
}

async function launch() {
  const { chromium } = await import('playwright');
  for (const opts of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try {
      return await chromium.launch({ headless: true, ...opts });
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error('No Chromium found. Run `npx playwright install chromium` or install Chrome.');
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page
    .waitForFunction(() => [...document.images].every((img) => img.complete), undefined, { timeout: 15000 })
    .catch(() => undefined);
  await page.waitForTimeout(700);
}

async function main() {
  let project = args.project;
  if (!project) {
    const res = await fetch(`${BASE}/api/geo/projects`);
    project = (await res.json()).projects?.[0]?.id;
    if (!project) throw new Error('No project found; pass --project <id>.');
  }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const results = [];
  const record = async (page, name, scope) => {
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    const { fails, warns } = await page.evaluate(auditLayout, scope);
    results.push({ name, fails, warns, file });
  };

  for (const lang of LANGS) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.addInitScript((l) => window.localStorage.setItem('opengeo:ui-lang:v2', l), lang);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (res) => {
      if (res.status() >= 400 && res.url().startsWith(BASE)) pageErrors.push(`HTTP ${res.status()} ${res.url().slice(BASE.length)}`);
    });
    for (const [name, view] of VIEWS) {
      await page.goto(`${BASE}/?project=${encodeURIComponent(project)}&view=${view}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
      if (view === 'tasks') await page.waitForSelector('.ab-root', { timeout: 60000 });
      await settle(page);
      await record(page, `${lang}-${name}`, 'body');
    }

    const openers = await page.locator('.ab-hero .ab-cta, .ab-card, .ab-row').count();
    for (let i = 0; i < openers; i += 1) {
      await page.locator('.ab-hero .ab-cta, .ab-card, .ab-row').nth(i).click();
      const dialog = page.locator('dialog.ab-modal[open]');
      await dialog.waitFor({ timeout: 15000 });
      await settle(page);
      const kind = await dialog.evaluate((d) => [...d.classList].find((c) => c.startsWith('is-'))?.slice(3) ?? 'dialog');
      await record(page, `${lang}-dialog-${i + 1}-${kind}`, 'dialog.ab-modal[open]');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
    }
    if (pageErrors.length) results.push({ name: `${lang}-errors`, fails: pageErrors.map((e) => ({ rule: 'page-error', what: e, detail: '' })), warns: [] });
    await context.close();
  }
  await browser.close();

  let failed = 0;
  for (const { name, fails, warns } of results) {
    failed += fails.length;
    console.log(`${fails.length ? 'FAIL' : 'PASS'}  ${name}${warns.length ? `  (${warns.length} warning${warns.length > 1 ? 's' : ''})` : ''}`);
    for (const f of fails) console.log(`      ✗ ${f.rule}: ${f.what}${f.detail ? ` — ${f.detail}` : ''}`);
    for (const w of warns) console.log(`      ! ${w.rule}: ${w.what} — ${w.detail}`);
  }
  console.log(`\n${results.length} screens checked, ${failed} failure${failed === 1 ? '' : 's'}. Screenshots: ${OUT}`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
