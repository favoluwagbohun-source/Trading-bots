# Indicators package

Confirmed-candle indicator and market-structure engine.

Included calculations:

- SMA and EMA
- Wilder ATR
- Wilder RSI
- confirmed swing highs and swing lows
- bullish/bearish/neutral market structure
- confirmed close displacement

Swing confirmation deliberately waits for the configured number of right-hand
candles. This prevents future-candle and lookahead access in live and replay
processing.

## Trendline engine

The trendline engine uses confirmed swing points and a documented engineering
assumption: two anchors establish a candidate, and at least one additional
touch is required by default. Tori Trades' exact trendline rules could not be
verified in this repository; candidate scoring and touch tolerances are not
presented as rules attributed to her.
