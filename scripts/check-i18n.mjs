import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let _ts = null;
function getTs() {
  if (!_ts) {
    _ts = require('typescript');
  }
  return _ts;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, '..');

const HAN_RE = /\p{Script=Han}/u;
const LANG_COND_RE = /\b(?:isEn|isZh|uiLanguage|lang|language|locale)\b/;
const EXEMPT_METHODS = new Set([
  'includes',
  'startsWith',
  'endsWith',
  'match',
  'matchAll',
  'test',
  'replace',
  'replaceAll',
  'split',
  'indexOf',
  'search',
]);
const SERVER_MSG_PROPS = new Set(['message', 'error', 'hint', 'statusText']);
const EXACT_ALLOWLIST = new Set(['简体中文', '中文']);
const LOCALE_METHODS = new Set([
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
]);

// Per spec §1 + amendments v1.1 (A1: 问题监测 & 竞品对照 are unbanned for sidebar nav)
const DEPRECATED_EN_PATTERNS = [
  { label: 'Official Citations', re: /\bofficial citations\b/i },
  { label: 'native citation', re: /\bnative citation\b/i },
  { label: 'Questions & Runs', re: /\bquestions\s*&\s*runs\b/i },
  { label: 'Shipped Log', re: /\bshipped log\b/i },
  { label: 'Re-audit', re: /\bre-audit\b/i },
  { label: 'Improve & Track', re: /\bimprove\s*&\s*track\b/i },
  { label: 'Optimization & Tracking', re: /\boptimization\s*&\s*tracking\b/i },
  { label: 'deliverable', re: /\bdeliverable\b/i },
];
const DEPRECATED_ZH_TERMS = ['官网链接引用', '优化方案', '改稿'];

const RULE_IDS = [
  'unpaired-zh',
  'unpaired-zh-server',
  'html-lang',
  'fixed-locale',
  'manual-plural',
  'deprecated-term',
];

const SCRIPT_HASH = createHash('sha1')
  .update(fs.readFileSync(__filename, 'utf8'))
  .digest('hex')
  .slice(0, 12);

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function getScriptKind(filePath) {
  const ts = getTs();
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function resolveImportPath(fromFileAbs, specifier, rootDir) {
  if (!specifier || (!specifier.startsWith('.') && !specifier.startsWith('@/'))) {
    return null;
  }
  const base = specifier.startsWith('@/')
    ? path.join(rootDir, 'src', specifier.slice(2))
    : path.resolve(path.dirname(fromFileAbs), specifier);

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mjs`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        return cand;
      }
    } catch {
      // ignore invalid path
    }
  }
  return null;
}

const STATIC_IMPORT_RE =
  /(?:^|[;\n])\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const UI_TRIGGER_RE =
  /\p{Script=Han}|<html\b|toLocale(?:Date|Time)?String\b|\bIntl\.|\?\s*['"]s['"]|\?\s*['"]['"]|\b(?:official citations|native citation|questions\s*&\s*runs|shipped log|re-audit|improve\s*&\s*track|optimization\s*&\s*tracking|deliverable)\b/iu;

function extractStaticImportsFast(sourceText) {
  const cleaned = sourceText
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, '');
  const specifiers = [];
  STATIC_IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = STATIC_IMPORT_RE.exec(cleaned)) !== null) {
    const spec = m[1] || m[2];
    if (spec && (spec.startsWith('.') || spec.startsWith('@/'))) {
      specifiers.push(spec);
    }
  }
  return specifiers;
}

function isExcludedRel(rel) {
  if (rel.startsWith('scripts/')) return true;
  if (/\.test\.[^/]+$/i.test(rel)) return true;
  if (!/\.(?:ts|tsx|mjs)$/i.test(rel)) return true;
  return false;
}

export function discoverReachableScopes(rootDir = DEFAULT_ROOT, ctx = {}) {
  const uiEntries = [
    ...fs.globSync('src/app/**/page.tsx', { cwd: rootDir }),
    ...fs.globSync('src/app/**/layout.tsx', { cwd: rootDir }),
  ]
    .map((f) => path.resolve(rootDir, f))
    .sort();

  const serverEntries = fs
    .globSync('src/app/api/**/route.ts', { cwd: rootDir })
    .map((f) => path.resolve(rootDir, f))
    .sort();

  const prevDepsCache = ctx.prevDepsCache ?? {};
  const nextDepsCache = ctx.nextDepsCache ?? {};
  const fileStateMap = ctx.fileStateMap ?? new Map();
  const useCache = ctx.useCache === true;

  const getFileState = (fileAbs) => {
    const rel = toPosix(path.relative(rootDir, fileAbs));
    if (fileStateMap.has(rel)) return fileStateMap.get(rel);
    const content = fs.readFileSync(fileAbs, 'utf8');
    const hash = createHash('sha1').update(content).digest('hex');
    const state = { rel, abs: fileAbs, content, hash, sf: null, deps: null };
    fileStateMap.set(rel, state);
    return state;
  };

  const getDeps = (fileAbs) => {
    try {
      const state = getFileState(fileAbs);
      if (state.deps) return state.deps;
      const cached = useCache ? prevDepsCache[state.rel] : null;
      let specifiers;
      if (cached && cached.hash === state.hash && Array.isArray(cached.specifiers)) {
        specifiers = cached.specifiers;
      } else {
        specifiers = extractStaticImportsFast(state.content);
      }
      nextDepsCache[state.rel] = { hash: state.hash, specifiers };
      state.deps = specifiers
        .map((spec) => resolveImportPath(fileAbs, spec, rootDir))
        .filter(Boolean);
      return state.deps;
    } catch {
      return [];
    }
  };

  const crawl = (entries, includeFilter) => {
    const visited = new Set();
    const result = new Set();
    const queue = [...entries];
    while (queue.length > 0) {
      const curr = queue.pop();
      if (visited.has(curr)) continue;
      visited.add(curr);
      const rel = toPosix(path.relative(rootDir, curr));
      if (isExcludedRel(rel)) continue;
      if (includeFilter(rel)) {
        result.add(rel);
      }
      for (const dep of getDeps(curr)) {
        const depRel = toPosix(path.relative(rootDir, dep));
        if (!isExcludedRel(depRel) && !visited.has(dep)) {
          queue.push(dep);
        }
      }
    }
    return [...result].sort();
  };

  const uiFiles = crawl(
    uiEntries,
    (rel) => !rel.startsWith('src/lib/') && !rel.startsWith('src/app/api/'),
  );
  const serverFiles = crawl(
    serverEntries,
    (rel) => rel.startsWith('src/app/api/') || rel.startsWith('src/lib/'),
  );

  return { uiFiles, serverFiles };
}

function hasIgnoreComment(sf, node, lines) {
  const start = node.getStart(sf, false);
  const { line } = sf.getLineAndCharacterOfPosition(start);
  const currLine = lines[line] ?? '';
  const prevLine = line > 0 ? lines[line - 1] ?? '' : '';
  const re = /\/\/\s*i18n-ignore:\s*\S/;
  return re.test(currLine) || re.test(prevLine);
}

function getPropName(nameNode) {
  const ts = getTs();
  if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) {
    return nameNode.text;
  }
  return null;
}

function isPropertyKeyNode(node) {
  const ts = getTs();
  const p = node.parent;
  if (!p) return false;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isMethodDeclaration(p) && p.name === node) return true;
  if (ts.isPropertySignature(p) && p.name === node) return true;
  if (ts.isPropertyDeclaration(p) && p.name === node) return true;
  if (ts.isEnumMember(p) && p.name === node) return true;
  return false;
}

function isNonRuntimeTypeOrImport(node) {
  const ts = getTs();
  let curr = node;
  while (curr) {
    if (
      ts.isLiteralTypeNode(curr) ||
      ts.isImportDeclaration(curr) ||
      ts.isExportDeclaration(curr) ||
      ts.isImportTypeNode(curr) ||
      ts.isTypeReferenceNode(curr)
    ) {
      return true;
    }
    curr = curr.parent;
  }
  return false;
}

function isExemptByAst(node, sf, lines, rawText) {
  const ts = getTs();
  if (EXACT_ALLOWLIST.has(rawText.trim())) return true;
  if (hasIgnoreComment(sf, node, lines)) return true;
  if (isPropertyKeyNode(node) || isNonRuntimeTypeOrImport(node)) return true;

  // (d) operand of === or !==
  if (
    node.parent &&
    ts.isBinaryExpression(node.parent) &&
    (node.parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      node.parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
  ) {
    return true;
  }

  let child = node;
  let curr = node.parent;
  while (curr) {
    // (a) Ancestor ConditionalExpression whose condition references language variable
    if (
      ts.isConditionalExpression(curr) &&
      (curr.whenTrue === child || curr.whenFalse === child)
    ) {
      const condText = curr.condition.getText(sf);
      if (LANG_COND_RE.test(condText)) return true;
    }

    // (b) Value of property `zh` or `'zh-CN'` inside an object literal that also has `en`
    if (ts.isPropertyAssignment(curr) && curr.initializer === child) {
      const propName = getPropName(curr.name);
      if ((propName === 'zh' || propName === 'zh-CN') && curr.parent && ts.isObjectLiteralExpression(curr.parent)) {
        const hasEn = curr.parent.properties.some(
          (prop) => ts.isPropertyAssignment(prop) && getPropName(prop.name) === 'en',
        );
        if (hasEn) return true;
      }
    }

    // (c) Inside argument of regex/string/console helper calls or new RegExp(...)
    if (ts.isCallExpression(curr) && curr.arguments.includes(child)) {
      const expr = curr.expression;
      if (ts.isPropertyAccessExpression(expr)) {
        if (EXEMPT_METHODS.has(expr.name.text)) return true;
        if (ts.isIdentifier(expr.expression) && expr.expression.text === 'console') return true;
      }
    }
    if (ts.isNewExpression(curr) && curr.arguments && curr.arguments.includes(child)) {
      if (ts.isIdentifier(curr.expression) && curr.expression.text === 'RegExp') return true;
    }

    child = curr;
    curr = curr.parent;
  }

  return false;
}

function isInsideServerMessagePosition(node) {
  const ts = getTs();
  let child = node;
  let curr = node.parent;
  while (curr) {
    // Stop climbing across function/block/statement boundaries
    if (
      ts.isBlock(curr) ||
      ts.isFunctionLike(curr) ||
      ts.isSourceFile(curr)
    ) {
      return false;
    }

    // 1. First argument of new <Name>Error(...)
    if (
      ts.isNewExpression(curr) &&
      curr.arguments &&
      curr.arguments.length > 0 &&
      curr.arguments[0] === child
    ) {
      const expr = curr.expression;
      const ctorName = ts.isIdentifier(expr)
        ? expr.text
        : ts.isPropertyAccessExpression(expr)
          ? expr.name.text
          : '';
      if (ctorName.endsWith('Error')) return true;
    }

    // 2. Value of object property named message / error / hint / statusText
    if (ts.isPropertyAssignment(curr) && curr.initializer === child) {
      const propName = getPropName(curr.name);
      if (propName && SERVER_MSG_PROPS.has(propName)) return true;
    }

    // 3. Right-hand side of assignment to .message or .error
    if (
      ts.isBinaryExpression(curr) &&
      curr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      curr.right === child &&
      ts.isPropertyAccessExpression(curr.left) &&
      (curr.left.name.text === 'message' || curr.left.name.text === 'error')
    ) {
      return true;
    }

    child = curr;
    curr = curr.parent;
  }
  return false;
}

function getTemplateText(node) {
  let text = node.head.text;
  for (const span of node.templateSpans) {
    text += `{expr}${span.literal.text}`;
  }
  return text;
}

function isInsideTemplateExpression(node) {
  const ts = getTs();
  let curr = node.parent;
  while (curr) {
    if (ts.isTemplateExpression(curr)) return true;
    if (ts.isExpression(curr) && curr.parent && ts.isTemplateSpan(curr.parent)) {
      // Dynamic expression inside ${...} is checked separately as its own expression!
      return false;
    }
    curr = curr.parent;
  }
  return false;
}

function findDeprecatedTerm(text) {
  for (const zh of DEPRECATED_ZH_TERMS) {
    if (text.includes(zh)) return zh;
  }
  for (const { label, re } of DEPRECATED_EN_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

function isSimpleStringLiteral(node) {
  const ts = getTs();
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/**
 * Analyzes a single source file for all i18n rules.
 * @param {string} relPath posix-relative path
 * @param {string} sourceText
 * @param {'ui' | 'server' | 'i18n-dict'} scope
 * @param {import('typescript').SourceFile} [preparsedSf]
 */
export function analyzeSource(relPath, sourceText, scope, preparsedSf) {
  // Fast skip when a file cannot possibly match any rule in its scope
  if (scope === 'server' && !HAN_RE.test(sourceText)) {
    return [];
  }
  if (scope === 'ui' && !UI_TRIGGER_RE.test(sourceText)) {
    return [];
  }
  const ts = getTs();
  const sf =
    preparsedSf ??
    ts.createSourceFile(
      relPath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(relPath),
    );
  const lines = sourceText.split(/\r?\n/);
  const violations = [];

  const pushViolation = (node, rule, rawText) => {
    const start = node.getStart(sf, false);
    const { line, character } = sf.getLineAndCharacterOfPosition(start);
    const compact = String(rawText).replace(/\s+/g, ' ').trim().slice(0, 60);
    violations.push({
      file: relPath,
      line: line + 1,
      col: character + 1,
      rule,
      text: compact,
    });
  };

  function visit(node) {
    // 1. i18n.ts dictionary: only check deprecated-term on values of zhMessages / enMessages
    if (scope === 'i18n-dict') {
      if (ts.isPropertyAssignment(node) && isSimpleStringLiteral(node.initializer)) {
        const text = node.initializer.text;
        if (!hasIgnoreComment(sf, node.initializer, lines)) {
          const hit = findDeprecatedTerm(text);
          if (hit) {
            pushViolation(node.initializer, 'deprecated-term', `${hit}: ${text}`);
          }
        }
      }
      ts.forEachChild(node, visit);
      return;
    }

    // 2. UI-only structural rules
    if (scope === 'ui') {
      // html-lang: <html lang="literal">
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName) &&
        node.tagName.text === 'html'
      ) {
        for (const attr of node.attributes.properties) {
          if (
            ts.isJsxAttribute(attr) &&
            ts.isIdentifier(attr.name) &&
            attr.name.text === 'lang' &&
            attr.initializer
          ) {
            if (ts.isStringLiteral(attr.initializer)) {
              if (!hasIgnoreComment(sf, attr, lines)) {
                pushViolation(attr, 'html-lang', `<html lang="${attr.initializer.text}">`);
              }
            } else if (
              ts.isJsxExpression(attr.initializer) &&
              attr.initializer.expression &&
              isSimpleStringLiteral(attr.initializer.expression)
            ) {
              if (!hasIgnoreComment(sf, attr, lines)) {
                pushViolation(attr, 'html-lang', `<html lang="${attr.initializer.expression.text}">`);
              }
            }
          }
        }
      }

      // fixed-locale: toLocale*String('literal', ...) or new Intl.*('literal', ...)
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        LOCALE_METHODS.has(node.expression.name.text) &&
        node.arguments.length >= 1 &&
        isSimpleStringLiteral(node.arguments[0]) &&
        !hasIgnoreComment(sf, node, lines)
      ) {
        pushViolation(
          node,
          'fixed-locale',
          `${node.expression.name.text}('${node.arguments[0].text}')`,
        );
      }
      if (
        ts.isNewExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'Intl' &&
        node.arguments &&
        node.arguments.length >= 1 &&
        isSimpleStringLiteral(node.arguments[0]) &&
        !hasIgnoreComment(sf, node, lines)
      ) {
        pushViolation(
          node,
          'fixed-locale',
          `new Intl.${node.expression.name.text}('${node.arguments[0].text}')`,
        );
      }

      // manual-plural: cond ? 's' : '' or cond ? '' : 's'
      if (
        ts.isConditionalExpression(node) &&
        isSimpleStringLiteral(node.whenTrue) &&
        isSimpleStringLiteral(node.whenFalse)
      ) {
        const a = node.whenTrue.text;
        const b = node.whenFalse.text;
        if (
          ((a === 's' && b === '') || (a === '' && b === 's')) &&
          !hasIgnoreComment(sf, node, lines)
        ) {
          pushViolation(node, 'manual-plural', node.getText(sf));
        }
      }
    }

    // 3. String / JSX text nodes for unpaired-zh, unpaired-zh-server, deprecated-term
    let text = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      text = node.text;
    } else if (ts.isTemplateExpression(node)) {
      text = getTemplateText(node);
    } else if (ts.isJsxText(node)) {
      text = node.text;
    }

    if (text !== null && !isInsideTemplateExpression(node)) {
      // deprecated-term (UI scope)
      if (
        scope === 'ui' &&
        !isPropertyKeyNode(node) &&
        !isNonRuntimeTypeOrImport(node) &&
        !hasIgnoreComment(sf, node, lines)
      ) {
        // Avoid flagging regex/string comparison helper args or === operands
        const isComparisonOperand =
          node.parent &&
          ts.isBinaryExpression(node.parent) &&
          (node.parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            node.parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken);
        if (!isComparisonOperand) {
          const hit = findDeprecatedTerm(text);
          if (hit) {
            pushViolation(node, 'deprecated-term', `${hit}: ${text}`);
          }
        }
      }

      // unpaired-zh / unpaired-zh-server
      if (HAN_RE.test(text)) {
        if (scope === 'ui') {
          if (!isExemptByAst(node, sf, lines, text)) {
            pushViolation(node, 'unpaired-zh', text);
          }
        } else if (scope === 'server') {
          if (isInsideServerMessagePosition(node) && !isExemptByAst(node, sf, lines, text)) {
            pushViolation(node, 'unpaired-zh-server', text);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return violations;
}

function loadCache(cachePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (raw && raw.version === SCRIPT_HASH && raw.entries && typeof raw.entries === 'object') {
      return {
        entries: raw.entries,
        deps: raw.deps && typeof raw.deps === 'object' ? raw.deps : {},
      };
    }
  } catch {
    // fresh cache
  }
  return { entries: {}, deps: {} };
}

function saveCache(cachePath, entries, deps) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ version: SCRIPT_HASH, entries, deps }),
      'utf8',
    );
  } catch {
    // non-fatal cache write error
  }
}

export function scanProject(options = {}) {
  const rootDir = options.rootDir ?? DEFAULT_ROOT;
  const useCache = options.noCache !== true;
  const cachePath = path.join(rootDir, 'node_modules', '.cache', 'opengeo-i18n.json');
  const prevCache = useCache ? loadCache(cachePath) : { entries: {}, deps: {} };
  const nextCacheEntries = {};
  const nextDepsCache = {};
  const fileStateMap = new Map();

  const { uiFiles, serverFiles } = discoverReachableScopes(rootDir, {
    useCache,
    prevDepsCache: prevCache.deps,
    nextDepsCache,
    fileStateMap,
  });
  const targets = [];

  for (const rel of uiFiles) {
    targets.push({ rel, scope: 'ui' });
  }
  for (const rel of serverFiles) {
    if (rel === 'src/lib/geo/i18n.ts') continue;
    targets.push({ rel, scope: 'server' });
  }
  const i18nRel = 'src/lib/geo/i18n.ts';
  if (fs.existsSync(path.join(rootDir, i18nRel))) {
    targets.push({ rel: i18nRel, scope: 'i18n-dict' });
  }

  const allViolations = [];
  for (const { rel, scope } of targets) {
    let state = fileStateMap.get(rel);
    if (!state) {
      const abs = path.join(rootDir, rel);
      const content = fs.readFileSync(abs, 'utf8');
      const hash = createHash('sha1').update(content).digest('hex');
      state = { rel, abs, content, hash, sf: null, deps: null };
      fileStateMap.set(rel, state);
    }
    const cacheKey = `${scope}:${rel}`;
    const cached = useCache ? prevCache.entries[cacheKey] : null;
    let fileViolations;
    if (cached && cached.hash === state.hash) {
      fileViolations = cached.violations;
    } else {
      fileViolations = analyzeSource(rel, state.content, scope, state.sf ?? undefined);
    }
    nextCacheEntries[cacheKey] = { hash: state.hash, violations: fileViolations };
    for (const v of fileViolations) allViolations.push(v);
  }

  if (useCache) {
    saveCache(cachePath, nextCacheEntries, nextDepsCache);
  }

  allViolations.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.col - b.col ||
      a.rule.localeCompare(b.rule),
  );

  return {
    filesCount: targets.length,
    uiFiles,
    serverFiles,
    violations: allViolations,
  };
}

export function buildBaselineObject(violations) {
  const counts = Object.fromEntries(RULE_IDS.map((r) => [r, {}]));
  for (const v of violations) {
    counts[v.rule][v.file] = (counts[v.rule][v.file] ?? 0) + 1;
  }
  const sortedRules = {};
  for (const rule of RULE_IDS) {
    const entries = Object.entries(counts[rule])
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    sortedRules[rule] = Object.fromEntries(entries);
  }
  return { version: 1, rules: sortedRules };
}

function parseArgs(argv) {
  const opts = {
    updateBaseline: false,
    strictFiles: [],
    json: false,
    noCache: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--update-baseline') {
      opts.updateBaseline = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--no-cache') {
      opts.noCache = true;
    } else if (arg === '--strict') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('Missing value for --strict');
      }
      i += 1;
      opts.strictFiles.push(
        ...next
          .split(',')
          .map((s) => toPosix(s.trim()).replace(/^\.\//, ''))
          .filter(Boolean),
      );
    } else if (arg.startsWith('--strict=')) {
      const val = arg.slice('--strict='.length);
      opts.strictFiles.push(
        ...val
          .split(',')
          .map((s) => toPosix(s.trim()).replace(/^\.\//, ''))
          .filter(Boolean),
      );
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function runCli() {
  const started = performance.now();
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Usage error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  let scan;
  try {
    scan = scanProject({ noCache: opts.noCache });
  } catch (err) {
    console.error(`Scan error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  const baselinePath = path.join(DEFAULT_ROOT, 'scripts', 'i18n-baseline.json');

  if (opts.updateBaseline) {
    const nextBaseline = buildBaselineObject(scan.violations);
    fs.writeFileSync(baselinePath, `${JSON.stringify(nextBaseline, null, 2)}\n`, 'utf8');
    const elapsedMs = Math.round(performance.now() - started);
    if (opts.json) {
      console.log(
        JSON.stringify({
          ok: true,
          elapsedMs,
          files: scan.filesCount,
          violations: scan.violations,
        }),
      );
    } else {
      console.log(
        `i18n baseline updated · ${scan.violations.length} baselined · ${scan.filesCount} files · ${(elapsedMs / 1000).toFixed(2)}s`,
      );
    }
    process.exitCode = 0;
    return;
  }

  let baseline = { version: 1, rules: Object.fromEntries(RULE_IDS.map((r) => [r, {}])) };
  if (fs.existsSync(baselinePath)) {
    try {
      baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    } catch (err) {
      console.error(`Invalid baseline file: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 2;
      return;
    }
  }

  const currentCounts = Object.fromEntries(RULE_IDS.map((r) => [r, {}]));
  for (const v of scan.violations) {
    currentCounts[v.rule][v.file] = (currentCounts[v.rule][v.file] ?? 0) + 1;
  }

  const strictSet = new Set(opts.strictFiles);
  const failingPairs = [];
  let baselinedTotal = 0;
  let fewerTotal = 0;

  for (const rule of RULE_IDS) {
    const baseRule = baseline.rules?.[rule] ?? {};
    const currRule = currentCounts[rule] ?? {};
    const allFiles = new Set([...Object.keys(baseRule), ...Object.keys(currRule)]);

    for (const file of [...allFiles].sort()) {
      const curr = currRule[file] ?? 0;
      const base = baseRule[file] ?? 0;
      const effectiveBase = strictSet.has(file) ? 0 : base;
      if (curr > effectiveBase) {
        failingPairs.push({ file, rule, curr, base: effectiveBase });
      } else {
        baselinedTotal += curr;
        if (curr < base) {
          fewerTotal += base - curr;
        }
      }
    }
  }

  const elapsedMs = Math.round(performance.now() - started);
  const ok = failingPairs.length === 0;

  if (opts.json) {
    const reportedViolations =
      strictSet.size > 0
        ? scan.violations.filter((v) => strictSet.has(v.file))
        : scan.violations;
    console.log(
      JSON.stringify({
        ok,
        elapsedMs,
        files: scan.filesCount,
        violations: reportedViolations,
      }),
    );
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (ok) {
    console.log(
      `i18n OK · 0 new · ${baselinedTotal} baselined · ${scan.filesCount} files · ${(elapsedMs / 1000).toFixed(2)}s`,
    );
    if (fewerTotal > 0) {
      console.log(`${fewerTotal} fewer than baseline — run with --update-baseline`);
    }
    process.exitCode = 0;
    return;
  }

  for (const { file, rule, curr, base } of failingPairs) {
    console.log(`${file}  ${rule}  ${curr} (baseline ${base})`);
    const matching = scan.violations.filter((v) => v.file === file && v.rule === rule);
    for (const v of matching) {
      console.log(`  ${v.file}:${v.line}:${v.col}  ${v.rule}  "${v.text}"`);
    }
  }
  process.exitCode = 1;
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isDirectRun) {
  runCli();
}
