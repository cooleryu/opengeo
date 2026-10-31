export interface MoneyBudget {
  currency: 'CNY' | 'USD';
  amount: number;
  /** User-confirmed budget conversion, not a live market exchange rate. */
  cnyPerUsd?: number;
}

export interface NormalizedResearchBudget extends MoneyBudget {
  limitCny: number;
}

export function normalizeResearchBudget(value: unknown): NormalizedResearchBudget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请设置本次费用上限。');
  const budget = value as MoneyBudget;
  if (budget.currency !== 'CNY' && budget.currency !== 'USD') throw new Error('请选择人民币或美元。');
  if (typeof budget.amount !== 'number' || !Number.isFinite(budget.amount) || budget.amount <= 0) throw new Error('预算金额必须大于 0。');
  const rate = budget.currency === 'CNY' ? 1 : budget.cnyPerUsd;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) throw new Error('请明确填写 1 美元折合多少人民币，确认后用于本计划预算。');
  // Search is billed in CNY. Round down so conversion cannot increase the cap.
  const limitCny = Math.floor((budget.amount * rate + Number.EPSILON) * 1000) / 1000;
  if (!Number.isFinite(limitCny) || limitCny < 0.005 || limitCny > 100) throw new Error('预算折合人民币须在 0.005 至 100 元之间。');
  return { currency: budget.currency, amount: budget.amount, ...(budget.currency === 'USD' ? { cnyPerUsd: rate } : {}), limitCny };
}
