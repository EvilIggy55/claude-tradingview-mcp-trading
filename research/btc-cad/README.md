# BTC/CAD offline research proposal

Apply from repository root with `git apply --check btc-cad-offline.patch`, then
`git apply btc-cad-offline.patch` after approval. Run `npm run test:btc-cad`
with Node 18 or later. The research path has no network calls, credentials,
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

Compare three independently selected modes: completed bullish body; close
crossing above the latest previously confirmed strict 1/1 resistance; or
three rising 1m closes with the common 15m trend gate. These are proposed
operational definitions of the recovered alternatives.

Entry estimate requires a later same-venue bid/ask with sufficient displayed
ask size within one minute. Spread is charged through the quote, with 5 bps
additional adverse slippage and 26 bps fee per side as research assumptions.
Exit values are scenario inputs for risk/reward arithmetic only. No OHLC price
becomes a fill. Require estimated net target reward at least equal to
estimated stop risk. Use CAD 25,000 initial cash, a CAD 62.50 initial risk
budget (0.25% of cash) and a 40% debit cap including fees. Earlier notes also
give 0.5%; resolve the discrepancy before freezing historical evaluation.
The proposed spread ceiling is 10 bps. Venue fee tier, tick/lot rules,
latency, quote provenance and exit depth need verification.

Outstanding: daily five-entry cap and cooldown; breakout retest; halt after
three losses and prevent loss-driven size increases; daily-loss and drawdown
limits; journaling and portfolio state; exit quote matching with gap, stale
quote, and ambiguous stop/target handling; authenticated offline export
provenance and cross-timeframe validation. Daily controls need a defined
session and cooldown. Spread and displayed ask size alone cannot establish
actual execution quality.

The coverage function gates one UTC-aligned 90/30 fold on complete 1m and 5m
bars. Before evaluating, verify aligned 15m coverage, indicator warmup,
historical quotes/depth and timestamps, and data independence. Freeze
parameters and selection rules using the first 90 days only. Score the next
30 days once, with split-boundary handling defined before selection. Roll by
30 days, label reused windows, and reserve a separate untouched final sample.
The patch has no historical runner or historical result. Execution is on HOLD.
