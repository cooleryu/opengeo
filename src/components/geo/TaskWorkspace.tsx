import type { GeoTask } from '@/lib/geo/types';

type HistoryContext = { title: string; origin: string; summary: string };

function historyContext(task: GeoTask): HistoryContext | undefined {
  return (task as GeoTask & { historyContext?: HistoryContext }).historyContext;
}

export const isHistoricalTask = (task: GeoTask): boolean => Boolean(historyContext(task));

export const getTaskWorkspaceGroups = (tasks: GeoTask[]) => ({
  tasks: tasks.filter(
    (task) => !isHistoricalTask(task) || task.implementation?.kind === 'user_confirmed',
  ),
  monitor: tasks.filter((task) => task.implementation?.kind === 'user_confirmed'),
});
