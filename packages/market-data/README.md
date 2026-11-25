# Market-data package

Public Binance market-data engine for historical and live candles.

Features:

- REST klines with primary and fallback public endpoints
- WebSocket kline streams
- automatic reconnection with exponential backoff
- REST polling fallback
- duplicate candle protection
- strict OHLC and timestamp validation
- explicit closed/unfinished candle state
