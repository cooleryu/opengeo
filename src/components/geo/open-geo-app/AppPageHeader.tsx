'use client';

import type { GeoState } from '@/lib/geo/types';
import { FileText, Search } from 'lucide-react';
import OpenGeoBrandMark from '../OpenGeoBrandMark';
import { useUiLanguage } from '../UiLanguageContext';
import type { Page , PageInfo } from './pages';

type AppPageHeaderProps = {
  projectId: string;
  pageInfo: PageInfo;
  page: Page;
  data: GeoState;
  openEvidence: (path: string) => Promise<void>;
};

export function AppPageHeader({
  projectId,
  pageInfo,
  page,
  data,
  openEvidence,
}: AppPageHeaderProps) {
  const { t, uiLanguage } = useUiLanguage();
  return (
    <header className="rw-page-heading">
      <div className="rw-heading-title">
        <a
          className="rw-brand"
          href={`/?view=overview&project=${projectId}`}
        >
          <OpenGeoBrandMark size={25} /> OpenGEO
        </a>
        <h1>
          {pageInfo.title && t(pageInfo.title)}
        </h1>
      </div>
      {page !== 'settings' && (
        <form
          className="rw-global-search"
          onSubmit={(event) => {
            event.preventDefault();
            const search = new FormData(event.currentTarget).get(
              'search',
            );
            const current = new URLSearchParams(
              window.location.search,
            );
            const target = new URL('/', window.location.origin);
            target.searchParams.set('view', 'question-plan');
            target.searchParams.set('project', projectId);
            target.searchParams.set('search', String(search || ''));
            target.searchParams.set('questionSearch', String(search || ''));
            for (const key of ['language', 'engine', 'ui'])
              if (current.has(key))
                target.searchParams.set(key, current.get(key)!);
            window.location.assign(target);
          }}
        >
          <Search size={15} />
          <input
            name="search"
            aria-label={uiLanguage === 'en' ? 'Search prompts' : '搜索项目内问题'}
            placeholder={uiLanguage === 'en' ? 'Search prompts…' : '搜索项目内问题…'}
          />
        </form>
      )}
      {page !== 'settings' && data.latestResearch && (
        <button
          className="rw-button"
          onClick={() =>
            openEvidence(data.latestResearch!.reportPath)
          }
        >
          <FileText size={15} />
          {uiLanguage === 'en' ? 'Research report' : '研究报告'}
        </button>
      )}
    </header>
  );
}
