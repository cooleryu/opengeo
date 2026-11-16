import fs from 'node:fs';
import Module, { createRequire, register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(repoRoot, 'src');
const repoPkgUrl = pathToFileURL(path.join(repoRoot, 'package.json')).href;

const EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.mjs', '/index.js'];

function findFilePath(basePath) {
  for (const suffix of EXTENSIONS) {
    const candidate = `${basePath}${suffix}`;
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Try next suffix
    }
  }
  return null;
}

function transpileCommonJS(filePath, sourceText) {
  return ts.transpileModule(sourceText, {
    fileName: filePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
      inlineSourceMap: true,
    },
  }).outputText;
}

if (!import.meta.url.endsWith('?hooks')) {
  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function resolveWithAlias(request, parent, isMain, options) {
    if (request.startsWith('@/')) {
      const resolved = findFilePath(path.join(srcRoot, request.slice(2)));
      if (resolved) return resolved;
    }
    try {
      return originalResolveFilename.call(this, request, parent, isMain, options);
    } catch (error) {
      if ((request.startsWith('./') || request.startsWith('../')) && parent?.filename) {
        const resolved = findFilePath(path.resolve(path.dirname(parent.filename), request));
        if (resolved) return resolved;
      }
      throw error;
    }
  };

  for (const ext of ['.ts', '.tsx', '.cts']) {
    Module._extensions[ext] = function compileTs(mod, filename) {
      const code = transpileCommonJS(filename, fs.readFileSync(filename, 'utf8'));
      mod._compile(code, filename);
    };
  }
  Module._extensions['.css'] = function ignoreCss(mod) {
    mod.exports = {};
  };

  register('./ts-loader.mjs?hooks', import.meta.url);
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const found = findFilePath(path.join(srcRoot, specifier.slice(2)));
    if (found) return nextResolve(pathToFileURL(found).href, context);
  }

  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT') {
      throw error;
    }

    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('file://')) {
      const basePath = specifier.startsWith('file://')
        ? fileURLToPath(specifier)
        : path.resolve(path.dirname(fileURLToPath(context.parentURL || repoPkgUrl)), specifier);
      const found = findFilePath(basePath);
      if (found) return nextResolve(pathToFileURL(found).href, context);
    } else if (!specifier.startsWith('node:')) {
      try {
        const req = createRequire(context.parentURL || repoPkgUrl);
        return nextResolve(pathToFileURL(req.resolve(specifier)).href, context);
      } catch {
        // Fall through to rethrow original error
      }
    }

    throw error;
  }
}

export async function load(url, context, nextLoad) {
  const cleanUrl = url.split('?')[0];
  if (cleanUrl.endsWith('.css')) {
    return { format: 'module', shortCircuit: true, source: 'export default {};' };
  }

  if (cleanUrl.startsWith('file://') && cleanUrl.endsWith('.json')) {
    return {
      format: 'json',
      shortCircuit: true,
      source: fs.readFileSync(fileURLToPath(cleanUrl), 'utf8'),
    };
  }

  if (cleanUrl.startsWith('file://') && /\.(?:ts|tsx|mts|cts)$/.test(cleanUrl)) {
    const filePath = fileURLToPath(cleanUrl);
    if (process.env.OPENGEO_TS_CJS === '1' && !cleanUrl.endsWith('.mts')) {
      return {
        format: 'commonjs',
        shortCircuit: true,
        source: transpileCommonJS(filePath, fs.readFileSync(filePath, 'utf8')),
      };
    }
    const { outputText } = ts.transpileModule(fs.readFileSync(filePath, 'utf8'), {
      fileName: filePath,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        inlineSourceMap: true,
      },
    });
    return { format: 'module', shortCircuit: true, source: outputText };
  }

  return nextLoad(url, context);
}
