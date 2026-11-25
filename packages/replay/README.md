# Replay package

Stage 9 provides:

- date-windowed replay sessions for symbol and timeframe selections;
- pause, resume, timed playback, speed selection, and one-candle stepping;
- snapshots containing only the current candle and already-visible history;
- manual trendline, horizontal-level, and zone annotations;
- manual simulated entries, account/risk sizing, stop/target management, and a
  paper-trade journal.

Replay and paper-account state are in-memory. Historical candles must be
provided by a caller from the market-data/history layer; this package does not
fabricate candles or submit exchange orders.
