import type { GeoAsset, GeoProject, GeoTask } from '@/lib/geo/types';

export type TaskPresentation = {
  title: string;
  targetTitle: string;
  targetUrl: string;
  observation: string | null;
  changeSummary: string;
};

export function taskProviderLabel(task: GeoTask): string {
  const provider =
    task.workflow?.collection?.provider ??
    task.collectionProvider ??
    'deepseek';
  return { deepseek: 'DeepSeek', qwen: '千问', doubao: '豆包' }[provider];
}

const paragraphs = (text: string) =>
  text
    .trim()
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .filter(Boolean);

/** Only describe an insertion when every original paragraph is preserved. */
function insertedParagraphs(before: string, after: string) {
  const original = paragraphs(before);
  const revised = paragraphs(after);
  if (!before.trim() || revised.length <= original.length) return null;
  let position = 0;
  const additions: { text: string; afterOriginalParagraph: number }[] = [];
  for (const text of revised) {
    if (text === original[position]) position += 1;
    else additions.push({ text, afterOriginalParagraph: position });
  }
  return position === original.length ? additions : null;
}

function isOpeningExcerpt(
  asset: GeoAsset | undefined,
  before: string,
): boolean {
  if (!asset?.markdown || !before.trim()) return false;
  const start = asset.markdown.indexOf(before.trim());
  if (start < 0) return false;
  // Titles, subtitles and author credits can precede the first body paragraph.
  const precedingBody = paragraphs(asset.markdown.slice(0, start)).filter(
    (text) => !/^(?:#{1,6}\s|>\s|\*\*(?:作者|Author)\s*[:：])/i.test(text),
  );
  return precedingBody.length < 2;
}

function baselineObservation(task: GeoTask): string | null {
  const baseline = task.workflow?.baseline;
  if (
    !baseline ||
    baseline.mode !== 'live' ||
    baseline.status !== 'completed' ||
    baseline.queryCount < 1 ||
    baseline.completedCount !== baseline.queryCount ||
    baseline.questions.length !== baseline.queryCount
  )
    return null;

  const questions = baseline.questions;
  const count = questions.length;
  const provider = taskProviderLabel(task);
  const answers =
    task.workflow?.collection?.metric === 'answer_target_citation' ||
    questions.some((question) => !!question.answer);
  if (answers) {
    if (
      questions.some(
        (question) =>
          !question.answer?.text.trim() ||
          typeof question.aiCited !== 'boolean',
      )
    )
      return null;
    const cited = questions.filter(
      (question) => question.aiCited === true,
    ).length;
    return `本次 ${count} 个问题中，${provider}联网回答 API 有 ${cited} 个回答引用了本项目。`;
  }
  const found = questions.filter((question) => question.projectHit).length;
  return `本次用 ${provider} 搜索 API 查询 ${count} 个问题，${found} 个问题的结果中找到本项目。`;
}

export function taskPresentation(
  task: GeoTask,
  assets: GeoAsset[],
  project: GeoProject,
): TaskPresentation {
  const proposal = task.proposal;
  const asset = assets.find((item) => item.id === proposal?.targetAssetId);
  const targetUrl = proposal?.targetUrl || asset?.publicUrl || '';
  const homepage =
    asset?.type === 'homepage' ||
    (!!targetUrl &&
      targetUrl.replace(/\/$/, '') === project.siteUrl.replace(/\/$/, ''));
  const targetTitle = homepage ? '项目首页' : asset?.title || '待确定的页面';
  const observation = baselineObservation(task);
  const base = { targetTitle, targetUrl, observation };

  if (!proposal) {
    const shortGoal = task.title.trim();
    return {
      ...base,
      title:
        shortGoal.length <= 32 && !/验证|诊断|API|复检|闭环/.test(shortGoal)
          ? shortGoal
          : '检查项目在 AI 搜索中的表现',
      changeSummary: '完成调查后，这里会显示建议修改的页面和内容。',
    };
  }

  const additions = insertedParagraphs(proposal.before, proposal.after);
  const opening =
    !!additions?.length &&
    additions.every((item) => item.afterOriginalParagraph <= 2) &&
    isOpeningExcerpt(asset, proposal.before);
  const addedText = additions?.map((item) => item.text).join('\n') || '';
  const introducesProject =
    !!project.name &&
    addedText.toLowerCase().includes(project.name.toLowerCase()) &&
    !proposal.before.toLowerCase().includes(project.name.toLowerCase()) &&
    /介绍|定义|摘要|identity|introduction|summary/i.test(proposal.title);
  const summarizesArticle = /摘要|summary/i.test(proposal.title);
  const additionName = introducesProject
    ? '项目介绍'
    : summarizesArticle
      ? '内容摘要'
      : '说明';
  const plainTitle = proposal.title.trim();
  let title: string;
  if (homepage) title = '完善项目首页的说明';
  else if (opening) title = `在文章开头补充${additionName}`;
  else if (
    plainTitle.length <= 32 &&
    !/验证|原生引用|锚定|诊断|API|复检|闭环/.test(plainTitle)
  )
    title = plainTitle;
  else title = asset ? `修改《${asset.title}》` : '修改页面内容';

  let changeSummary = '用下面这段内容替换页面中的对应原文。';
  if (proposal.before === proposal.after)
    changeSummary = '当前方案没有改动正文；可展开查看发布与检查的安排。';
  else if (opening)
    changeSummary = `在文章开头补充${additionName}，这段原文的其他内容保持不变。`;
  else if (additions?.length)
    changeSummary = '在这段原文中补充内容，保留原有文字。';

  return { ...base, title, changeSummary };
}
