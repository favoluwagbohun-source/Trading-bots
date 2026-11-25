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
