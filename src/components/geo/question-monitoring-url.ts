/** Keep bookmarked result links on the single question-monitoring page. */
export function normalizeQuestionMonitoringUrl(url: URL): boolean {
  const params = url.searchParams;
  if (params.get('view') !== 'questions') return false;

  params.set('view', 'question-plan');
  params.set('questionSearch', params.get('search') ?? params.get('questionSearch') ?? '');
  if (params.get('group') === 'deferred') params.set('questionScope', 'backlog');
  params.delete('group');
  return true;
}
