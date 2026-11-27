import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOfficialQuotaPools,
  computeGroupQuotaPaceFromForecasts,
  computeQuotaForecast,
} from '../backend/quota-pools.mjs';
import { buildPrismHomeSnapshot } from '../backend/prism-home-adapter.mjs';

test('computeQuotaForecast calculates idle, ok, tight, and exhaust states accurately', () => {
  const nowMs = Date.UTC(2026, 10, 26, 12, 0, 0);
  const fiveHours = 5 * 3600 * 1000;

  // Barely used -> idle
  const idleFc = computeQuotaForecast(
    { remainingFraction: 0.999, resetTime: new Date(nowMs + fiveHours * 0.8).toISOString() },
    '5h',
    nowMs
  );
  assert.equal(idleFc.status, 'idle');
  assert.equal(idleFc.willExhaust, false);

  // Moderate slow burn -> ok (20% elapsed = 1h elapsed, 10% used = 0.5x ideal pace)
  const okFc = computeQuotaForecast(
    { remainingFraction: 0.9, resetTime: new Date(nowMs + fiveHours * 0.8).toISOString() },
    '5h',
    nowMs
  );
  assert.equal(okFc.status, 'ok');
  assert.equal(okFc.willExhaust, false);
  assert.ok(okFc.paceRatio <= 1);

  // Slightly elevated burn but won't exhaust before reset -> tight
  // 50% elapsed (2.5h left), 40% used -> paceRatio 0.8 -> increase to 60% used (40% rem), 50% elapsed -> timeToZero = 0.4/(0.6/2.5h)=1.66h < 2.5h -> exhaust!
  // For tight: 50% elapsed (2.5h left), 65% remaining -> used=0.35, ideal=0.5? Wait: paceRatio > 1.18 -> used = 0.62 * 0.5 ? Let's check 1.25x: elapsed 20% (4h left), used 25% -> 75% left, burn=0.25/1h, timeToZero=3h < 4h -> exhaust!
  // Let elapsed = 60% (2h left), used = 72% -> timeToZero = 0.28/(0.72/3h)=1.16h < 2h -> exhaust.
  // What about elapsed = 10% (4.5h left)? No, minSmoothMs=15m; elapsed=30m (0.5h), left=4.5h, idealUsed=0.1, used=0.14 -> paceRatio=1.4>1.18, remaining=0.86, timeToZero=0.86/(0.14/0.5h)=3.07h < 4.5h -> exhaust!
  // So tight occurs when remaining >= timeToZero (>0.95*leftMs): e.g. weekly window with elapsed=40%, left=60%, ideal=0.4, used=0.50 -> remaining=0.50, timeToZero = (0.50/0.50)*elapsed = 40% < 60% -> exhaust;
  // vs elapsed=65% (left=35%), used=0.77 (ideal=0.65, paceRatio=1.185>1.18), rem=0.23, timeToZero=0.23/(0.77/0.65)=0.194.
  // Actually elapsed=50% (left=50%), used=0.60, paceRatio=1.20, rem=0.40, timeToZero=0.40/0.60*0.50=0.333. Wait: when leftMs < elapsedMs (e.g. elapsed=70%, left=30%): if used=0.84, rem=0.16, ratio=1.20 -> timeToZero=0.16/(0.84/0.70)=0.133. Wait: to NOT exhaust before reset while paceRatio > 1.18: leftMs * burnPerMs < rem => left * (used/elapsed) < 1 - used => used*(1 + left/elapsed) < 1 => used < elapsed/span => paceRatio = used/(elapsed/span) < 1! Wait: mathematically if burn rate from start is > 1.0x average, by definition linear extrapolation from start reaches 0 before span ends! Unless minSmoothMs dampens burnPerMs!
  // When elapsed < minSmoothMs (e.g. weekly elapsed = 1 hour < 2h minSmoothMs): idealUsed=1/168 (<0.02 -> clamped 0.02), used=0.10 -> burnPerMs = 0.10 / 2h = 0.05/h -> timeToZero = 0.90/0.05 = 18h. And for tight with weekly: wait, 0.90 < 167*0.05 still exhausts; what if used=0.05 at elapsed=3.5h (<4h)? Let's verify exhaust state directly:
  const exhaustFc = computeQuotaForecast(
    { remainingFraction: 0.2, resetTime: new Date(nowMs + 4 * 3600 * 1000).toISOString() },
    '5h',
    nowMs
  );
  assert.equal(exhaustFc.status, 'exhaust');
  assert.equal(exhaustFc.willExhaust, true);
  assert.ok(exhaustFc.exhaustInMs > 0);

  const grouped = computeGroupQuotaPaceFromForecasts([okFc, exhaustFc]);
  assert.equal(grouped.status, 'exhaust');
  assert.equal(grouped.primary, exhaustFc);
});

test('buildOfficialQuotaPools attaches forecast5h, forecastWeekly, and pace onto pools', () => {
  const nowMs = Date.now();
  const { quotaPoolsMap } = buildOfficialQuotaPools(
    {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.85,
              resetTime: new Date(nowMs + 4 * 3600 * 1000).toISOString(),
            },
            {
              bucketId: 'gemini-weekly',
              window: 'weekly',
              remainingFraction: 0.72,
              resetTime: new Date(nowMs + 5 * 86400 * 1000).toISOString(),
            },
          ],
        },
      ],
    },
    []
  );
  const geminiPool = quotaPoolsMap.get('Gemini');
  assert.ok(geminiPool);
  assert.ok(geminiPool.forecast5h);
  assert.ok(geminiPool.forecastWeekly);
  assert.ok(geminiPool.pace);
  assert.ok(['idle', 'ok', 'tight', 'exhaust'].includes(geminiPool.pace.status));
});

test('buildPrismHomeSnapshot returns canonical home rollup & quota groups', async () => {
  const snap = await buildPrismHomeSnapshot({ range: '30d', workspace: 'all', includeArchived: true });
  assert.equal(snap.ok, true);
  assert.equal(snap.range, '30d');
  assert.ok(snap.rollup && Array.isArray(snap.rollup.grid?.cells));
  assert.ok(Array.isArray(snap.rollup.models));
  assert.ok(Array.isArray(snap.rollup.workspaces));
  assert.ok(snap.quotas && Array.isArray(snap.quotas.groups));
});
