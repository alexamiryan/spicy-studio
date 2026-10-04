/**
 * What a provider's balance counts as "full" for the header rings: the balance right after the last top-up.
 * Spending lowers the balance under it; a top-up (an increase of at least 10% of it) starts a new cycle. Small
 * increases, like a refund for a failed job, only raise it if the balance passes it. Exported for tests.
 */
export function nextPeak(previous: { peak?: number | null; last?: number | null }, amount: number) {
  const peak = typeof previous.peak === 'number' && previous.peak > 0 ? previous.peak : null;
  const last = typeof previous.last === 'number' ? previous.last : null;
  if (peak === null || last === null) return amount;
  if (amount - last >= 0.1 * peak) return amount;
  return Math.max(peak, amount);
}
