'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { CalendarClock, Search, X } from 'lucide-react';
import type { ResearchBatch } from '@/lib/geo/research-types';
import type {
  CollectionProvider,
  CollectionProviderStatus,
} from '@/lib/geo/providers/types';
import {
  normalizeResearchBudget,
  type MoneyBudget,
} from '@/lib/geo/research-budget';
import type { ResearchSchedule } from '@/lib/geo/research-tracking-types';
import GeoSelect from './GeoSelect';
import './research-search-controls.css';

type Props = {
  projectId: string;
  batch: ResearchBatch | null;
  selectedIds: string[];
  language: 'zh' | 'en';
  provider: CollectionProvider;
  providers: CollectionProviderStatus[];
  onProviderChange: (provider: CollectionProvider) => void;
  budget: MoneyBudget;
  onBudgetChange: (budget: MoneyBudget) => void;
  budgetEnabled: boolean;
  onBudgetEnabledChange: (enabled: boolean) => void;
  busy: boolean;
  searching: boolean;
  runningCount: number;
  onSearch: (ids: string[]) => void;
  confirmQuestionIds: string[] | null;
  onCloseConfirm: () => void;
  onConfirmSearch: () => void;
  onRefresh?: () => void | Promise<void>;
};

const trackingCostFor = (count: number) => count * 0.005;
const providerNames: Record<CollectionProvider, string> = {
  deepseek: 'DeepSeek',
  doubao: '豆包',
  qwen: '千问',
};
type SearchOption = CollectionProvider | 'chatgpt' | 'google';
const money = (amount: number) => `¥${amount.toFixed(3).replace(/0$/, '')}`;
const budgetText = (budget: MoneyBudget) =>
  `${budget.currency === 'USD' ? '$' : '¥'}${budget.amount}`;
const plansVersion = (plans: ResearchSchedule[]) =>
  JSON.stringify(
    plans
      .map(({ id, updatedAt, lastRunId }) => ({ id, updatedAt, lastRunId }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );

function validBudget(budget: MoneyBudget) {
  try {
    return { value: normalizeResearchBudget(budget), error: '' };
  } catch (failure) {
    return {
      value: null,
      error: failure instanceof Error ? failure.message : '请填写有效预算。',
    };
  }
}

function BudgetFields({
  value,
  onChange,
  label,
  disabled,
  portalTarget,
}: {
  value: MoneyBudget;
  onChange: (budget: MoneyBudget) => void;
  label: string;
  disabled: boolean;
  portalTarget?: RefObject<HTMLElement | null>;
}) {
  const normalized = validBudget(value);
  return (
    <div className="qm-money-fields">
      <label className="qm-money-amount">
        <span>{label}</span>
        <input
          type="number"
          aria-label={label}
          min="0.001"
          step="0.001"
          value={Number.isFinite(value.amount) ? value.amount : ''}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, amount: event.target.valueAsNumber })
          }
        />
      </label>
      <GeoSelect<MoneyBudget['currency']>
        label={`${label}币种`}
        value={value.currency}
        disabled={disabled}
        portalTarget={portalTarget}
        onChange={(currency) =>
          onChange({
            currency,
            amount: value.amount,
          })
        }
        options={[
          { value: 'CNY', label: 'CNY 人民币' },
          { value: 'USD', label: 'USD 美元' },
        ]}
      />
      {value.currency === 'USD' && (
        <>
          <label className="qm-exchange-rate">
            1 USD =
            <input
              type="number"
              aria-label={`${label}美元换算率（每美元人民币）`}
              placeholder="填写换算率"
              min="0.0001"
              step="any"
              value={Number.isFinite(value.cnyPerUsd) ? value.cnyPerUsd : ''}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...value, cnyPerUsd: event.target.valueAsNumber })
              }
            />
            CNY
          </label>
          <span className="qm-budget-converted">
            {normalized.value
              ? `折合 ${money(normalized.value.limitCny)}`
              : '请填写预算换算率'}
          </span>
        </>
      )}
      {normalized.error && (
        <span className="qm-budget-error">{normalized.error}</span>
      )}
    </div>
  );
}

const scheduleStatuses: Record<string, string> = {
  active: '跟踪中',
  paused: '已暂停',
  stopped: '已停止',
  budget_exhausted: '预算已用尽',
  failed: '执行异常',
  exhausted: '预算已用尽',
  error: '执行异常',
};

function beijingTime(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export default function ResearchSearchControls({
  projectId,
  batch,
  selectedIds,
  language,
  provider,
  providers,
  onProviderChange,
  budget,
  onBudgetChange,
  budgetEnabled,
  onBudgetEnabledChange,
  busy,
  searching,
  onSearch,
  confirmQuestionIds,
  onCloseConfirm,
  onConfirmSearch,
  onRefresh,
}: Props) {
  const searchDialog = useRef<HTMLDialogElement>(null);
  const searchDialogTitle = useId();
  const budgetFieldsId = useId();
  const [showTracking, setShowTracking] = useState(false);
  const [plans, setPlans] = useState<ResearchSchedule[]>([]);
  const [trackingBudget, setTrackingBudget] = useState<MoneyBudget>({
    currency: 'CNY',
    amount: 0.1,
  });
  const [timeOfDay, setTimeOfDay] = useState('09:00');
  const [confirmed, setConfirmed] = useState(false);
  const [trackingError, setTrackingError] = useState('');
  const [trackingNotice, setTrackingNotice] = useState('');
  const [trackingBusy, setTrackingBusy] = useState(false);
  const [loadingPlans, setLoadingPlans] = useState(false);
  const mounted = useRef(true);
  const plansFetch = useRef<AbortController | null>(null);
  const lastPlansVersion = useRef<string | null>(null);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const mutation = useRef(false);
  const createRequest = useRef<{ key: string; id: string } | null>(null);
  const hasActivePlans = plans.some(
    (plan) => plan.status === 'active' || !!plan.activeRunId,
  );
  const coreIds = batch?.questions.map((question) => question.id) ?? [];
  const trackedIds = selectedIds.length ? selectedIds : coreIds;
  const trackingScopeKey = `${batch?.id}:${language}:${trackedIds.join(',')}:${timeOfDay}`;
  const missingLanguageIds = new Set(
    batch?.questions
      .filter((question) => !question[language]?.trim())
      .map((question) => question.id) ?? [],
  );
  const hasMissingLanguage = (ids: string[]) =>
    ids.some((id) => missingLanguageIds.has(id));
  const canSearch = providers.some(
    (item) => item.id === provider && item.configured,
  );
  const deepseekConfigured = providers.some(
    (item) => item.id === 'deepseek' && item.configured,
  );
  const providerOptions: {
    value: SearchOption;
    label: string;
    disabled?: boolean;
  }[] = [
    ...(['deepseek', 'doubao', 'qwen'] as const).map((id) => {
      const configured = providers.some(
        (item) => item.id === id && item.configured,
      );
      return {
        value: id,
        label: `${providerNames[id]}${providers.length && !configured ? ' · 未配置' : ''}`,
        disabled: !configured,
      };
    }),
    { value: 'chatgpt', label: 'ChatGPT · 仅有记录', disabled: true },
    { value: 'google', label: 'Google · 仅有记录', disabled: true },
  ];
  const currentBudget = validBudget(budget);
  const dailyBudget = validBudget(trackingBudget);
  const searchDisabled = searching || busy || !canSearch;
  const confirmationIds = confirmQuestionIds ?? [];
  const confirmationDisabled =
    searchDisabled ||
    !confirmationIds.length ||
    confirmationIds.length > 8 ||
    confirmationIds.some((id) => !coreIds.includes(id)) ||
    hasMissingLanguage(confirmationIds) ||
    (budgetEnabled && !currentBudget.value);

  useEffect(() => {
    if (confirmQuestionIds) {
      if (!searchDialog.current?.open) searchDialog.current?.showModal();
    } else {
      searchDialog.current?.close();
    }
  }, [confirmQuestionIds]);

  useEffect(() => {
    setConfirmed(false);
  }, [trackingScopeKey]);

  const loadPlans = useCallback(
    async (controller: AbortController) => {
      setLoadingPlans(true);
      try {
        const response = await fetch(
          `/api/geo/research/tracking?project=${encodeURIComponent(projectId)}`,
          { signal: controller.signal },
        );
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || '每日跟踪暂时无法读取。');
        if (!controller.signal.aborted && mounted.current) {
          const nextPlans: ResearchSchedule[] = (result.plans ?? []).filter(
            (plan: ResearchSchedule) => plan.projectId === projectId,
          );
          const version = plansVersion(nextPlans);
          const changed =
            lastPlansVersion.current !== null &&
            lastPlansVersion.current !== version;
          lastPlansVersion.current = version;
          setPlans(nextPlans);
          setTrackingError('');
          if (changed && document.visibilityState === 'visible')
            await onRefreshRef.current?.();
        }
      } catch (failure) {
        if (!controller.signal.aborted && mounted.current)
          setTrackingError(
            failure instanceof Error
              ? failure.message
              : '每日跟踪暂时无法读取。',
          );
      } finally {
        if (mounted.current && plansFetch.current === controller)
          setLoadingPlans(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    mounted.current = true;
    lastPlansVersion.current = null;
    const controller = new AbortController();
    plansFetch.current = controller;
    void loadPlans(controller);
    return () => {
      mounted.current = false;
      controller.abort();
      plansFetch.current?.abort();
    };
  }, [projectId, loadPlans]);

  useEffect(() => {
    if (!hasActivePlans) return;
    let timer: number | undefined;
    let pending = false;
    let pollController: AbortController | null = null;
    const poll = async () => {
      if (document.visibilityState !== 'visible' || pending || mutation.current)
        return;
      plansFetch.current?.abort();
      pollController = new AbortController();
      plansFetch.current = pollController;
      pending = true;
      try {
        await loadPlans(pollController);
      } finally {
        pending = false;
      }
    };
    const updateVisibility = () => {
      if (timer !== undefined) window.clearInterval(timer);
      if (document.visibilityState === 'visible') {
        timer = window.setInterval(() => void poll(), 30_000);
      } else {
        pollController?.abort();
        setLoadingPlans(false);
      }
    };
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      pollController?.abort();
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, [hasActivePlans, loadPlans]);

  const updatePlan = async (
    action: 'create' | 'pause' | 'resume' | 'stop',
    planId?: string,
  ) => {
    if (mutation.current) return;
    if (
      action === 'create' &&
      (!confirmed ||
        !deepseekConfigured ||
        !dailyBudget.value ||
        !trackedIds.length ||
        !batch ||
        hasMissingLanguage(trackedIds))
    )
      return;
    const body =
      action === 'create'
        ? {
            projectId,
            action,
            batchId: batch!.id,
            questionIds: trackedIds,
            language,
            provider: 'deepseek',
            timeOfDay,
            budget: trackingBudget,
          }
        : { projectId, action, planId, provider: 'deepseek' };
    let requestId: string | undefined;
    if (action === 'create') {
      const key = JSON.stringify(body);
      if (createRequest.current?.key !== key)
        createRequest.current = { key, id: crypto.randomUUID() };
      requestId = createRequest.current.id;
    }
    mutation.current = true;
    plansFetch.current?.abort();
    setLoadingPlans(false);
    setTrackingBusy(true);
    setTrackingError('');
    setTrackingNotice('');
    try {
      const response = await fetch('/api/geo/research/tracking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, requestId }),
      });
      const result = await response.json();
      if (!mounted.current) return;
      if (!response.ok) throw new Error(result.error || '跟踪设置未保存。');
      const nextPlans: ResearchSchedule[] = (result.plans ?? []).filter(
        (plan: ResearchSchedule) => plan.projectId === projectId,
      );
      lastPlansVersion.current = plansVersion(nextPlans);
      setPlans(nextPlans);
      if (action === 'create') {
        createRequest.current = null;
        setConfirmed(false);
        setShowTracking(false);
        setTrackingNotice('每日跟踪已保存，从明日开始；本次未执行搜索。');
      }
    } catch (failure) {
      if (mounted.current)
        setTrackingError(
          failure instanceof Error ? failure.message : '跟踪设置未保存。',
        );
    } finally {
      mutation.current = false;
      if (mounted.current) setTrackingBusy(false);
    }
  };

  return (
    <div className="qm-search-workspace">
      <div className="qm-search-row">
        <div className="qm-search-settings" aria-label="本次搜索设置">
          <label className="qm-provider-field">
            本次搜索
            <GeoSelect<SearchOption>
              label="本次搜索平台"
              value={provider}
              onChange={(next) => {
                if (next !== 'chatgpt' && next !== 'google')
                  onProviderChange(next);
              }}
              options={providerOptions}
              disabled={searching || busy}
              loading={!providers.length}
            />
          </label>
        </div>
        <div className="qm-search-actions">
          <div className="qm-search-action">
            <button
              className="qm-primary"
              disabled={
                searchDisabled ||
                !coreIds.length ||
                coreIds.length > 8 ||
                hasMissingLanguage(coreIds)
              }
              onClick={() => onSearch(coreIds)}
            >
              <Search size={14} />
              搜索全部 {coreIds.length} 题
            </button>
          </div>
          {selectedIds.length > 0 && (
            <div className="qm-search-action">
              <button
                className="qm-secondary"
                disabled={
                  searchDisabled ||
                  selectedIds.length > 8 ||
                  hasMissingLanguage(selectedIds)
                }
                onClick={() => onSearch(selectedIds)}
              >
                搜索已选 {selectedIds.length} 题
              </button>
            </div>
          )}
          <button
            className="qm-secondary qm-tracking-toggle"
            aria-expanded={showTracking}
            onClick={() => {
              setShowTracking(!showTracking);
              setConfirmed(false);
              setTrackingNotice('');
            }}
          >
            <CalendarClock size={14} />
            每日跟踪
          </button>
        </div>
      </div>
      {!canSearch && (
        <p className="qm-note">
          {providers.length
            ? `${providerNames[provider]} 尚未配置，请在设置中配置。`
            : '正在读取搜索入口…'}
        </p>
      )}
      {missingLanguageIds.size > 0 && (
        <p className="qm-note">
          {missingLanguageIds.size} 题尚缺{language === 'zh' ? '中文' : '英文'}
          问法，补齐后可搜索全部；也可选择已有问法的问题。
        </p>
      )}
      <dialog
        ref={searchDialog}
        className="qm-search-dialog"
        aria-labelledby={searchDialogTitle}
        onCancel={(event) => {
          event.preventDefault();
          onCloseConfirm();
        }}
        onClose={onCloseConfirm}
        onClick={(event) => {
          if (event.target === event.currentTarget) onCloseConfirm();
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!confirmationDisabled) onConfirmSearch();
          }}
        >
          <header>
            <h2 id={searchDialogTitle}>确认搜索</h2>
            <button
              type="button"
              className="qm-search-dialog-close"
              aria-label="关闭搜索确认"
              onClick={onCloseConfirm}
            >
              <X size={18} />
            </button>
          </header>
          <p className="qm-search-confirm-scope">
            {providerNames[provider]} · {language === 'zh' ? '中文' : '英文'} ·{' '}
            {confirmationIds.length} 题
          </p>
          <details className="qm-search-confirm-questions">
            <summary>查看问题</summary>
            <ol>
              {confirmationIds.map((id) => (
                <li key={id}>
                  {batch?.questions.find((question) => question.id === id)?.[
                    language
                  ] || id}
                </li>
              ))}
            </ol>
          </details>
          <p className="qm-search-confirm-note">本次搜索会产生费用。</p>
          <div className="qm-search-budget-setting">
            <button
              type="button"
              role="switch"
              aria-checked={budgetEnabled}
              aria-controls={budgetFieldsId}
              aria-label="设置费用上限"
              className="qm-budget-toggle"
              disabled={searching || busy}
              onClick={() => onBudgetEnabledChange(!budgetEnabled)}
            >
              <span>设置费用上限</span>
              <span className="qm-budget-switch" aria-hidden="true" />
            </button>
            {budgetEnabled && (
              <div id={budgetFieldsId} className="qm-search-confirm-budget">
                <BudgetFields
                  value={budget}
                  onChange={onBudgetChange}
                  label="金额"
                  disabled={searching || busy}
                  portalTarget={searchDialog}
                />
              </div>
            )}
          </div>
          <footer>
            <button
              type="button"
              className="qm-secondary"
              onClick={onCloseConfirm}
            >
              取消
            </button>
            <button
              type="submit"
              className="qm-primary"
              disabled={confirmationDisabled}
            >
              <Search size={14} />
              开始搜索
            </button>
          </footer>
        </form>
      </dialog>
      {showTracking && (
        <section className="qm-tracking-settings" aria-label="每日跟踪设置">
          <header>
            <strong>每日跟踪</strong>
            <button
              aria-label="关闭每日跟踪设置"
              onClick={() => setShowTracking(false)}
            >
              <X size={16} />
            </button>
          </header>
          <p className="qm-tracking-scope">
            {selectedIds.length
              ? `已选 ${trackedIds.length} 题`
              : `全部 ${trackedIds.length} 道核心题`}{' '}
            · {language === 'zh' ? '中文' : '英文'} · DeepSeek · 每次预计{' '}
            {money(trackingCostFor(trackedIds.length))}
          </p>
          <div className="qm-tracking-fields">
            <label className="qm-time-field">
              北京时间
              <input
                type="time"
                aria-label="每日跟踪时间（北京时间）"
                value={timeOfDay}
                disabled={trackingBusy}
                onChange={(event) => setTimeOfDay(event.target.value)}
              />
            </label>
            <BudgetFields
              value={trackingBudget}
              onChange={(value) => {
                setTrackingBudget(value);
                setConfirmed(false);
              }}
              label="累计总预算"
              disabled={trackingBusy}
            />
          </div>
          <div className="qm-tracking-save">
            <label className="qm-paid-consent">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={trackingBusy}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              同意从明日起每日收费搜索，累计不超过{' '}
              {dailyBudget.value
                ? `${budgetText(trackingBudget)}${trackingBudget.currency === 'USD' ? `（${money(dailyBudget.value.limitCny)}）` : ''}`
                : '所填总预算'}
              。
            </label>
            <button
              className="qm-primary"
              disabled={
                trackingBusy ||
                busy ||
                searching ||
                !deepseekConfigured ||
                !confirmed ||
                !dailyBudget.value ||
                !trackedIds.length ||
                trackedIds.length > 8 ||
                hasMissingLanguage(trackedIds) ||
                !/^\d{2}:\d{2}$/.test(timeOfDay) ||
                dailyBudget.value.limitCny + 1e-9 <
                  trackingCostFor(trackedIds.length)
              }
              onClick={() => void updatePlan('create')}
            >
              {trackingBusy ? '保存中…' : '开启每日跟踪'}
            </button>
          </div>
          {!deepseekConfigured && providers.length > 0 && (
            <p className="qm-note">DeepSeek 尚未配置，无法开启每日跟踪。</p>
          )}
          <p className="qm-note">保存不立即搜索；到达累计预算后停止。</p>
          {dailyBudget.value &&
            dailyBudget.value.limitCny + 1e-9 <
              trackingCostFor(trackedIds.length) && (
              <p className="qm-budget-error">
                累计预算至少需 {money(trackingCostFor(trackedIds.length))}
                ，才能完成一轮搜索。
              </p>
            )}
        </section>
      )}
      {trackingNotice && (
        <p className="qm-tracking-notice" role="status">
          {trackingNotice}
        </p>
      )}
      {trackingError && (
        <p className="qm-error" role="alert">
          {trackingError}
        </p>
      )}
      {plans.length > 0 && (
        <section className="qm-tracking-plans" aria-label="每日跟踪计划">
          <header>
            <strong>每日跟踪计划</strong>
            <button
              className="qm-plan-refresh"
              disabled={loadingPlans || trackingBusy}
              onClick={() => {
                plansFetch.current?.abort();
                const controller = new AbortController();
                plansFetch.current = controller;
                void loadPlans(controller);
              }}
            >
              {loadingPlans ? '读取中…' : '刷新'}
            </button>
          </header>
          <div className="qm-table-wrap">
            <table className="qm-table qm-tracking-table">
              <thead>
                <tr>
                  <th>问题范围</th>
                  <th>下次执行 · 北京时间</th>
                  <th>累计费用</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.id}>
                    <td>
                      <details>
                        <summary>
                          {plan.questionIds.length} 题 ·{' '}
                          {plan.language === 'zh' ? '中文' : '英文'} · DeepSeek
                        </summary>
                        <ol>
                          {plan.questions.map((question) => (
                            <li key={question.questionId}>{question.query}</li>
                          ))}
                        </ol>
                      </details>
                      <small className="qm-note">每天 {plan.timeOfDay}</small>
                    </td>
                    <td>{beijingTime(plan.nextRunAt)}</td>
                    <td>
                      <span>
                        {money(plan.spentCny)} / {money(plan.limitCny)}
                      </span>
                      {plan.budget.currency === 'USD' && (
                        <small className="qm-note">
                          总额 {budgetText(plan.budget)}
                        </small>
                      )}
                      {plan.reservedCny > 0 && (
                        <small className="qm-note">
                          待核费用 {money(plan.reservedCny)} · 可用{' '}
                          {money(
                            Math.max(
                              0,
                              plan.limitCny - plan.spentCny - plan.reservedCny,
                            ),
                          )}
                        </small>
                      )}
                    </td>
                    <td>
                      {scheduleStatuses[plan.status] || plan.status}
                      {plan.error && (
                        <details className="qm-plan-error">
                          <summary>查看原因</summary>
                          <p>{plan.error}</p>
                        </details>
                      )}
                    </td>
                    <td>
                      <div className="qm-actions">
                        {plan.status === 'active' && (
                          <button
                            disabled={trackingBusy}
                            onClick={() => void updatePlan('pause', plan.id)}
                          >
                            暂停
                          </button>
                        )}
                        {(plan.status === 'paused' ||
                          plan.status === 'failed') && (
                          <button
                            disabled={trackingBusy}
                            onClick={() => void updatePlan('resume', plan.id)}
                          >
                            恢复
                          </button>
                        )}
                        {plan.status !== 'stopped' && (
                          <button
                            disabled={trackingBusy}
                            onClick={() => void updatePlan('stop', plan.id)}
                          >
                            停止
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
