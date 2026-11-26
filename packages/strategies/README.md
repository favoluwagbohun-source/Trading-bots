# Strategies package

Independent strategy package. Stage 5 includes the top-down trendline prototype.

The initial implementation uses explicit engineering assumptions for trendline
break/bounce/retest conditions, higher-timeframe alignment, and signal-candle
stops. These rules are not verified or attributed to Tori Trades. Replace or
approve those assumptions before treating them as a faithful methodology.

Signal evaluation consumes only closed execution candles and higher-timeframe
bias snapshots available by the signal candle close. A signal is activated only
at the immediate next 5-minute candle open. Four-hour trendlines are projected
onto the 5-minute execution candles using timestamp anchors. A retest requires a
recent confirmed close across that line followed by a confirmed revisit and
directional close. Position sizing is not included; that belongs to Stage 7.

The live worker now builds an immutable, timestamp-synchronized analysis
snapshot before calling the strategy detectors. This prevents unfinished or
later-closing higher-timeframe candles from entering an earlier 5-minute
decision. Its 4-hour trendlines use progressive adjacent Point A/Point B swing
pairs, require a third confirmed touch, and reject structural violations.
Top-down setups require a valid opposing 4-hour Safety Line; the 0.1% buffer
and lifecycle tolerances remain engineering assumptions. It does not make the
prototype rules source-verified.

## Additional strategy prototypes

These are independently callable detectors. Their thresholds and candle rules
are engineering hypotheses, not verified or attributed methodology. They do
not imply profitability.

- `evaluateBreakAndRetest`: starts from a confirmed swing level, requires a
  closed breakout, then a later level revisit and directional close; invalidates
  a setup if an intervening candle closes back across the level.
- `evaluateLiquiditySweep`: requires a closed candle to strictly pass a
  previously confirmed swing high/low, then close back inside with a
  directionally confirming body. The worker supplies 4-hour/1-hour/5-minute
  confirmed levels and rejects sweeps opposed to the 4-hour structure.
- `evaluateOrderBlockRetest`: uses the adjacent opposing candle as the zone,
  requires a displacement body of at least the configured ATR multiple (default
  2 ATR), and waits for a later retest with a directional close. Full candle
  high/low defines the zone; the invalidation rule can be selected as close-
  through or wick-through.

Each detector emits its own setup, reference level/zone, stop, and next-candle
entry time. `evaluateBreakAndRetestState` distinguishes no break, awaiting
retest, invalidation, and confirmed retest. `activateSetupAtNextOpen` creates
separate R-based target plans and rejects entries with non-positive risk or
TP2 below 2R. Position sizing and publish gating remain in the worker's
existing risk pipeline.
