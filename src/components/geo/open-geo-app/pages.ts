import { GitCompareArrows, LayoutDashboard, ListChecks, Search, type LucideIcon } from 'lucide-react';
import type { UiMessageKey } from '@/lib/geo/i18n';

/**
 * Every page of the workspace, in one place. The id is the `?view=` value in the address.
 * To add, remove or merge a page: change its row here, then its body in OpenGeoApp's main area.
 */
export type Page =
  | 'overview'
  | 'question-plan'
  | 'competitor'
  | 'tasks'
  | 'monitor'
  | 'assets'
  | 'traffic'
  | 'settings';

export type PageInfo = {
  /** Main-menu entry (rows are in menu order). Pages without one are reached from elsewhere. */
  menu?: { label: UiMessageKey; icon: LucideIcon };
  /** Menu entry shown as current while this page is open, when it isn't the page's own. */
  activeMenu?: Page;
  /** Shared workspace that draws the body: research results or the Action Plan. */
  workspace?: 'research' | 'action-plan';
  /** Title for the shared page header. Pages without one draw their own header. */
  title?: UiMessageKey;
};

export const PAGES: Record<Page, PageInfo> = {
  overview: { menu: { label: 'nav.overview', icon: LayoutDashboard }, workspace: 'research' },
  'question-plan': { menu: { label: 'nav.questions', icon: Search }, workspace: 'research' },
  competitor: { menu: { label: 'nav.competitor', icon: GitCompareArrows }, workspace: 'research' },
  tasks: { menu: { label: 'nav.tasks', icon: ListChecks }, workspace: 'action-plan' },
  monitor: { activeMenu: 'tasks', workspace: 'action-plan' },
  assets: { activeMenu: 'tasks', workspace: 'action-plan' },
  traffic: { title: 'nav.traffic' },
  settings: { title: 'term.settings' },
};

export const PAGE_IDS = Object.keys(PAGES) as Page[];

export const MENU_ITEMS = PAGE_IDS.flatMap((id) => {
  const menu = PAGES[id].menu;
  return menu ? [{ id, ...menu }] : [];
});
