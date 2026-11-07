import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN, MARKET, pivots, sessionVwap, confirms, candidate, estimateEntry, foldCoverage } from './strategy.mjs';

const bar = (i, close, low = close - 1, high = close + 1) =>
  ({ t: i * MIN, open: close - 0.25, close, low, high, volume: 1 });

test('strict swing requires both right candles closed and records availability', () => {
  const rows = [10, 11, 8, 12, 13, 16, 13, 12].map((p, i) => bar(i * 5, p));
  assert.deepEqual(pivots(rows, 39 * MIN).map(p => p.side), ['low']);
  assert.deepEqual(pivots(rows, 40 * MIN), [
    { t: 10 * MIN, knownAt: 25 * MIN, side: 'low', price: 7 },
    { t: 25 * MIN, knownAt: 40 * MIN, side: 'high', price: 17 },
  ]);
  rows[6].high = 17;
  assert.equal(pivots(rows, 40 * MIN).length, 1);
});

test('outside candle cannot supply both anchors and gaps cannot confirm swings', () => {
  const rows = [0, 5, 10, 15, 20].map(i => bar(i, 100));
  rows[2] = bar(10, 100, 90, 110);
  assert.deepEqual(pivots(rows, 25 * MIN), []);
  assert.throws(() => pivots(rows.filter((_, i) => i !== 3), 25 * MIN), /noncontiguous/);
});

test('UTC VWAP resets, weights volume, and excludes forming bars', () => {
  const rows = [bar(1439, 100), bar(1440, 200), { ...bar(1441, 220), volume: 3 }, bar(1442, 500)];
  assert.equal(sessionVwap(rows, 1442 * MIN), 215);
  assert.equal(sessionVwap(rows.slice(2), 1442 * MIN), null);
  assert.throws(() => sessionVwap([rows[1], rows[3]], 1443 * MIN), /noncontiguous/);
});

test('confirmation modes distinguish close, resistance break and rising closes', () => {
  const rows = [bar(0, 100), bar(1, 104), bar(2, 102), bar(3, 106)];
  assert.equal(confirms('breakout', rows), true);
  assert.equal(confirms('momentum', rows), false);
  assert.equal(confirms('bullish_candle', rows), true);
  assert.equal(confirms('breakout', rows.slice(0, 3)), false);
  assert.equal(confirms('momentum', [bar(0, 100), bar(1, 101), bar(2, 102)]), true);
});

function fixture() {
  const one = Array.from({ length: 83 }, (_, i) => bar(i, i < 80 ? 99 : 106 + (i - 80) / 2));
  const five = [100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 96, 103, 108, 114, 112, 109]
    .map((p, i) => bar(i * 5, p));
  const fifteen = [98, 99, 100, 103, 108].map((p, i) => bar(i * 15, p));
  return { market: MARKET, one, five, fifteen, asOf: 83 * MIN, mode: 'momentum' };
}

test('valid retracement survives appending future bars; blocks stale 5m and wrong market', () => {
  const data = fixture();
  const signal = candidate(data);
  assert.ok(signal);
  assert.equal(signal.hi.knownAt, 80 * MIN);
  assert.deepEqual(candidate({ ...data, one: [...data.one, bar(83, 200)] }), signal);
  assert.equal(candidate({ ...data, five: data.five.slice(0, -1) }), null);
  assert.equal(candidate({ ...data, market: 'BTCUSDT' }), null);
});

test('rejects broken swing, close outside Fib band, failed VWAP, and bearish trend', () => {
  const data = fixture();
  for (const one of [
    [...data.one.slice(0, -1), bar(82, 108, 94)],
    [...data.one.slice(0, -1), bar(82, 111)],
    [...data.one.slice(0, 80).map((_, i) => bar(i, 120)), ...data.one.slice(80)],
  ]) assert.equal(candidate({ ...data, one }), null);
  assert.equal(candidate({ ...data, fifteen: [...data.fifteen.slice(0, -1), bar(60, 95)] }), null);
});

test('estimate requires a later quote and depth; charges fees and adverse slippage', () => {
  const signal = { asOf: MIN, reference: 100, atr: 3, stop: 98, target: 108 };
  const q = { market: MARKET, t: MIN + 1, bid: 99.95, ask: 100, askBtc: 100 };
  for (const quote of [null, { ...q, t: MIN }, { ...q, t: 2 * MIN },
    { ...q, bid: 98 }, { ...q, askBtc: 0.01 }]) assert.equal(estimateEntry(signal, quote), null);
  const estimate = estimateEntry(signal, q);
  assert.equal(estimate.observedAsk, q.ask);
  assert.ok(Math.abs(estimate.entryCad - 100.05) < 1e-10);
  assert.equal(estimate.feeCad, estimate.btc * estimate.entryCad * 0.0026);
  assert.ok(estimate.estimatedStopRiskCad <= 62.5 && estimate.debitCad <= 10_000);
  assert.equal(estimateEntry({ ...signal, target: 101 }, q), null);
});

test('short or future coverage cannot qualify as a 90/30 fold', () => {
  const data = fixture();
  assert.equal(foldCoverage({ ...data, start: 0, availableThrough: 83 * MIN }), null);
  assert.equal(foldCoverage({ ...data, start: 0, availableThrough: 120 * 1440 * MIN }), null);
});
