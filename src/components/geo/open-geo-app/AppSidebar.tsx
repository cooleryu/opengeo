'use client';

import type { GeoState } from '@/lib/geo/types';
import { ArrowUpRight, Check, ChevronDown, type LucideIcon, Plus, Settings2 } from 'lucide-react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import OpenGeoBrandMark from '../OpenGeoBrandMark';
import { UiLanguageToggle, useUiLanguage } from '../UiLanguageContext';
import type { Page } from './pages';

type AppSidebarProps = {
  projectId: string;
  projectButton: RefObject<HTMLButtonElement>;
  projectMenuOpen: boolean;
  data: GeoState | null;
  busy: string;
  setProjectMenuOpen: Dispatch<SetStateAction<boolean>>;
  switchProject: (id: string) => void;
  navGroups: { id: string; label: null; items: { label: string; icon: LucideIcon; id: Page }[] }[];
  sidebarPage: Page;
  navigate: (nextPage: Page, taskId?: string, batchId?: string, hash?: string) => void;
  optNavBadge: { label: string; tone: string } | null;
  openModelSettings: () => void;
  page: Page;
};

export function AppSidebar({
  projectId,
  projectButton,
  projectMenuOpen,
  data,
  busy,
  setProjectMenuOpen,
  switchProject,
  navGroups,
  sidebarPage,
  navigate,
  optNavBadge,
  openModelSettings,
  page,
}: AppSidebarProps) {
  const { uiLanguage, t } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
    <aside className="og-sidebar">
      <a
        className="og-logo"
        href={`/?view=overview&project=${encodeURIComponent(projectId)}`}
        aria-label={isEn ? 'OpenGEO Home' : 'OpenGEO 首页'}
      >
        <OpenGeoBrandMark size={22} />OpenGEO
      </a>
      <div className="og-project-picker">
        <button
          ref={projectButton}
          className="og-project-trigger"
          aria-expanded={projectMenuOpen}
          aria-haspopup="menu"
          aria-controls="og-project-menu"
          disabled={!data || !!busy}
          onClick={() => setProjectMenuOpen(!projectMenuOpen)}
        >
          <span className="og-project-avatar">
            {data?.project.name.slice(0, 1).toUpperCase() || '·'}
          </span>
          <span className="og-project-label">
            <small>{t('nav.currentProject')}</small>
            <strong data-i18n-skip={data?.project.name ? '' : undefined}>
              {data?.project.name ?? (isEn ? 'Loading…' : '正在读取…')}
            </strong>
          </span>
          <ChevronDown size={15} />
        </button>
        {projectMenuOpen && data && (
          <div
            id="og-project-menu"
            className="og-project-menu"
            role="menu"
            aria-label={isEn ? 'Switch project' : '切换项目'}
            onKeyDown={(event) => {
              if (
                !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
              )
                return;
              event.preventDefault();
              const choices = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                  '[role="menuitemradio"], [role="menuitem"]',
                ),
              );
              const index = choices.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? choices.length - 1
                    : (index +
                        (event.key === 'ArrowDown' ? 1 : -1) +
                        choices.length) %
                      choices.length;
              choices[next]?.focus();
            }}
          >
            {(data.projects ?? [data.project]).map((project) => (
              <button
                key={project.id}
                role="menuitemradio"
                aria-checked={project.id === projectId}
                onClick={() => switchProject(project.id)}
              >
                <span className="og-project-avatar">
                  {project.name.slice(0, 1).toUpperCase()}
                </span>
                <strong data-i18n-skip="">{project.name}</strong>
                {project.id === projectId && <Check size={16} />}
              </button>
            ))}
            <a href="/new" role="menuitem" className="og-project-create-link"><Plus size={17} /><strong>{t('nav.newProject')}</strong></a>
          </div>
        )}
      </div>
      <nav aria-label={isEn ? 'Main navigation' : '主导航'}>
        {navGroups.map((group) => (
          <div
            key={group.id}
            className={`og-nav-group og-nav-${group.id}`}
          >
            {group.items.map((item) => (
              <button
                key={item.id}
                className={sidebarPage === item.id ? 'active' : ''}
                aria-current={sidebarPage === item.id ? 'page' : undefined}
                onClick={() => navigate(item.id)}
              >
                <item.icon size={17} />
                <span>{item.label}</span>
                {item.id === 'tasks' && optNavBadge && (
                  <small className={`og-nav-pill is-${optNavBadge.tone}`}>
                    {optNavBadge.label}
                  </small>
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>
      {data?.firstRun && (() => {
        const fr = data.firstRun;
        const projectId = data.project.id;
        const items = [
          {
            id: 'model',
            done: fr.modelReady,
            label: isEn ? 'Connect an AI model' : '连接 AI 模型',
            onClick: () => openModelSettings(),
          },
          {
            id: 'product',
            done: fr.productReady,
            label: isEn ? 'Add your product' : '添加你的产品',
            href: projectId ? `/new?project=${encodeURIComponent(projectId)}` : '/new',
          },
          {
            id: 'questions',
            done: fr.questionsReady,
            label: isEn ? 'Confirm buyer questions' : '确认买家问题',
            onClick: () => navigate('question-plan'),
          },
          {
            id: 'answers',
            done: fr.answersReady,
            label: isEn ? 'Collect AI answers' : '采集 AI 回答',
            onClick: () => navigate('overview'),
          },
          {
            id: 'plan',
            done: fr.actionPlanReady,
            label: isEn ? 'Create your Action Plan' : '生成行动计划',
            onClick: () => navigate('tasks'),
          },
        ];
        const doneCount = items.filter((item) => item.done).length;
        if (doneCount >= items.length) return null;
        const nextIndex = items.findIndex((item) => !item.done);
        return (
          <section
            className="og-first-run"
            aria-label={isEn ? 'Get started checklist' : '开始使用清单'}
          >
            <div className="og-first-run-header">
              <span>
                {isEn
                  ? `Get started · ${doneCount}/5`
                  : `开始使用 · ${doneCount}/5`}
              </span>
            </div>
            <ol className="og-first-run-list">
              {items.map((item, idx) => {
                const isNext = idx === nextIndex;
                const cls = `og-first-run-item${item.done ? ' is-done' : ''}${isNext ? ' is-next' : ''}`;
                const content = (
                  <>
                    <span className="og-first-run-mark" aria-hidden="true">
                      {item.done ? <Check size={11} /> : idx + 1}
                    </span>
                    <span className="og-first-run-label">{item.label}</span>
                  </>
                );
                return (
                  <li key={item.id}>
                    {item.href ? (
                      <a href={item.href} className={cls} aria-current={isNext ? 'step' : undefined}>
                        {content}
                      </a>
                    ) : (
                      <button
                        type="button"
                        className={cls}
                        aria-current={isNext ? 'step' : undefined}
                        onClick={item.onClick}
                      >
                        {content}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })()}
      <div className="og-sidebar-bottom">
        <UiLanguageToggle className="og-sidebar-lang" />
        <a
          href={data?.project.siteUrl || data?.project.repositoryUrl || undefined}
          aria-disabled={!data}
          target="_blank"
          rel="noreferrer"
        >
          {t('nav.visitProject')} <ArrowUpRight size={14} />
        </a>
        <button
          type="button"
          className="og-settings-link"
          aria-current={page === 'settings' ? 'page' : undefined}
          onClick={() => navigate('settings')}
        >
          {t('nav.settings')} <Settings2 size={14} />
        </button>
      </div>
    </aside>
  );
}
