import { test, expect } from '@playwright/test';

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1));
  return sorted[index] ?? 0;
}

test('codechat session switch perf', async ({ page }) => {
  await page.goto('http://localhost:3000/codechat', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('button', { name: /bug ticket creator starter/i })).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __switchMetrics: number[] }).__switchMetrics = [];
    window.addEventListener('codechat:session-switch-metric', (event) => {
      const detail = (event as CustomEvent<{ durationMs?: number }>).detail;
      const next = Number(detail?.durationMs ?? NaN);
      if (!Number.isFinite(next)) return;
      (window as unknown as { __switchMetrics: number[] }).__switchMetrics.push(next);
    });
  });

  // Seed second session so we can switch between two persisted sessions.
  await page.getByRole('button', { name: /bug ticket creator starter/i }).click();
  await expect(page.getByRole('button', { name: /open session bug ticket creator/i })).toBeVisible();

  const bugSession = page.getByRole('button', { name: /open session bug ticket creator/i });
  const freeSession = page.getByRole('button', { name: /open session free chat/i });

  // Alternate active session repeatedly to capture switch latency distribution.
  const switchPairs = 16;
  for (let index = 0; index < switchPairs; index += 1) {
    await freeSession.click();
    await page.waitForTimeout(20);
    await bugSession.click();
    await page.waitForTimeout(20);
  }

  await page.waitForTimeout(80);

  const durations = await page.evaluate(() => {
    return (window as unknown as { __switchMetrics?: number[] }).__switchMetrics ?? [];
  });

  const sorted = [...durations].sort((a, b) => a - b);
  const avg = sorted.length
    ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length
    : 0;

  const summary = {
    count: sorted.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
    avg,
  };

  console.log(`SESSION_SWITCH_METRICS ${JSON.stringify(summary)}`);
  expect(summary.count).toBeGreaterThan(0);
});
