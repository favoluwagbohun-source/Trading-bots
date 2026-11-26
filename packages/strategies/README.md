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
decision. It does not make the prototype rules source-verified or replace the
signal-candle stop with a separately modeled Safety Line.

## Additional strategy prototypes

These are independently callable detectors. Their thresholds and candle rules
are engineering hypotheses, not verified or attributed methodology. They do
not imply profitability.

- `evaluateBreakAndRetest`: starts from a confirmed swing level, requires a
  closed breakout, then a later level revisit and directional close; invalidates
  a setup if an intervening candle closes back across the level.
- `evaluateLiquiditySweep`: requires a closed candle to strictly pass a
  previously confirmed swing high/low, then close back inside with a
  directionally confirming body.
- `evaluateOrderBlockRetest`: uses the adjacent opposing candle as the zone,
  requires a displacement body of at least the configured ATR multiple (default
  2 ATR), and waits for a later retest with a directional close. Full candle
  high/low defines the zone.

Each detector emits its own setup, reference level/zone, stop, and next-candle
entry time. `activateSetupAtNextOpen` creates separate R-based target plans and
rejects entries with non-positive risk or TP2 below 2R. Position sizing,
performance reports, and grades remain future stages.
