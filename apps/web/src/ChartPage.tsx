import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Candle } from "@crypto-signal/shared";
import {
  SUPPORTED_TIMEFRAMES,
  type MarketTimeframe
} from "@crypto-signal/market-data";
import { MarketChart } from "./components/MarketChart.js";
import { PaperDashboard } from "./PaperDashboard.js";
import {
  fetchHistoricalCandles,
  marketStreamUrl,
  parseMarketStreamMessage
} from "./market-api.js";

type ConnectionState = "loading" | "connecting" | "connected" | "reconnecting" | "historical" | "error";

const SYMBOL_SUGGESTIONS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];

function mergeCandles(previous: readonly Candle[], incoming: readonly Candle[]): Candle[] {
  const candlesByTime = new Map(previous.map((candle) => [candle.openTime, candle]));
  for (const candle of incoming) candlesByTime.set(candle.openTime, candle);
  return [...candlesByTime.values()]
    .sort((left, right) => left.openTime - right.openTime)
    .slice(-1000);
}

function formatPrice(value: string | undefined): string {
  if (value === undefined) return "—";
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8
  });
}

function startOfUtcDay(value: string): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function endOfUtcDay(value: string): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(`${value}T23:59:59.999Z`);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isMarketTimeframe(value: string): value is MarketTimeframe {
  return SUPPORTED_TIMEFRAMES.some((interval) => interval === value);
}

export function ChartPage() {
  const [symbolInput, setSymbolInput] = useState("BTCUSDT");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [timeframe, setTimeframe] = useState<MarketTimeframe>("5m");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("loading");
  const [connectionMessage, setConnectionMessage] = useState("Loading historical candles");
  const [error, setError] = useState<string | null>(null);

  const startTime = useMemo(() => startOfUtcDay(startDate), [startDate]);
  const endTime = useMemo(() => endOfUtcDay(endDate), [endDate]);
  const latestCandle = candles.at(-1);
  const previousCandle = candles.at(-2);
  const change = latestCandle && previousCandle
    ? Number(latestCandle.close) - Number(previousCandle.close)
    : undefined;
  const changePercent = change !== undefined && previousCandle &&
    Number(previousCandle.close) !== 0
    ? (change / Number(previousCandle.close)) * 100
    : undefined;
  const dayStart = latestCandle ? latestCandle.closeTime - 86_400_000 : 0;
  const candlesInDay = candles.filter((candle) => candle.closeTime >= dayStart);
  const hasFullDay = candles[0] !== undefined && latestCandle !== undefined &&
    candles[0].openTime <= dayStart;
  const high24h = hasFullDay
    ? Math.max(...candlesInDay.map((candle) => Number(candle.high)))
    : undefined;
  const low24h = hasFullDay
    ? Math.min(...candlesInDay.map((candle) => Number(candle.low)))
    : undefined;

  useEffect(() => {
    const controller = new AbortController();
    setCandles([]);
    setError(null);
    setConnectionState("loading");
    setConnectionMessage("Loading historical candles");
    fetchHistoricalCandles({
      symbol,
      timeframe,
      limit: 1000,
      ...(startTime === undefined ? {} : { startTime }),
      ...(endTime === undefined ? {} : { endTime })
    }, controller.signal)
      .then((result) => {
        setCandles(result);
        setConnectionMessage(result.length
          ? `${result.length} historical candles loaded`
          : "No candles returned for this date range");
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        setConnectionState("error");
        setConnectionMessage("Market API unavailable");
      });
    return () => controller.abort();
  }, [symbol, timeframe, startTime, endTime, refreshVersion]);

  useEffect(() => {
    const historicalEndReached = endTime !== undefined && endTime < Date.now();
    if (historicalEndReached) {
      setConnectionState("historical");
      setConnectionMessage("Historical date range selected");
      return;
    }

    let active = true;
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempt = 0;
    let polling = false;
    let upstreamConnected = false;
    const controller = new AbortController();

    const connect = () => {
      if (!active) return;
      setConnectionState("connecting");
      const nextSocket = new WebSocket(marketStreamUrl(symbol, timeframe));
      socket = nextSocket;
      nextSocket.addEventListener("open", () => {
        if (!active) return;
        reconnectAttempt = 0;
        setConnectionState("connected");
        setConnectionMessage("Live market stream connected");
      });
      nextSocket.addEventListener("message", (event) => {
        if (!active || typeof event.data !== "string") return;
        try {
          const message = parseMarketStreamMessage(event.data);
          if (message.type === "candle") {
            setCandles((current) => mergeCandles(current, [message.candle]));
          } else if (message.type === "status") {
            upstreamConnected = message.status.connected;
            setConnectionState(message.status.connected ? "connected" : "reconnecting");
            setConnectionMessage(message.status.connected
              ? message.status.message
              : `${message.status.message}; using REST polling`);
          } else {
            setError(message.message);
            setConnectionState("error");
            setConnectionMessage(message.message);
          }
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
      nextSocket.addEventListener("error", () => {
        if (active) setConnectionMessage("Live stream interrupted; retrying");
      });
      nextSocket.addEventListener("close", () => {
        if (!active) return;
        upstreamConnected = false;
        setConnectionState("reconnecting");
        setConnectionMessage("Reconnecting to live market stream");
        const delay = Math.min(1000 * 2 ** reconnectAttempt, 30_000);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      });
    };

    connect();
    const pollTimer = setInterval(async () => {
      if (!active || polling || upstreamConnected) return;
      polling = true;
      try {
        const latest = await fetchHistoricalCandles({
          symbol,
          timeframe,
          limit: 2,
          ...(startTime === undefined ? {} : { startTime }),
          ...(endTime === undefined ? {} : { endTime })
        }, controller.signal);
        if (active) setCandles((current) => mergeCandles(current, latest));
      } catch (cause) {
        if (active && !controller.signal.aborted) {
          setConnectionState("error");
          setConnectionMessage("Live stream and REST polling are unavailable");
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        polling = false;
      }
    }, 15_000);

    return () => {
      active = false;
      controller.abort();
      clearInterval(pollTimer);
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [symbol, timeframe, startTime, endTime]);

  function applyMarketSelection(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = symbolInput.trim().toUpperCase();
    if (!/^[A-Z0-9]{6,20}$/.test(normalized)) {
      setError("Enter a valid market symbol such as BTCUSDT.");
      return;
    }
    if (startDate && endDate && startDate > endDate) {
      setError("The start date must be on or before the end date.");
      return;
    }
    setError(null);
    setSymbol(normalized);
  }

  const statusClass = `status-indicator status-${connectionState}`;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Signal Desk home">
          <span className="brand-mark">S</span>
          <span>signal<span className="brand-light">desk</span></span>
        </a>
        <nav className="primary-nav" aria-label="Main navigation">
          <a className="selected" href="#chart">Markets</a>
          <a href="#performance">Performance</a>
        </nav>
        <div className="topbar-status">
          <span className={statusClass} />
          <span>{connectionState === "connected" ? "Live" : connectionState}</span>
        </div>
      </header>

      <section className="market-controls" aria-label="Market selection">
        <form className="market-form" onSubmit={applyMarketSelection}>
          <label className="control-symbol">
            <span>Market</span>
            <input
              aria-label="Symbol"
              list="market-suggestions"
              value={symbolInput}
              onChange={(event) => setSymbolInput(event.target.value)}
              spellCheck={false}
            />
            <datalist id="market-suggestions">
              {SYMBOL_SUGGESTIONS.map((suggestion) => (
                <option key={suggestion} value={suggestion} />
              ))}
            </datalist>
          </label>
          <label>
            <span>Timeframe</span>
            <select
              value={timeframe}
              onChange={(event) => {
                if (isMarketTimeframe(event.target.value)) setTimeframe(event.target.value);
              }}
            >
              {SUPPORTED_TIMEFRAMES.map((interval) => (
                <option key={interval} value={interval}>
                  {interval === "1M" ? "1 month" : interval}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>From (UTC)</span>
            <input
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </label>
          <label>
            <span>To (UTC)</span>
            <input
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </label>
          <button type="submit" className="apply-button">Load chart</button>
          <button
            type="button"
            className="refresh-button"
            onClick={() => setRefreshVersion((version) => version + 1)}
            aria-label="Refresh historical candles"
          >
            ↻
          </button>
        </form>
      </section>

      <section className="market-summary" id="chart">
        <div className="pair-heading">
          <span className="coin-icon">{symbol.slice(0, 1)}</span>
          <div>
            <h1>{symbol}</h1>
            <span className="pair-subtitle">Binance Spot · {timeframe === "1M" ? "1 month" : timeframe}</span>
          </div>
        </div>
        <div className="price-summary">
          <strong>{formatPrice(latestCandle?.close)}</strong>
          {changePercent !== undefined && (
            <span className={changePercent >= 0 ? "positive-change" : "negative-change"}>
              {changePercent >= 0 ? "+" : ""}{changePercent.toFixed(2)}%
            </span>
          )}
        </div>
        <div className="summary-stat">
          <span>24h high / low</span>
          <strong>{high24h === undefined || low24h === undefined
            ? "—"
            : `${formatPrice(String(high24h))} / ${formatPrice(String(low24h))}`
          }</strong>
        </div>
        <div className="summary-stat">
          <span>Candle end (UTC)</span>
          <strong>
            {latestCandle
              ? `${new Date(latestCandle.closeTime).toLocaleTimeString("en-GB", { timeZone: "UTC" })} · ${latestCandle.closed ? "Closed" : "In progress"}`
              : "—"}
          </strong>
        </div>
        <div className="summary-stat">
          <span>Interval change</span>
          <strong className={change !== undefined && change >= 0 ? "positive-change" : "negative-change"}>
            {change === undefined ? "—" : `${change >= 0 ? "+" : ""}${formatPrice(String(change))}`}
          </strong>
        </div>
      </section>

      <div className="connection-banner" role="status">
        <span className={statusClass} />
        <span>{connectionMessage}</span>
        {error && <span className="connection-error">{error}</span>}
      </div>

      <MarketChart
        candles={candles}
        marketKey={`${symbol}:${timeframe}:${startDate}:${endDate}`}
      />

      <PaperDashboard />

      <footer className="app-footer">
        <span>Market data served by the platform API from Binance public endpoints.</span>
        <span>Paper trading only · No exchange orders</span>
      </footer>
    </main>
  );
}
