'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { translateUi, type GeoLanguage, type UiMessageKey } from '@/lib/geo/i18n';

const STORAGE_KEY = 'opengeo:ui-lang:v2';
const LANG_EVENT = 'opengeo:ui-lang-change';

type UiLanguageContextValue = {
  uiLanguage: GeoLanguage;
  setUiLanguage: (lang: GeoLanguage) => void;
  t: (key: UiMessageKey, vars?: Record<string, string | number>) => string;
};

const defaultContextValue: UiLanguageContextValue = {
  uiLanguage: 'en',
  setUiLanguage: () => {},
  t: (key, vars) => translateUi('en', key, vars),
};

const UiLanguageContext = createContext<UiLanguageContextValue>(defaultContextValue);

function subscribeLanguage(callback: () => void) {
  if (typeof window === 'undefined') return () => {};
  const handler = () => callback();
  window.addEventListener(LANG_EVENT, handler);
  window.addEventListener('storage', handler);
  window.addEventListener('popstate', handler);
  return () => {
    window.removeEventListener(LANG_EVENT, handler);
    window.removeEventListener('storage', handler);
    window.removeEventListener('popstate', handler);
  };
}

function readStoredLanguage(fallback: GeoLanguage): GeoLanguage {
  if (typeof window === 'undefined') return fallback;
  try {
    const param = new URLSearchParams(window.location.search).get('ui');
    if (param === 'en' || param === 'zh') return param;
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh') return saved;
  } catch {
    // Ignore locked-down storage.
  }
  return fallback;
}

export function UiLanguageProvider({
  children,
  initialLanguage = 'en',
}: {
  children: ReactNode;
  initialLanguage?: GeoLanguage;
}) {
  const uiLanguage = useSyncExternalStore(
    subscribeLanguage,
    () => readStoredLanguage(initialLanguage),
    () => initialLanguage,
  );

  useEffect(() => {
    document.documentElement.lang = uiLanguage === 'en' ? 'en' : 'zh-CN';
    document.title =
      uiLanguage === 'en'
        ? 'OpenGEO · AI Search Visibility Workbench'
        : 'OpenGEO · AI 搜索可见性工作台';
  }, [uiLanguage]);

  const setUiLanguage = useCallback((next: GeoLanguage) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
      window.dispatchEvent(new Event(LANG_EVENT));
    } catch {
      // Ignore storage write errors.
    }
  }, []);

  const t = useCallback(
    (key: UiMessageKey, vars?: Record<string, string | number>) =>
      translateUi(uiLanguage, key, vars),
    [uiLanguage],
  );

  const value = useMemo(
    () => ({ uiLanguage, setUiLanguage, t }),
    [uiLanguage, setUiLanguage, t],
  );

  return (
    <UiLanguageContext.Provider value={value}>
      {children}
    </UiLanguageContext.Provider>
  );
}

export function useUiLanguage() {
  return useContext(UiLanguageContext);
}

const ZH_COMPANION_KEY = 'opengeo:include-zh-companion:v1';
const ZH_COMPANION_EVENT = 'opengeo:zh-companion-pref-change';

function subscribeChineseCompanion(callback: () => void) {
  if (typeof window === 'undefined') return () => {};
  const handler = () => callback();
  window.addEventListener(ZH_COMPANION_EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(ZH_COMPANION_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}

function readChineseCompanionPref(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(ZH_COMPANION_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function useChineseCompanionPreference(): [boolean, (next: boolean) => void] {
  const includeChineseCompanion = useSyncExternalStore(
    subscribeChineseCompanion,
    readChineseCompanionPref,
    () => true,
  );
  const setIncludeChineseCompanion = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(ZH_COMPANION_KEY, next ? 'true' : 'false');
      window.dispatchEvent(new Event(ZH_COMPANION_EVENT));
    } catch {
      // Ignore storage write errors.
    }
  }, []);
  return [includeChineseCompanion, setIncludeChineseCompanion];
}

export function UiLanguageToggle({
  className = '',
  fullLabels = false,
}: {
  className?: string;
  fullLabels?: boolean;
}) {
  const { uiLanguage, setUiLanguage, t } = useUiLanguage();
  return (
    <div
      className={`og-lang-switch ${className}`.trim()}
      role="group"
      aria-label={t('nav.uiLanguage')}
    >
      <button
        type="button"
        aria-pressed={uiLanguage === 'en'}
        onClick={() => setUiLanguage('en')}
      >
        {fullLabels ? 'English' : 'EN'}
      </button>
      <button
        type="button"
        aria-pressed={uiLanguage === 'zh'}
        onClick={() => setUiLanguage('zh')}
      >
        中文
      </button>
    </div>
  );
}
