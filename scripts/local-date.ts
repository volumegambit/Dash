/**
 * The local calendar date as YYYY-MM-DD.
 *
 * NOT `toISOString().slice(0, 10)` — that is the UTC date, which lags the
 * local calendar just after local midnight in UTC+ timezones, so `reviewedAt`
 * would stamp "yesterday".
 */
export function localDateStamp(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
