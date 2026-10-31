/** The registration timestamp is never a substitute for the actual implementation date. */
export function validateImplementationDate(
  occurredAt: unknown,
  recordedAt: string,
  notBefore?: string,
): string {
  if (typeof occurredAt !== 'string') throw new Error('请填写实际实施时间。');
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      occurredAt,
    );
  const actual = Date.parse(occurredAt);
  const recorded = Date.parse(recordedAt);
  if (!match || !Number.isFinite(actual) || !Number.isFinite(recorded))
    throw new Error('实际实施时间无效，请填写带时区的完整日期和时间。');
  const [, year, month, day, hour, minute, second = '0'] = match;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  if (
    calendar.getUTCFullYear() !== Number(year) ||
    calendar.getUTCMonth() !== Number(month) - 1 ||
    calendar.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    throw new Error('实际实施时间不是有效日期。');
  if (actual > recorded) throw new Error('实际实施时间不能晚于登记时间。');
  if (notBefore !== undefined) {
    const earliest = Date.parse(notBefore);
    if (!Number.isFinite(earliest))
      throw new Error('当前方案的审核时间无效，请先重新审核。');
    if (actual < earliest)
      throw new Error('实际实施时间不能早于当前方案通过审核的时间。');
  }
  return new Date(actual).toISOString();
}
