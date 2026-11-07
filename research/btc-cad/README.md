# BTC/CAD offline research proposal

Run `npm run test:btc-cad` from the repository root with Node 18 or later.
The research path has no network calls, credentials,
broker adapter, orders or scheduler. The legacy start command is outside this
research workflow.

Inputs are chronological UTC candle-open timestamps in integer milliseconds,
with OHLC in CAD and BTC volume. Supply separate 1m, 5m and 15m arrays for
KRAKEN:BTCCAD. Production research ingestion still needs venue/source
verification and cross-timeframe reconciliation. Synthetic fixtures isolate
each timeframe's logic and are not reconciled exchange data.

Proposed defaults: 5m strict two-left/two-right pivots. Confirm at the close of
the second right candle. Consecutive pivots of the same kind retain the more
extreme one, with ties retaining the earlier one. The latest low/high pair
defines a long setup. Require three rising completed 15m closes. A completed
1m candle must close in the 38.2%–61.8% zone above UTC-session HLC3 VWAP.
From pivot confirmation onward, a breach of either anchor invalidates that
setup. Incomplete sessions cannot produce VWAP. Internal gaps invalidate the
input. The signal range must be at most one 5m ATR(14), computed as the mean
of true ranges. Stop below the lower of the signal low and deep retracement
boundary by 0.5 ATR, target the swing high. At entry reject a stop distance
over 2 ATR and adverse extension over 0.25 ATR.

Use `volume_breakout` as the primary 1-minute trigger. It requires a bullish
body of at least half the candle range, a close above the previous three
1-minute highs, and volume above the preceding 20-candle median. The bullish
body, strict resistance close-cross, and rising-close modes remain comparison
variants. Do not select a variant from holdout results.

Entry estimate requires a later same-venue bid/ask with sufficient displayed
ask size within one minute. Spread is charged through the quote, with 5 bps
additional adverse slippage and 26 bps fee per side as research assumptions.
Exit values are scenario inputs for risk/reward arithmetic only. No OHLC price
becomes a fill. Require estimated net target reward of at least 1.5 times
estimated stop risk. Emit a time-stop decision after 20 minutes when neither
the stop nor target has triggered. Use CAD 25,000 initial cash, a CAD 125
initial risk budget (0.5% of cash), and a 40% debit cap including fees. This 0.5% setting
is the latest accepted per-trade risk for the 90-day training and 30-day
holdout configuration. The earlier 0.25% setting is retired for this branch.
The proposed spread ceiling is 10 bps. Venue fee tier, tick/lot rules,
latency, quote provenance and exit depth need verification.

The entry gate stops new entries at a 1% realized daily loss measured from the
start-of-day equity and enforces a 15-minute cooldown after an exit. These
gates operate on supplied portfolio state and do not submit orders. Outstanding: daily five-entry cap; breakout
retest; halt after three losses and prevent loss-driven size increases;
drawdown limits; journaling and portfolio state; exit quote matching with gap,
stale quote, and ambiguous stop/target handling; authenticated offline export
provenance and cross-timeframe validation. Spread and displayed ask size alone
cannot establish actual execution quality.

The coverage function gates one UTC-aligned 90/30 fold on complete 1m and 5m
bars. Before evaluating, verify aligned 15m coverage, indicator warmup,
historical quotes/depth and timestamps, and data independence. Freeze
parameters and selection rules using the first 90 days only. Score the next
30 days once, with split-boundary handling defined before selection. Roll by
30 days, label reused windows, and reserve a separate untouched final sample.
The patch has no historical runner or historical result. Execution is on HOLD.
