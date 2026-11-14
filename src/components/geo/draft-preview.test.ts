import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { compiler } from 'markdown-to-jsx';
import { draftPreviewOptions } from './draft-preview';

const source = 'https://github.com/cooleryu/opengeo/blob/main/README.md';
const render = (text: string) =>
  renderToStaticMarkup(compiler(text, draftPreviewOptions(source)));

test('README markup displays readable headings and repository-relative links', () => {
  const html = render('<div align="center"><h1>OpenGEO</h1><p>本地运行的工作台。</p><a href="docs/getting-started.md#中文">开始使用</a></div>');
  assert.match(html, /<h1>OpenGEO<\/h1>/);
  assert.match(html, /<p>本地运行的工作台。<\/p>/);
  assert.match(html, /href="https:\/\/github.com\/cooleryu\/opengeo\/blob\/main\/docs\/getting-started.md#/);
  assert.doesNotMatch(html, /&lt;h1|align=/);
});

test('README images resolve to raw repository assets', () => {
  const html = render('![概览](docs/images/overview.png)');
  assert.match(html, /src="https:\/\/raw.githubusercontent.com\/cooleryu\/opengeo\/main\/docs\/images\/overview.png"/);
});

test('untrusted draft HTML cannot inject scripts, frames, styles or unsafe URLs', () => {
  const html = render('<div style="position:fixed" onclick="alert(1)"><script>alert(1)</script><iframe src="https://example.com"></iframe><a href="javascript:alert(1)">link</a><img src="data:image/svg+xml,bad" onerror="alert(1)"><p>正文</p></div>');
  assert.doesNotMatch(html, /<script|<iframe|style=|onclick|onerror|javascript:|data:image|alert\(1\)/);
  assert.match(html, /正文/);
});
