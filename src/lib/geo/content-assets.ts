import type { GeoAsset, GeoQuestion, GeoState } from './types';
import { isConsumerResearchEngine } from './research-engines';
import type {
  ResearchBatch,
  ResearchObservation,
  ResearchQuestion,
  ResearchSource,
} from './research-types';

export type ContentGapCategory =
  | 'content'
  | 'evidence'
  | 'capability'
  | 'investigate';
export type ContentOwnership = 'owned' | 'external' | 'unknown';

export interface ContentReference {
  id: string;
  projectId: string;
  batchId: string;
  questionId: string;
  observationId: string;
  source: ResearchSource;
  observation: ResearchObservation;
  /** Opens the saved question, language and engine. The source URL stays in source.url. */
  href: string;
}

export interface ContentQuestionRelation {
  key: string;
  projectId: string;
  batchId: string;
  question: ResearchQuestion;
  references: ContentReference[];
  href: string;
}

export interface ContentRecordedMapping {
  id: string;
  question: GeoQuestion;
  /** An existing editorial mapping, not proof this page appeared in the answer. */
  basis: 'matchingAssetIds';
}

export interface ContentCoverage {
  question: ResearchQuestion;
  basis: string;
  evidencePath: string;
  /** Documented means an existing review relationship, never a tested capability. */
  status: 'documented' | 'candidate';
}

export interface ContentCounts {
  /** Saved ChatGPT source entries; not an inferred number of inline citation markers. */
  chatgptCitations: number;
  chatgptAnswers: number;
  /** Google ordinary results have a recorded position. */
  googleResults: number;
  googleOtherSources: number;
  googleSearches: number;
}

export interface ContentItem {
  id: string;
  projectId: string;
  origin: 'asset' | 'source';
  ownership: ContentOwnership;
  ownershipBasis: string;
  title: string;
  url: string | null;
  /** Original URLs are retained even when known equivalents share an entry. */
  urls: string[];
  kind: ResearchSource['kind'];
  kinds: ResearchSource['kind'][];
  asset?: GeoAsset;
  assetIds: string[];
  type: string;
  language: string;
  status: string;
  summary: string;
  /** Headings from saved content only; these do not establish answerability. */
  topics: string[];
  evidencePaths: string[];
  coverage: ContentCoverage[];
  questions: ContentQuestionRelation[];
  references: ContentReference[];
  recordedMappings: ContentRecordedMapping[];
  counts: ContentCounts;
}

export interface ContentGovernanceItem {
  id: string;
  projectId: string;
  batchId: string;
  question: ResearchQuestion;
  category: ContentGapCategory;
  raw: string;
  text: string;
  reviewPath: string;
  href: string;
}

export interface ContentWorkspace {
  projectId: string;
  batch: ResearchBatch | null;
  items: ContentItem[];
  governance: ContentGovernanceItem[];
  /** Historical data is exposed separately and never merged into current governance. */
  historicalGaps: GeoState['gaps'];
  warnings: string[];
}

function webUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

function githubParts(url: URL) {
  const parts = url.pathname.slice(1).split('/');
  if (parts.length === 3 && parts[2] === '') parts.pop();
  if (
    !['github.com', 'raw.githubusercontent.com'].includes(url.hostname) ||
    parts.length < 2 ||
    parts.some((part) => !part)
  ) {
    return null;
  }
  return {
    owner: parts[0].toLowerCase(),
    repo: parts[1].toLowerCase(),
    rest: parts.slice(2),
  };
}

/**
 * Page identity is conservative: keep protocol, path case, meaningful query
 * parameters, generic trailing slashes and hash routes. Remove known tracking
 * parameters and ordinary anchors; map GitHub blob/raw only for the same
 * repository, ref and file. A repository landing page is not its README URL.
 */
export function normalizeContentUrl(value: string | null): string | null {
  const url = webUrl(value);
  if (!url) return null;
  for (const name of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(name)) url.searchParams.delete(name);
  }
  if (!url.hash.startsWith('#/') && !url.hash.startsWith('#!')) url.hash = '';
  const github = githubParts(url);
  if (github) {
    const { owner, repo, rest } = github;
    if (
      url.hostname === 'github.com' &&
      rest[0] === 'blob' &&
      rest.length >= 3
    ) {
      return `${url.protocol}//raw.githubusercontent.com/${owner}/${repo}/${rest.slice(1).join('/')}${url.search}${url.hash}`;
    }
    if (url.hostname === 'raw.githubusercontent.com' && rest.length >= 2) {
      return `${url.protocol}//raw.githubusercontent.com/${owner}/${repo}/${rest.join('/')}${url.search}${url.hash}`;
    }
    // GitHub repository URLs with and without a final slash identify one repository.
    url.pathname = `/${owner}/${repo}${rest.length ? '/' + rest.join('/') : ''}`;
  }
  return url.href;
}

function questionHref(
  projectId: string,
  questionId: string,
  language: ResearchObservation['language'] = 'zh',
  engine: ResearchObservation['engine'] | 'all' = 'all',
) {
  const params = new URLSearchParams({
    view: 'questions',
    project: projectId,
    question: questionId,
    language,
    engine,
  });
  return '/?' + params.toString();
}

function sourceOwnership(
  source: ResearchSource,
  data: GeoState,
): Pick<ContentItem, 'ownership' | 'ownershipBasis'> {
  if (source.kind !== 'official') {
    return {
      ownership: 'external',
      ownershipBasis:
        source.kind === 'self_submission'
          ? '本批次记为第三方平台自荐'
          : source.kind === 'mirror'
            ? '本批次记为镜像来源'
            : '本批次记为外部来源',
    };
  }
  const current = webUrl(source.url);
  const repository = webUrl(data.project.repositoryUrl);
  const currentRepo = current && githubParts(current);
  const projectRepo = repository && githubParts(repository);
  if (
    currentRepo &&
    projectRepo &&
    currentRepo.owner === projectRepo.owner &&
    currentRepo.repo === projectRepo.repo
  ) {
    return {
      ownership: 'owned',
      ownershipBasis: '本批次标为官方；URL 位于项目的同一 GitHub 仓库',
    };
  }
  const site = webUrl(data.project.siteUrl);
  if (
    current &&
    site &&
    normalizeContentUrl(current.href) === normalizeContentUrl(site.href)
  ) {
    return { ownership: 'owned', ownershipBasis: 'URL 与已登记的项目入口一致' };
  }
  // A scoped site path can be checked, but a shared hostname by itself cannot.
  if (
    current &&
    site &&
    !githubParts(site) &&
    site.pathname !== '/' &&
    current.origin === site.origin
  ) {
    const prefix = site.pathname.endsWith('/')
      ? site.pathname
      : site.pathname + '/';
    if (current.pathname.startsWith(prefix)) {
      return {
        ownership: 'owned',
        ownershipBasis: '本批次标为官方；URL 位于已登记的项目站点路径下',
      };
    }
  }
  return {
    ownership: 'unknown',
    ownershipBasis: '本批次标为官方，但尚未对应到已登记的资产或项目入口',
  };
}

function emptyCounts(): ContentCounts {
  return {
    chatgptCitations: 0,
    chatgptAnswers: 0,
    googleResults: 0,
    googleOtherSources: 0,
    googleSearches: 0,
  };
}

/** Aggregate saved links while deduplicating the same reference across assets. */
export function countContentReferences(
  references: ContentReference[],
): ContentCounts {
  const unique = [
    ...new Map(
      references.map((reference) => [reference.id, reference]),
    ).values(),
  ];
  const chatgpt = unique.filter(
    (reference) => reference.observation.engine === 'chatgpt',
  );
  const google = unique.filter(
    (reference) => reference.observation.engine === 'google',
  );
  return {
    chatgptCitations: chatgpt.length,
    chatgptAnswers: new Set(chatgpt.map((reference) => reference.observationId))
      .size,
    googleResults: google.filter(
      (reference) => reference.source.position !== undefined,
    ).length,
    googleOtherSources: google.filter(
      (reference) => reference.source.position === undefined,
    ).length,
    googleSearches: new Set(google.map((reference) => reference.observationId))
      .size,
  };
}

// Public source contains no pre-approved relationships from private research.
function assetCoverage(
  _asset: GeoAsset,
  _batch: ResearchBatch | null,
): ContentCoverage[] {
  return [];
}

function headings(asset: GeoAsset): string[] {
  const titles = asset.markdown
    .split('\n')
    .filter((line) => /^#{1,3}\s+/.test(line))
    .map((line) =>
      line
        .replace(/^#{1,3}\s+/, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*`]/g, '')
        .trim(),
    )
    .filter((title) => title && title !== asset.title);
  return [...new Set(titles)].slice(0, 6);
}

function gapCategory(raw: string): {
  category: ContentGapCategory;
  text: string;
} {
  const prefix = raw.match(/^\s*(内容|证据|能力|待调查|调查)\s*[：:]\s*/);
  const categories: Record<string, ContentGapCategory> = {
    内容: 'content',
    证据: 'evidence',
    能力: 'capability',
    待调查: 'investigate',
    调查: 'investigate',
  };
  return {
    category: prefix ? categories[prefix[1]] : 'investigate',
    text: prefix ? raw.slice(prefix[0].length) : raw,
  };
}

/** Builds a view over saved data only: no fetching, persistence or inferred tasks. */
export function buildContentWorkspace(data: GeoState): ContentWorkspace {
  const projectId = data.project.id;
  const batch =
    data.latestResearch?.projectId === projectId ? data.latestResearch : null;
  const warnings =
    data.latestResearch && !batch
      ? ['研究批次与当前项目不一致，未将它的来源和缺口并入当前目录。']
      : [];
  const items: ContentItem[] = data.assets.map((asset, index) => ({
    id: `${projectId}:asset:${asset.id}:${index}`,
    projectId,
    origin: 'asset',
    ownership: 'owned',
    ownershipBasis: '当前项目已登记的内容资产；内容自述不等于实测能力',
    title: asset.title,
    url: asset.publicUrl,
    urls: asset.publicUrl ? [asset.publicUrl] : [],
    kind: 'official',
    kinds: ['official'],
    asset,
    assetIds: [asset.id],
    type: asset.type,
    language: asset.language,
    status: asset.status,
    summary: asset.summary,
    topics: headings(asset),
    evidencePaths: [
      ...new Set([asset.sourcePath, ...asset.evidencePaths].filter(Boolean)),
    ],
    coverage: assetCoverage(asset, batch),
    questions: [],
    references: [],
    recordedMappings: data.questions.flatMap((question, questionIndex) =>
      question.matchingAssetIds?.includes(asset.id)
        ? [
            {
              id: `${projectId}:legacy:${question.id}:${questionIndex}`,
              question,
              basis: 'matchingAssetIds' as const,
            },
          ]
        : [],
    ),
    counts: emptyCounts(),
  }));
  const pages = new Map<string, ContentItem[]>();
  for (const item of items) {
    const normalized = normalizeContentUrl(item.url);
    if (normalized)
      pages.set(normalized, [...(pages.get(normalized) ?? []), item]);
  }

  const governance: ContentGovernanceItem[] = [];
  for (const [questionIndex, question] of [
    ...(batch?.questions ?? []),
    ...(batch?.deferredQuestions ?? []),
  ].entries()) {
    if (!batch) break;
    const key = `${projectId}:${batch.id}:${question.id}`;
    for (const [gapIndex, raw] of question.gaps.entries()) {
      governance.push({
        id: `${key}:gap:${gapIndex}`,
        projectId,
        batchId: batch.id,
        question,
        raw,
        ...gapCategory(raw),
        reviewPath: question.reviewPath || batch.reviewPath,
        href: questionHref(projectId, question.id),
      });
    }
    for (const [
      observationIndex,
      observation,
    ] of question.observations.entries()) {
      // This workspace currently reports consumer ChatGPT and Google sources.
      // API sources remain available in their research records, never reclassified.
      if (!isConsumerResearchEngine(observation.engine)) continue;
      // Array identity retains repeated recorded answers; only links within the
      // same observation share an answer identity and are deduplicated in counts.
      const observationId = `${key}:${questionIndex}:observation:${observationIndex}`;
      for (const [sourceIndex, source] of observation.sources.entries()) {
        const normalized = normalizeContentUrl(source.url);
        // An invalid URL stays inspectable but cannot be associated with an asset.
        const pageKey =
          normalized ?? `unmatched:${observationId}:${sourceIndex}`;
        let targets = pages.get(pageKey);
        if (!targets) {
          const identity = sourceOwnership(source, data);
          const item: ContentItem = {
            id: `${projectId}:source:${items.length}`,
            projectId,
            origin: 'source',
            ...identity,
            title: source.title || source.url,
            url: source.url,
            urls: [source.url],
            kind: source.kind,
            kinds: [source.kind],
            assetIds: [],
            type: 'source_page',
            language: 'unknown',
            status:
              identity.ownership === 'owned'
                ? 'not_catalogued'
                : 'observed_source',
            summary: '',
            topics: [],
            evidencePaths: [],
            coverage: [],
            questions: [],
            references: [],
            recordedMappings: [],
            counts: emptyCounts(),
          };
          items.push(item);
          targets = [item];
          pages.set(pageKey, targets);
        }
        const reference: ContentReference = {
          id: `${observationId}:source:${sourceIndex}`,
          projectId,
          batchId: batch.id,
          questionId: question.id,
          observationId,
          source,
          observation,
          href: questionHref(
            projectId,
            question.id,
            observation.language,
            observation.engine,
          ),
        };
        for (const item of targets) {
          item.references.push(reference);
          if (!item.urls.includes(source.url)) item.urls.push(source.url);
          if (!item.kinds.includes(source.kind)) item.kinds.push(source.kind);
          for (const path of [
            observation.evidencePath,
            observation.answerPath,
          ].filter((value): value is string => Boolean(value))) {
            if (!item.evidencePaths.includes(path))
              item.evidencePaths.push(path);
          }
          let relation = item.questions.find((entry) => entry.key === key);
          if (!relation) {
            relation = {
              key,
              projectId,
              batchId: batch.id,
              question,
              references: [],
              href: questionHref(projectId, question.id),
            };
            item.questions.push(relation);
          }
          relation.references.push(reference);
        }
      }
    }
  }
  for (const item of items) {
    item.counts = countContentReferences(item.references);
  }
  return {
    projectId,
    batch,
    items,
    governance,
    historicalGaps: [...data.gaps],
    warnings,
  };
}
