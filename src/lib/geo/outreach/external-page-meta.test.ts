import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDefaultDirectoryListingDraft,
  classifyCitedExternalPage,
  getExternalListingType,
  humanizeCitedPageTitle,
  isSelfServeDirectoryPage,
  wholeSummary,
} from './external-page-meta';

test('wholeSummary never ends a pasted blurb mid-sentence', () => {
  const long =
    'OpenGEO is an open-source, local-first AI search visibility workbench: it captures real ChatGPT and Google AI Overview answers from your own browser, shows who got named and whose pages got cited.';
  assert.equal(wholeSummary(long, 140), 'OpenGEO is an open-source, local-first AI search visibility workbench.');
  assert.equal(wholeSummary('Short and whole.', 140), 'Short and whole.');
  assert.equal(
    wholeSummary('First sentence stays whole. Second sentence is far too long to fit inside the limit at all.', 60),
    'First sentence stays whole.',
  );
  assert.equal(wholeSummary('one two three four five six seven eight nine ten eleven', 30), 'one two three four five six…');
});

test('distinguishes true self-serve directories from third-party editorial roundup articles', () => {
  assert.equal(
    isSelfServeDirectoryPage({
      url: 'https://www.g2.com/categories/ai-visibility',
      title: 'Best AI Visibility Tools',
    }),
    true,
  );
  assert.equal(
    isSelfServeDirectoryPage({
      url: 'https://openalternative.co/alternatives/profound',
      title: 'OpenAlternative',
    }),
    true,
  );
  assert.equal(
    isSelfServeDirectoryPage({
      url: 'https://www.accessibilitychecker.org/guides/best-ai-visibility-tools/',
      title: 'AccessibilityChecker.org',
    }),
    false,
  );
  assert.equal(
    getExternalListingType({
      url: 'https://www.accessibilitychecker.org/guides/best-ai-visibility-tools/',
      title: 'AccessibilityChecker.org',
    }),
    'editorial_roundup',
  );
  assert.equal(
    getExternalListingType({
      url: 'https://canonry.ai/blog/best-free-aeo-ai-visibility-tools-for-agencies',
      title: 'canonry.ai',
    }),
    'editorial_roundup',
  );
  assert.equal(
    classifyCitedExternalPage({
      url: 'https://blog.estevecastells.com/ai/profound-alternatives/',
      title: 'Esteve Castells',
    }),
    'directory_listing',
  );
  assert.equal(
    classifyCitedExternalPage({
      url: 'https://www.reddit.com/r/AI_Agents/comments/1w9mwc6/what_is_the_best_tool_to_track_brand_mentions_in/',
      title: 'Reddit · r/AI_Agents',
    }),
    'community_post',
  );
});

test('humanizeCitedPageTitle expands bare domain and subreddit labels from URL slugs while preserving descriptive titles', () => {
  assert.equal(
    humanizeCitedPageTitle(
      'AccessibilityChecker.org',
      'https://www.accessibilitychecker.org/guides/best-ai-visibility-tools/',
      'accessibilitychecker.org',
    ),
    'Best AI Visibility Tools — AccessibilityChecker.org',
  );
  assert.equal(
    humanizeCitedPageTitle(
      'canonry.ai',
      'https://canonry.ai/blog/best-free-aeo-ai-visibility-tools-for-agencies',
      'canonry.ai',
    ),
    'Best Free AEO AI Visibility Tools for Agencies — canonry.ai',
  );
  assert.equal(
    humanizeCitedPageTitle(
      'Reddit · r/AI_Agents',
      'https://www.reddit.com/r/AI_Agents/comments/1w9mwc6/what_is_the_best_tool_to_track_brand_mentions_in/',
      'reddit.com',
    ),
    'r/AI_Agents: What is the best tool to track brand mentions in',
  );
  assert.equal(
    humanizeCitedPageTitle(
      'Profound AI Alternatives & Competitors for AI Visibility (2026 Guide)',
      'https://www.sitepoint.com/best-profound-ai-alternatives/',
      'sitepoint.com',
    ),
    'Profound AI Alternatives & Competitors for AI Visibility (2026 Guide)',
  );
});

test('buildDefaultDirectoryListingDraft produces an author outreach pitch for editorial roundups and a product profile for directories', () => {
  const editorialDraft = buildDefaultDirectoryListingDraft(
    {
      name: 'OpenGEO',
      description: 'Local-first open-source AI visibility workbench.',
      screenshotUrl: 'https://raw.githubusercontent.com/cooleryu/opengeo/main/docs/overview.png',
      repositoryUrl: 'https://github.com/cooleryu/opengeo',
      siteUrl: '',
    },
    {
      title: 'AccessibilityChecker.org',
      url: 'https://www.accessibilitychecker.org/guides/best-ai-visibility-tools/',
      host: 'accessibilitychecker.org',
    },
  );
  assert.equal(editorialDraft.listingType, 'editorial_roundup');
  assert.match(editorialDraft.submissionPitch, /^Subject:/);
  assert.match(editorialDraft.submissionPitch, /Hi accessibilitychecker\.org team,/);
  assert.match(editorialDraft.submissionPitch, /Ready-to-paste blurb/);
  assert.match(editorialDraft.submissionPitch, /Product screenshot: https:\/\/raw\.githubusercontent\.com/);
  assert.match(editorialDraft.submissionPitch, /Best AI Visibility Tools/);
  assert.equal(/for listing consideration/i.test(editorialDraft.submissionPitch), false);

  const cjkFallbackDraft = buildDefaultDirectoryListingDraft(
    {
      name: 'OpenGEO',
      description: '开源、本地运行的 AI 搜索可见性工作台',
      englishSummary: 'Open-source local-first AI search visibility workbench.',
      repositoryUrl: 'https://github.com/cooleryu/opengeo',
      siteUrl: '',
    },
    {
      title: 'AccessibilityChecker.org',
      url: 'https://www.accessibilitychecker.org/guides/best-ai-visibility-tools/',
      host: 'accessibilitychecker.org',
    },
  );
  assert.equal(/[\u3400-\u9fff]/.test(cjkFallbackDraft.submissionPitch), false);
  assert.match(cjkFallbackDraft.submissionPitch, /local-first AI search visibility/);

  const dirDraft = buildDefaultDirectoryListingDraft(
    {
      name: 'OpenGEO',
      description: 'Local-first open-source AI visibility workbench.',
      repositoryUrl: 'https://github.com/cooleryu/opengeo',
      siteUrl: '',
    },
    {
      title: 'Best AI Visibility Tools',
      url: 'https://www.g2.com/categories/ai-visibility',
      host: 'g2.com',
    },
  );
  assert.equal(dirDraft.listingType, 'directory');
  assert.match(dirDraft.submissionPitch, /Product: OpenGEO/);
  assert.match(dirDraft.submissionPitch, /g2\.com/);
});
