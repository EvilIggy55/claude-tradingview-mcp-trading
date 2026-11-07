export const MARKET = 'KRAKEN:BTCCAD';
export const START_CAD = 25_000;
export const RISK_PER_TRADE = 0.005;
export const MIN = 60_000;
const DAY = 1440 * MIN;
const FEE = 0.0026;
const SLIP = 0.0005;

function completed(rows, minutes, asOf) {
  const step = minutes * MIN;
  if (rows.some(b => !Number.isSafeInteger(b.t))) throw Error("Invalid timestamp");
  const bars = rows.filter(b => b.t + step <= asOf);
  for (const [i, b] of bars.entries()) {
    if (!Number.isSafeInteger(b.t) || b.t % step ||
        (i && b.t !== bars[i - 1].t + step) ||
        ![b.open, b.high, b.low, b.close].every(x => Number.isFinite(x) && x > 0) ||
        b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close) ||
        !Number.isFinite(b.volume) || b.volume < 0) throw Error('Invalid or noncontiguous bars');
  }
  return bars;
}

export function pivots(rows, asOf) {
  const bars = completed(rows, 5, asOf);
  const swings = [];
  for (let i = 2; i + 2 < bars.length; i++) {
    const b = bars[i];
    const neighbors = bars.slice(i - 2, i + 3).filter(c => c !== b);
    const high = neighbors.every(c => b.high > c.high);
    const low = neighbors.every(c => b.low < c.low);
    if (high === low) continue; // Ties and ambiguous outside bars get no pivot.
    const pivot = { t: b.t, knownAt: bars[i + 2].t + 5 * MIN,
      side: high ? 'high' : 'low', price: high ? b.high : b.low };
    const last = swings.at(-1);
    if (last?.side !== pivot.side) swings.push(pivot);
    else if (high ? pivot.price > last.price : pivot.price < last.price) swings[swings.length - 1] = pivot;
  }
  return swings;
}

export function sessionVwap(bars, asOf) {
  const start = Math.floor((asOf - 1) / DAY) * DAY;
  const session = completed(bars, 1, asOf).filter(b => b.t >= start);
  if (session[0]?.t !== start || session.at(-1)?.t + MIN !== asOf) return null;
  const volume = session.reduce((sum, b) => sum + b.volume, 0);
  return volume ? session.reduce((sum, b) => sum + (b.high + b.low + b.close) / 3 * b.volume, 0) / volume : null;
}

export function confirms(mode, bars) {
  const [a, b, c] = bars.slice(-3);
  if (!c) return false;
  switch (mode) {
    case 'bullish_candle': return c.close > c.open;
    // Use the latest strict 1/1 high confirmed before the signal candle.
    case 'breakout': {
      for (let i = bars.length - 3; i >= 1; i--) {
        const level = bars[i].high;
        if (level <= Math.max(bars[i - 1].high, bars[i + 1].high)) continue;
        return b.close <= level && c.close > level;
      }
      return false;
    }
    case 'momentum': return c.close > b.close && b.close > a.close;
    default: throw Error('Unknown confirmation');
  }
}

export function candidate({ market, one, five, fifteen, asOf, mode }) {
  if (market !== MARKET || !Number.isSafeInteger(asOf) || asOf % MIN) return null;
  const m = completed(one, 1, asOf);
  const f = completed(five, 5, asOf);
  const trend = completed(fifteen, 15, asOf);
  const bar = m.at(-1);
  if (bar?.t + MIN !== asOf ||
      f.at(-1)?.t + 5 * MIN !== Math.floor(asOf / (5 * MIN)) * 5 * MIN ||
      trend.at(-1)?.t + 15 * MIN !== Math.floor(asOf / (15 * MIN)) * 15 * MIN ||
      f.length < 15 || trend.length < 3) return null;
  const [a, b, c] = trend.slice(-3);
  if (!(c.close > b.close && b.close > a.close)) return null;
  const [lo, hi] = pivots(f, asOf).slice(-2);
  if (lo?.side !== 'low' || hi?.side !== 'high' || hi.price <= lo.price || bar.t < hi.knownAt) return null;
  const size = hi.price - lo.price;
  const lower = hi.price - 0.618 * size;
  const upper = hi.price - 0.382 * size;
  const pullback = m.filter(x => x.t >= hi.knownAt);
  if (pullback[0]?.t !== hi.knownAt ||
      pullback.some(x => x.low <= lo.price || x.high >= hi.price)) return null;
  const vwap = sessionVwap(m, asOf);
  const atr = f.slice(-14).reduce((sum, x, i) => {
    const previous = f[f.length - 15 + i].close;
    return sum + Math.max(x.high - x.low, Math.abs(x.high - previous), Math.abs(x.low - previous));
  }, 0) / 14;
  if (!(vwap > 0 && atr > 0 && bar.close > vwap && bar.low <= upper &&
      bar.high >= lower && bar.close >= lower && bar.close <= upper &&
      bar.high - bar.low <= atr && confirms(mode, pullback))) return null;
  return { asOf, mode, lo, hi, vwap, atr, reference: bar.close,
    stop: Math.min(bar.low, lower) - 0.5 * atr, target: hi.price };
}

// Quote evidence is caller-supplied. This function only estimates a research entry.
export function estimateEntry(signal, quote, cashCad = START_CAD) {
  if (!signal || !quote || quote.market !== MARKET || !Number.isSafeInteger(quote.t) ||
      quote.t <= signal.asOf || quote.t >= signal.asOf + MIN ||
      ![quote.bid, quote.ask, quote.askBtc, cashCad].every(x => Number.isFinite(x) && x > 0) ||
      quote.ask < quote.bid || (quote.ask - quote.bid) / quote.bid > 0.001) return null;
  const entry = quote.ask * (1 + SLIP);
  const stop = signal.stop * (1 - SLIP);
  const target = signal.target * (1 - SLIP);
  const debit = entry * (1 + FEE);
  const risk = debit - stop * (1 - FEE);
  const reward = target * (1 - FEE) - debit;
  if (signal.stop <= 0 || entry <= signal.stop || entry - signal.stop > 2 * signal.atr ||
      entry - signal.reference > 0.25 * signal.atr || !(reward >= risk && risk > 0)) return null;
  const btc = Math.floor(Math.min(RISK_PER_TRADE * cashCad / risk, 0.4 * cashCad / debit) * 1e8) / 1e8;
  if (!(btc > 0) || btc > quote.askBtc) return null;
  return { kind: 'offline_entry_estimate', quoteTime: quote.t, observedAsk: quote.ask,
    btc, entryCad: entry, feeCad: btc * entry * FEE, debitCad: btc * debit,
    estimatedStopRiskCad: btc * risk, estimatedTargetProfitCad: btc * reward };
}

// One fold. A partial interval or an internal hole invalidates the entire fold.
export function foldCoverage({ market, one, five, start, availableThrough }) {
  const split = start + 90 * DAY;
  const end = split + 30 * DAY;
  if (market !== MARKET || !Number.isSafeInteger(start) || start % DAY ||
      !Number.isSafeInteger(availableThrough) || availableThrough < end) return null;
  for (const [rows, minutes] of [[one, 1], [five, 5]]) {
    const bars = completed(rows.filter(b => b.t >= start), minutes, end);
    if (bars.length !== (end - start) / (minutes * MIN) || bars[0]?.t !== start) return null;
  }
  return { start, split, end };
}
