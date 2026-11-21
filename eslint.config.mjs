import nextVitals from 'eslint-config-next/core-web-vitals';

// Browser globals that are easy to hit by accident. When code moves into a new
// component and a local such as `close` or `status` is not passed in, the bare
// name silently resolves to `window.close` / `window.status` and still compiles.
const confusingBrowserGlobals = [
  'addEventListener', 'blur', 'close', 'closed', 'confirm', 'defaultStatus', 'defaultstatus',
  'event', 'external', 'find', 'focus', 'frameElement', 'frames', 'history', 'innerHeight',
  'innerWidth', 'length', 'location', 'locationbar', 'menubar', 'moveBy', 'moveTo', 'name',
  'onblur', 'onerror', 'onfocus', 'onload', 'onresize', 'onunload', 'open', 'opener', 'opera',
  'outerHeight', 'outerWidth', 'pageXOffset', 'pageYOffset', 'parent', 'print',
  'removeEventListener', 'resizeBy', 'resizeTo', 'screen', 'screenLeft', 'screenTop', 'screenX',
  'screenY', 'scroll', 'scrollbars', 'scrollBy', 'scrollTo', 'scrollX', 'scrollY', 'self',
  'status', 'statusbar', 'stop', 'toolbar', 'top',
].map((name) => ({
  name,
  message: `Write window.${name} explicitly, or pass the local value in as a prop.`,
}));

// Source files may not exceed 600 lines (blank lines and comments not counted).
// Files listed below were already over the cap: each number is a ceiling, not an
// allowance. Shrink the file and lower or delete its entry; never raise it.
const MAX_LINES = 600;
const maxLinesCeilings = {
  'src/components/geo/ProjectOverview.tsx': 671,
  'src/components/geo/OptimizationStudio.tsx': 1100,
  'src/components/geo/OpenGeoApp.tsx': 1131,
  'src/lib/geo/optimization/page-audit.ts': 1782,
  'src/lib/geo/outreach/outreach-actions.ts': 1527,
  'src/components/geo/ResearchPanel.tsx': 1503,
  'src/components/geo/QuestionManagementPanel.tsx': 1432,
  'src/lib/geo/optimization/engine.ts': 1326,
  'src/components/geo/PageAuditSection.tsx': 1351,
  'src/components/geo/CompetitorCandidates.tsx': 1207,
  'src/components/geo/OptimizationHeroCard.tsx': 1114,
  'src/lib/geo/store.ts': 1102,
  'src/components/geo/DeliverableArticleView.tsx': 1085,
  'src/components/geo/ProjectOnboardingPage.tsx': 924,
  'src/lib/geo/question-planner.ts': 937,
  'src/components/geo/OutreachActionCards.tsx': 848,
  'src/components/geo/QuestionPlanPanel.tsx': 828,
  'src/lib/geo/i18n.ts': 827,
  'src/lib/geo/research-view.ts': 770,
  'src/lib/geo/db/repository.ts': 718,
  'src/components/geo/VisibilityPanel.tsx': 670,
};
const maxLinesRule = (max) => ['error', { max, skipBlankLines: true, skipComments: true }];

export default [
  ...nextVitals,
  {
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'JSXOpeningElement[name.type="JSXIdentifier"][name.name="select"]',
          message:
            'OpenGEO 不使用原生 <select>。请复用 src/components/geo/GeoSelect.tsx，保持下拉菜单样式一致。',
        },
      ],
      'no-restricted-globals': ['error', ...confusingBrowserGlobals],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.ts'],
    rules: { 'max-lines': maxLinesRule(MAX_LINES) },
  },
  ...Object.entries(maxLinesCeilings).map(([file, max]) => ({
    files: [file],
    rules: { 'max-lines': maxLinesRule(max) },
  })),
];
