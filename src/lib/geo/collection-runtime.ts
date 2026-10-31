import type { GeoQuestion, GeoTask } from './types';
import { chargeTask, getTask } from './store';

/** Research collection may explicitly run without a spending cap. */
export type CollectionTask = Omit<GeoTask, 'monitor'> & {
  monitor: Omit<GeoTask['monitor'], 'budgetLimit'> & { budgetLimit: number | null };
};

export interface CollectionRuntime {
  getTask: (taskId: string) => CollectionTask;
  chargeTask: (taskId: string, cost: number) => void;
  /** Publish the active question immediately before its request is dispatched. */
  onQuestionStart?: (question: GeoQuestion) => void;
  /** Persist and validate the result before advancing to the next question. */
  onObservation?: (question: GeoQuestion) => void | Promise<void>;
}

export const defaultCollectionRuntime: CollectionRuntime = { getTask, chargeTask };
