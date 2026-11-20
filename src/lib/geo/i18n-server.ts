import { NextResponse } from 'next/server';
import type { BrowserCollectJobSnapshot } from './browser-collect-types';
import { translateUi, UI_MESSAGES, type GeoLanguage, type UiMessageKey } from './i18n';
import type { OnboardingRecord } from './project-onboarding-types';
import { GeoProjectError } from './projects';

export type ServerErrorParams = Record<string, string | number>;

export interface CodedErrorShape {
  code?: string;
  status?: number;
  params?: ServerErrorParams;
  detail?: string;
}

export const UI_LANG_COOKIE_NAME = 'opengeo-ui-lang';

function parseCookieValue(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

export function resolveUiLanguageFromHeaderValues(
  cookieLang: string | null | undefined,
  acceptLanguage: string | null | undefined,
): GeoLanguage {
  if (cookieLang === 'en' || cookieLang === 'zh') return cookieLang;
  if (acceptLanguage) {
    const firstTag = acceptLanguage
      .split(',')
      .map((part) => part.split(';')[0]?.trim().toLowerCase())
      .find(Boolean);
    if (firstTag?.startsWith('zh')) return 'zh';
  }
  return 'en';
}

/**
 * Resolves the UI language for a server request (spec §Server contract):
 * 1. body.uiLanguage (when provided as 'en' | 'zh')
 * 2. cookie `opengeo-ui-lang`
 * 3. `Accept-Language` (first tag starting with `zh` -> `zh`)
 * 4. fallback `en`
 */
export function resolveRequestUiLanguage(
  request: Request | { headers: { get(name: string): string | null } },
  body?: Record<string, unknown> | null,
): GeoLanguage {
  const bodyLang = body && typeof body === 'object' ? body.uiLanguage : undefined;
  if (bodyLang === 'en' || bodyLang === 'zh') return bodyLang;

  const cookieHeader = request.headers.get('cookie');
  const cookieLang = parseCookieValue(cookieHeader, UI_LANG_COOKIE_NAME);
  const acceptLanguage = request.headers.get('accept-language');
  return resolveUiLanguageFromHeaderValues(cookieLang, acceptLanguage);
}

function hasDictKey(key: string): key is UiMessageKey {
  return Object.prototype.hasOwnProperty.call(UI_MESSAGES.en, key);
}

/**
 * Translates an error code (with optional reason/field subkey) or a direct message code
 * (`collect.*`, `onboarding.status.*`, `settings.test.*`) into `lang`.
 */
export function translateServerCode(
  lang: GeoLanguage,
  code: string,
  params?: ServerErrorParams,
): string {
  if (hasDictKey(code)) {
    return translateUi(lang, code, params);
  }
  const subKey =
    typeof params?.reason === 'string' && params.reason
      ? `error.${code}.${params.reason}`
      : typeof params?.field === 'string' && params.field
        ? `error.${code}.${params.field}`
        : null;
  if (subKey && hasDictKey(subKey)) {
    return translateUi(lang, subKey, params);
  }
  const directErrorKey = `error.${code}`;
  if (hasDictKey(directErrorKey)) {
    return translateUi(lang, directErrorKey, params);
  }
  return translateUi(lang, 'error.internal_error');
}

export function buildServerErrorPayload(
  error: unknown,
  lang: GeoLanguage,
): {
  status: number;
  body: { error: string; code: string; params?: ServerErrorParams; detail?: string };
} {
  if (error instanceof GeoProjectError) {
    return {
      status: error.status,
      body: {
        error: translateServerCode(lang, 'project_not_found'),
        code: 'project_not_found',
      },
    };
  }
  if (error instanceof SyntaxError) {
    return {
      status: 400,
      body: {
        error: translateServerCode(lang, 'invalid_request'),
        code: 'invalid_request',
      },
    };
  }

  const coded = error && typeof error === 'object' ? (error as CodedErrorShape) : null;
  if (coded && typeof coded.code === 'string' && coded.code) {
    const status =
      typeof coded.status === 'number' && coded.status >= 400 && coded.status <= 599
        ? coded.status
        : 400;
    const params = coded.params && Object.keys(coded.params).length > 0 ? coded.params : undefined;
    const detail =
      coded.detail && !(lang === 'en' && /[\p{Script=Han}]/u.test(coded.detail))
        ? coded.detail
        : undefined;
    return {
      status,
      body: {
        error: translateServerCode(lang, coded.code, params),
        code: coded.code,
        ...(params ? { params } : {}),
        ...(detail ? { detail } : {}),
      },
    };
  }

  const rawDetail = error instanceof Error ? error.message : String(error ?? '');
  const detail =
    rawDetail && !(lang === 'en' && /[\p{Script=Han}]/u.test(rawDetail))
      ? rawDetail
      : undefined;
  return {
    status: 500,
    body: {
      error: translateServerCode(lang, 'internal_error'),
      code: 'internal_error',
      ...(detail ? { detail } : {}),
    },
  };
}

export function serverErrorResponse(
  error: unknown,
  lang: GeoLanguage,
  extraHeaders?: Record<string, string>,
): NextResponse {
  const { status, body } = buildServerErrorPayload(error, lang);
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', ...(extraHeaders ?? {}) },
  });
}

export function localizeOnboardingRecord(
  record: OnboardingRecord | null,
  lang: GeoLanguage,
): OnboardingRecord | null {
  if (!record) return null;
  const next: OnboardingRecord = { ...record };
  if (record.messageCode) {
    next.message = translateServerCode(lang, record.messageCode, record.messageParams);
  }
  if (record.errorCode) {
    next.error = translateServerCode(lang, record.errorCode, record.errorParams);
  }
  return next;
}

export function localizeBrowserCollectSnapshot(
  snap: BrowserCollectJobSnapshot,
  lang: GeoLanguage,
): BrowserCollectJobSnapshot {
  const next: BrowserCollectJobSnapshot = { ...snap };
  if (snap.messageCode) {
    next.message = translateServerCode(lang, snap.messageCode, snap.messageParams);
  }
  if (snap.errorCode) {
    next.error = translateServerCode(lang, snap.errorCode, snap.errorParams);
  }
  return next;
}
