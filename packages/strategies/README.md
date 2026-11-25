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
