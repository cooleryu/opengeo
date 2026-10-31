'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ResearchQuestion } from '@/lib/geo/research-types';

type OrderState = {
  key: string;
  questionIds: string[];
  ready: boolean;
  saving: boolean;
  error: string | null;
};

type RequestScope = {
  projectId: string;
  controller: AbortController;
  questionIds: string[];
  ready: boolean;
  saving: boolean;
};

function initialState(key: string): OrderState {
  return { key, questionIds: [], ready: false, saving: false, error: null };
}

function readOrder(value: unknown, projectId: string): string[] {
  if (!value || typeof value !== 'object') throw new Error('Invalid order response');
  const record = value as { projectId?: unknown; questionIds?: unknown };
  if (record.projectId !== projectId || !Array.isArray(record.questionIds) ||
    record.questionIds.some((id) => typeof id !== 'string' || !id) ||
    new Set(record.questionIds).size !== record.questionIds.length) {
    throw new Error('Invalid order response');
  }
  return record.questionIds as string[];
}

function orderQuestions(questions: ResearchQuestion[], questionIds: string[]): ResearchQuestion[] {
  if (!questionIds.length) return questions;
  const positions = new Map(questionIds.map((id, index) => [id, index]));
  return [...questions].sort((left, right) =>
    (positions.get(left.id) ?? questionIds.length) - (positions.get(right.id) ?? questionIds.length),
  );
}

export function useOverviewOrder(
  projectId: string,
  questions: ResearchQuestion[],
  allQuestionIds: string[],
  previewOnly = false,
) {
  const key = JSON.stringify([projectId, previewOnly]);
  const [state, setState] = useState<OrderState>(() => initialState(key));
  const scopeRef = useRef<RequestScope | null>(null);

  // Reset before rendering another project so its controls cannot use the old order.
  if (state.key !== key) setState(initialState(key));

  useEffect(() => {
    const scope: RequestScope = {
      projectId, controller: new AbortController(), questionIds: [], ready: false, saving: false,
    };
    scopeRef.current = scope;
    const active = () => scopeRef.current === scope && !scope.controller.signal.aborted;

    if (!previewOnly) {
      void (async () => {
        try {
          const response = await fetch(`/api/geo/overview-order?project=${encodeURIComponent(projectId)}`, {
            cache: 'no-store', signal: scope.controller.signal,
          });
          if (!response.ok) throw new Error('Order load failed');
          const questionIds = readOrder(await response.json(), projectId);
          if (!active()) return;
          scope.questionIds = questionIds;
          scope.ready = true;
          setState({ key, questionIds, ready: true, saving: false, error: null });
        } catch {
          if (active()) setState({ ...initialState(key), error: '显示顺序暂时无法加载。' });
        }
      })();
    }

    return () => {
      scope.controller.abort();
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [key, previewOnly, projectId]);

  const orderedQuestions = useMemo(
    () => previewOnly || state.key !== key ? questions : orderQuestions(questions, state.questionIds),
    [key, previewOnly, questions, state.key, state.questionIds],
  );

  const reorder = useCallback((nextVisibleIds: string[]) => {
    const scope = scopeRef.current;
    if (previewOnly || !scope || scope.projectId !== projectId || !scope.ready ||
      scope.saving || scope.controller.signal.aborted) return;

    const visibleIds = orderQuestions(questions, scope.questionIds).map((question) => question.id);
    const visible = new Set(visibleIds);
    const reordered = new Set(nextVisibleIds);
    if (nextVisibleIds.length < 2 || reordered.size !== nextVisibleIds.length ||
      nextVisibleIds.some((id) => !visible.has(id))) {
      setState((previous) => ({ ...previous, error: '显示顺序无效，请重试。' }));
      return;
    }
    const currentSubset = visibleIds.filter((id) => reordered.has(id));
    if (nextVisibleIds.every((id, index) => id === currentSubset[index])) return;

    const previousOrder = scope.questionIds;
    // Preserve hidden/historical slots; newly encountered IDs join at the end.
    const fullOrder = [...new Set([...previousOrder, ...visibleIds, ...allQuestionIds])];
    let visibleIndex = 0;
    const nextOrder = fullOrder.map((id) => reordered.has(id) ? nextVisibleIds[visibleIndex++] : id);
    scope.questionIds = nextOrder;
    scope.saving = true;
    setState({ key, questionIds: nextOrder, ready: true, saving: true, error: null });

    void (async () => {
      const active = () => scopeRef.current === scope && !scope.controller.signal.aborted;
      try {
        const response = await fetch('/api/geo/overview-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, questionIds: nextOrder }),
          signal: scope.controller.signal,
        });
        if (!response.ok) throw new Error('Order save failed');
        const questionIds = readOrder(await response.json(), projectId);
        if (!active()) return;
        scope.questionIds = questionIds;
        scope.saving = false;
        setState({ key, questionIds, ready: true, saving: false, error: null });
      } catch {
        if (!active()) return;
        scope.questionIds = previousOrder;
        scope.saving = false;
        setState({ key, questionIds: previousOrder, ready: true, saving: false, error: '顺序保存失败，已恢复。' });
      }
    })();
  }, [allQuestionIds, key, previewOnly, projectId, questions]);

  const current = state.key === key && !previewOnly;
  return {
    orderedQuestions,
    ready: current && state.ready,
    saving: current && state.saving,
    error: current ? state.error : null,
    reorder,
  };
}
