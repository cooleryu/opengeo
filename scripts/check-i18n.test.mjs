import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSource } from './check-i18n.mjs';

test('rule: unpaired-zh flags bare Chinese UI strings and JSX text', () => {
  const src = `
    export function Demo() {
      const label = '保存配置';
      return <button title="提示文字">提交</button>;
    }
  `;
  const v = analyzeSource('src/components/geo/Demo.tsx', src, 'ui');
  const hits = v.filter((x) => x.rule === 'unpaired-zh');
  assert.equal(hits.length, 3);
});

test('rule: unpaired-zh-server flags only Error/message/error/hint/statusText positions, not LLM prompts or logs', () => {
  const src = `
    export function handler(obj: any) {
      console.log('内部日志中文');
      const prompt = '这是一段内部提示词';
      obj.message = '赋值报错';
      if (!obj) throw new CustomError('参数无效');
      return { error: '请求失败', hint: '请检查', statusText: '状态中文', internalNote: '忽略此字段' };
    }
  `;
  const v = analyzeSource('src/lib/geo/demo.ts', src, 'server');
  const hits = v.filter((x) => x.rule === 'unpaired-zh-server');
  assert.equal(hits.length, 5);
  assert.equal(hits.some((h) => h.text.includes('内部日志')), false);
  assert.equal(hits.some((h) => h.text.includes('内部提示词')), false);
  assert.equal(hits.some((h) => h.text.includes('忽略此字段')), false);
});

test('rule: html-lang flags hard-coded <html lang="literal"> and ignores dynamic expression', () => {
  const bad = `export default function L() { return <html lang="en"><body /></html>; }`;
  const good = `export default function L({ lang }: { lang: string }) { return <html lang={lang}><body /></html>; }`;
  assert.equal(analyzeSource('src/app/layout.tsx', bad, 'ui').filter((x) => x.rule === 'html-lang').length, 1);
  assert.equal(analyzeSource('src/app/layout.tsx', good, 'ui').filter((x) => x.rule === 'html-lang').length, 0);
});

test('rule: fixed-locale flags string-literal toLocale*String and new Intl.* locales', () => {
  const src = `
    export function fmt(d: Date, locale: string) {
      const a = d.toLocaleDateString('en-US');
      const b = new Intl.NumberFormat('zh-CN').format(10);
      const c = d.toLocaleDateString(locale);
      return [a, b, c];
    }
  `;
  const hits = analyzeSource('src/components/geo/Fmt.tsx', src, 'ui').filter((x) => x.rule === 'fixed-locale');
  assert.equal(hits.length, 2);
});

test('rule: manual-plural flags cond ? "s" : ""', () => {
  const src = `
    export function countText(n: number) {
      return \`\${n} item\${n > 1 ? 's' : ''}\`;
    }
  `;
  const hits = analyzeSource('src/components/geo/Count.tsx', src, 'ui').filter((x) => x.rule === 'manual-plural');
  assert.equal(hits.length, 1);
});

test('rule: deprecated-term flags banned terms in UI and i18n.ts while allowing unbanned nav terms', () => {
  const uiSrc = `
    export function Nav({ isEn }: { isEn: boolean }) {
      const a = isEn ? 'Official Citations' : '官网链接引用';
      const b = isEn ? 'Questions' : '问题监测';
      const c = isEn ? 'Competitors' : '竞品对照';
      const d = isEn ? 'Shipped Log' : '优化方案';
      return [a, b, c, d];
    }
  `;
  const hits = analyzeSource('src/components/geo/Nav.tsx', uiSrc, 'ui').filter((x) => x.rule === 'deprecated-term');
  assert.equal(hits.length, 4);
  assert.equal(hits.some((h) => h.text.includes('问题监测') || h.text.includes('竞品对照')), false);

  const dictSrc = `
    const zhMessages = { 'a.b': '查看改稿', 'nav.questions': '问题监测' };
    const enMessages = { 'a.b': 'Inspect deliverable', 'nav.questions': 'Questions' };
  `;
  const dictHits = analyzeSource('src/lib/geo/i18n.ts', dictSrc, 'i18n-dict').filter(
    (x) => x.rule === 'deprecated-term',
  );
  assert.equal(dictHits.length, 2);
});

test('exemption (a): paired conditional expression with isEn / uiLanguage suppresses unpaired-zh', () => {
  const src = `
    export function C({ isEn, uiLanguage }: { isEn: boolean; uiLanguage: string }) {
      const a = isEn ? 'Save' : '保存';
      const b = uiLanguage === 'en' ? (isEn ? 'Nested' : '嵌套') : '中文嵌套';
      return <span>{a}{b}</span>;
    }
  `;
  const hits = analyzeSource('src/components/geo/C.tsx', src, 'ui').filter((x) => x.rule === 'unpaired-zh');
  assert.equal(hits.length, 0);
});

test('exemption (b): object literal with en + zh / zh-CN suppresses unpaired-zh', () => {
  const src = `
    const LABELS = { en: 'Overview', zh: '概览' };
    const LABELS2 = { en: 'Overview', 'zh-CN': '概览' };
    const BAD = { zh: '缺少英文' };
  `;
  const hits = analyzeSource('src/components/geo/Obj.tsx', src, 'ui').filter((x) => x.rule === 'unpaired-zh');
  assert.equal(hits.length, 1);
});

test('exemption (c): string search/regex methods and console.* suppress unpaired-zh', () => {
  const src = `
    export function parse(s: string) {
      console.warn('调试信息');
      const r = new RegExp('匹配');
      return s.includes('中文') && s.replace('旧词', '新词').startsWith('前缀') && r.test(s);
    }
  `;
  const hits = analyzeSource('src/components/geo/Parse.tsx', src, 'ui').filter((x) => x.rule === 'unpaired-zh');
  assert.equal(hits.length, 0);
});

test('exemption (d): === and !== operands suppress unpaired-zh', () => {
  const src = `
    export function check(x: string) {
      return x === '未知' || x !== '完成';
    }
  `;
  const hits = analyzeSource('src/components/geo/Eq.tsx', src, 'ui').filter((x) => x.rule === 'unpaired-zh');
  assert.equal(hits.length, 0);
});

test('exemption (e): literal types and property keys suppress unpaired-zh', () => {
  const src = `
    type Role = '公开获客文章' | '仓库文档';
    const map = { '中文键': 'English value' };
    export type { Role };
    export { map };
  `;
  const hits = analyzeSource('src/components/geo/Types.tsx', src, 'ui').filter((x) => x.rule === 'unpaired-zh');
  assert.equal(hits.length, 0);
});

test('exemption (f): exact allowlisted language names 简体中文 and 中文 are suppressed', () => {
  const src = `
    export function Picker() {
      return <><button>中文</button><button>简体中文</button></>;
    }
  `;
  const hits = analyzeSource('src/components/geo/Picker.tsx', src, 'ui').filter((x) => x.rule === 'unpaired-zh');
  assert.equal(hits.length, 0);
});

test('exemption (g): i18n-ignore with non-empty reason suppresses on same or previous line', () => {
  const src = `
    export function Ignored() {
      // i18n-ignore: brand example in placeholder
      const a = '示例品牌';
      const b = '另一个'; // i18n-ignore: legacy format token
      // i18n-ignore:
      const c = '空原因不应跳过';
      return [a, b, c];
    }
  `;
  const hits = analyzeSource('src/components/geo/Ign.tsx', src, 'ui').filter((x) => x.rule === 'unpaired-zh');
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /空原因不应跳过/);
});
