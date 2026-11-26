import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { Candle, StrategyId } from "@crypto-signal/shared";
import type { MarketTimeframe } from "@crypto-signal/market-data";
import {
  OVERLAY_LENS_OPTIONS,
  selectChartAnalysisOverlay,
  type OverlayLens
} from "./chart-overlays.js";
import { AnalysisView } from "./components/AnalysisView.js";
import { EngineStatusView } from "./components/EngineStatusView.js";
import { MarketChart } from "./components/MarketChart.js";
import { PairPickerModal } from "./components/PairPickerModal.js";
import { QuantSignalsView } from "./components/QuantSignalsView.js";
import { SignalFeedView } from "./components/SignalFeedView.js";
import { PaperDashboard } from "./PaperDashboard.js";
import {
  ORDERED_TIMEFRAMES,
  endOfUtcDay,
  formatPrice,
  formatTimeframeLabel,
  formatVolume,
  mergeCandles,
  normalizeChartSymbol,
  startOfUtcDay,
  summarizeTopDownAlignment,
  type ChartTradeOverlay
} from "./chart-state.js";
import {
  fetchHistoricalCandles,
  fetchMarketAnalysis,
  fetchPlatformHealth,
  marketStreamUrl,
  parseMarketStreamMessage,
  type MarketAnalysisData,
  type PlatformHealthBundle
} from "./market-api.js";

type AppTab = "chart" | "analysis" | "quant" | "feed" | "desk" | "engine";
type ConnectionState = "loading" | "connecting" | "connected" | "reconnecting" | "historical" | "error";

const DEFAULT_PAIRS = ["BTCUSDT", "BTCUSDC", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];

function initialSymbolFromUrl(): string {
  if (typeof window === "undefined") return "BTCUSDT";
  const raw = new URLSearchParams(window.location.search).get("symbol");
  return (raw && normalizeChartSymbol(raw)) || "BTCUSDT";
}

function initialTabFromUrl(): AppTab {
  if (typeof window === "undefined") return "chart";
  const raw = new URLSearchParams(window.location.search).get("tab");
  if (raw === "analysis" || raw === "quant" || raw === "feed" || raw === "desk" || raw === "engine") return raw;
  return "chart";
}

export function ChartPage() {
  const [activeTab, setActiveTab] = useState<AppTab>(initialTabFromUrl);
  const [symbol, setSymbol] = useState<string>(initialSymbolFromUrl);
  const [timeframe, setTimeframe] = useState<MarketTimeframe>("5m");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("loading");
  const [connectionMessage, setConnectionMessage] = useState("Loading");
  const [error, setError] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [showSideRail, setShowSideRail] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [overlayLens, setOverlayLens] = useState<OverlayLens>("auto");
  const [enabledStrategies, setEnabledStrategies] = useState<Set<OverlayLens | "swings">>(
    () => new Set(["top_down_trendline", "break_and_retest", "order_block_retest"])
  );
  const [pairPickerOpen, setPairPickerOpen] = useState(false);
  const [activeTradeOverlay, setActiveTradeOverlay] = useState<ChartTradeOverlay | null>(null);

  const [analysis, setAnalysis] = useState<MarketAnalysisData | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisTick, setAnalysisTick] = useState(0);

  const [health, setHealth] = useState<PlatformHealthBundle | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthTick, setHealthTick] = useState(0);

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

  const availablePairs = useMemo(() => {
    const merged = new Set<string>([
      ...(health?.signalEngine.watchlist ?? []),
      ...DEFAULT_PAIRS
    ]);
    return [...merged];
  }, [health]);

  const topDownSummary = useMemo(
    () => (analysis ? summarizeTopDownAlignment(analysis.timeframes) : null),
    [analysis]
  );

  const topDownBiasLabel = useMemo(() => {
    if (!analysis) return null;
    const bias = analysis.topDownBias?.trim();
    if (bias && bias !== "neutral") {
      return `1D → ${formatTimeframeLabel(timeframe)}: ${bias}`;
    }
    if (topDownSummary) {
      return `1D → ${formatTimeframeLabel(timeframe)}: ${topDownSummary.dominantRegime}`;
    }
    return null;
  }, [analysis, timeframe, topDownSummary]);

  const breakoutNoticeLabel = useMemo(() => {
    const notice = analysis?.breakoutAnticipation;
    if (!notice) return null;
    return `${notice.side === "buy" ? "Bullish" : "Bearish"} Breakout Watch · ${notice.note}`;
  }, [analysis]);

  const overlayBundle = useMemo(
    () =>
      selectChartAnalysisOverlay({
        enabledStrategies,
        chartTimeframe: timeframe,
        candles,
        analysis,
        activeTradeOverlay
      }),
    [activeTradeOverlay, analysis, candles, enabledStrategies, timeframe]
  );

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp) return;
    webApp.ready();
    webApp.expand();
    webApp.setHeaderColor?.("#12161c");
    webApp.setBackgroundColor?.("#0b0e11");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setCandles([]);
    setError(null);
    setConnectionState("loading");
    setConnectionMessage("Loading");
    fetchHistoricalCandles({
      symbol,
      timeframe,
      limit: 1000,
      ...(startTime === undefined ? {} : { startTime }),
      ...(endTime === undefined ? {} : { endTime })
    }, controller.signal)
      .then((result) => {
        setCandles((current) => mergeCandles(result, current));
        setConnectionMessage(result.length ? "Live" : "No candles");
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        setConnectionState("error");
        setConnectionMessage("Unavailable");
      });
    return () => controller.abort();
  }, [symbol, timeframe, startTime, endTime, refreshVersion]);

  useEffect(() => {
    const historicalEndReached = endTime !== undefined && endTime < Date.now();
    if (historicalEndReached) {
      setConnectionState("historical");
      setConnectionMessage("Historical");
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
      setConnectionMessage("Connecting");
      const nextSocket = new WebSocket(marketStreamUrl(symbol, timeframe));
      socket = nextSocket;
      nextSocket.addEventListener("open", () => {
        if (!active) return;
        reconnectAttempt = 0;
        setConnectionState("connected");
        setConnectionMessage("Live");
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
            setConnectionMessage(message.status.connected ? "Live" : "Polling");
          } else {
            setError(message.message);
            setConnectionState("error");
            setConnectionMessage("Error");
          }
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
      nextSocket.addEventListener("error", () => {
        if (active) setConnectionMessage("Retrying");
      });
      nextSocket.addEventListener("close", () => {
        if (!active) return;
        upstreamConnected = false;
        setConnectionState("reconnecting");
        setConnectionMessage("Reconnecting");
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
          setConnectionMessage("Unavailable");
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

  useEffect(() => {
    const controller = new AbortController();
    setAnalysisLoading(true);
    setAnalysisError(null);
    fetchMarketAnalysis(symbol, controller.signal, timeframe)
      .then((result) => {
        setAnalysis(result);
        setAnalysisLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setAnalysisError(cause instanceof Error ? cause.message : String(cause));
        setAnalysisLoading(false);
      });
    return () => controller.abort();
  }, [symbol, timeframe, analysisTick]);

  useEffect(() => {
    const controller = new AbortController();
    setHealthLoading(true);
    setHealthError(null);
    fetchPlatformHealth(controller.signal)
      .then((result) => {
        setHealth(result);
        setHealthLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setHealthError(cause instanceof Error ? cause.message : String(cause));
        setHealthLoading(false);
      });
    return () => controller.abort();
  }, [healthTick]);

  const handleSelectSymbol = useCallback((nextSymbol: string) => {
    setSymbol(nextSymbol);
    if (activeTradeOverlay && activeTradeOverlay.symbol !== nextSymbol) {
      setActiveTradeOverlay(null);
    }
  }, [activeTradeOverlay]);

  const handlePlotTrade = useCallback((overlay: ChartTradeOverlay) => {
    setSymbol(overlay.symbol);
    setTimeframe("5m");
    setOverlayLens(overlay.strategy ?? "auto");
    setActiveTradeOverlay(overlay);
    setActiveTab("chart");
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isFullscreen && !document.fullscreenElement) {
        setIsFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isFullscreen]);

  const handleToggleFullscreen = useCallback(async () => {
    if (isFullscreen) {
      if (document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch {
          // Fallback to viewport CSS fullscreen exit
        }
      }
      setIsFullscreen(false);
      return;
    }
    setIsFullscreen(true);
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      // Fallback to viewport CSS fullscreen mode in embedded contexts
    }
  }, [isFullscreen]);

  const handlePreviewStrategy = useCallback((strategy: StrategyId) => {
    setOverlayLens(strategy);
    if (strategy === "top_down_trendline") {
      setEnabledStrategies(new Set(["top_down_trendline"]));
    } else if (strategy === "break_and_retest") {
      setEnabledStrategies(new Set(["break_and_retest", "order_block_retest"]));
    } else if (strategy === "order_block_retest") {
      setEnabledStrategies(new Set(["order_block_retest"]));
    } else {
      setEnabledStrategies(new Set(["top_down_trendline", "break_and_retest", "order_block_retest"]));
    }
    setActiveTab("chart");
  }, []);

  const handleSelectOverlayLens = useCallback((nextLens: OverlayLens) => {
    setOverlayLens(nextLens);
    if (nextLens === "off") {
      setEnabledStrategies(new Set());
    } else if (nextLens === "top_down_trendline") {
      setEnabledStrategies(new Set(["top_down_trendline"]));
    } else if (nextLens === "break_and_retest") {
      setEnabledStrategies(new Set(["break_and_retest", "order_block_retest"]));
    } else {
      setEnabledStrategies(new Set(["top_down_trendline", "break_and_retest", "order_block_retest"]));
    }
  }, []);

  function applyDateRange(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (startDate && endDate && startDate > endDate) {
      setError("The start date must be on or before the end date.");
      return;
    }
    setError(null);
    setRefreshVersion((version) => version + 1);
  }

  const dateControls = (
    <form className="date-range-form" onSubmit={applyDateRange}>
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
      <button type="submit">Apply range</button>
      {(startDate || endDate) && (
        <button
          type="button"
          className="quiet-button"
          onClick={() => {
            setStartDate("");
            setEndDate("");
          }}
        >
          Live latest
        </button>
      )}
    </form>
  );

  return (
    <main className={isFullscreen && activeTab === "chart" ? "app-shell chart-fullscreen" : "app-shell"}>
      <header className="app-topbar">
        <div className="topbar-zone-brand">
          <a
            className="brand"
            href="/"
            onClick={(event) => {
              event.preventDefault();
              setActiveTab("chart");
            }}
          >
            Signal Desk
          </a>
          <button
            type="button"
            className="mobile-pair-trigger"
            onClick={() => setPairPickerOpen(true)}
            aria-label={`Change trading pair, currently ${symbol}`}
          >
            <strong className="mono-label">{symbol}</strong>
            <span aria-hidden="true">▾</span>
          </button>
        </div>

        <nav className="desktop-nav" aria-label="Primary views">
          {(
            [
              ["chart", "Chart"],
              ["analysis", "Analysis"],
              ["quant", "Quant"],
              ["feed", "Signal Feed"],
              ["desk", "Paper Desk"],
              ["engine", "Engine"]
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={activeTab === id ? "nav-tab active" : "nav-tab"}
              onClick={() => setActiveTab(id)}
              aria-current={activeTab === id ? "page" : undefined}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="topbar-zone-right">
          <div className="ticker-readout">
            <strong className="ticker-price">{formatPrice(latestCandle?.close)}</strong>
            {changePercent !== undefined && (
              <span className={changePercent >= 0 ? "positive-change" : "negative-change"}>
                {changePercent >= 0 ? "+" : ""}{changePercent.toFixed(2)}%
              </span>
            )}
          </div>
          <span className="mobile-stream-label" role="status">
            {connectionMessage}
          </span>
          <button
            type="button"
            className="desktop-pair-cta"
            onClick={() => setPairPickerOpen(true)}
          >
            <span className="mono-label">{symbol}</span>
            <span aria-hidden="true">▾</span>
          </button>
          <button
            type="button"
            className="mobile-refresh-btn"
            onClick={() => {
              setRefreshVersion((v) => v + 1);
              setAnalysisTick((v) => v + 1);
            }}
            aria-label="Refresh market data"
          >
            ↻
          </button>
        </div>
      </header>

      {error && (
        <div className="chart-error-strip" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}

      {activeTab === "chart" && (
        <div className="chart-workspace">
          <div className="workspace-toolbar">
            <div className="toolbar-left">
              <div className="timeframe-bar" role="group" aria-label="Timeframe">
                {ORDERED_TIMEFRAMES.map((interval) => (
                  <button
                    key={interval}
                    type="button"
                    className={timeframe === interval ? "tf-button active" : "tf-button"}
                    onClick={() => setTimeframe(interval)}
                    aria-pressed={timeframe === interval}
                  >
                    {formatTimeframeLabel(interval)}
                  </button>
                ))}
              </div>
              {latestCandle && (
                <div className="ohlc-readout">
                  <span>O {formatPrice(latestCandle.open)}</span>
                  <span>H {formatPrice(latestCandle.high)}</span>
                  <span>L {formatPrice(latestCandle.low)}</span>
                  <span>Vol {formatVolume(latestCandle.volume)}</span>
                </div>
              )}
            </div>

            <div className="toolbar-right">
              <span className={`stream-text stream-${connectionState}`}>
                {connectionMessage}
              </span>
              <select
                className="ta-overlay-select"
                aria-label="Technical analysis overlay"
                value={overlayLens}
                onChange={(event) => handleSelectOverlayLens(event.target.value as OverlayLens)}
              >
                {OVERLAY_LENS_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={showTools ? "bar-button active" : "bar-button"}
                onClick={() => setShowTools((open) => !open)}
                aria-expanded={showTools}
              >
                Draw
              </button>
              <button
                type="button"
                className={isFullscreen ? "bar-button active" : "bar-button"}
                onClick={handleToggleFullscreen}
                aria-pressed={isFullscreen}
              >
                {isFullscreen ? "Normal Screen" : "Full Screen"}
              </button>
              <button
                type="button"
                className={showSideRail ? "bar-button desktop-only-btn active" : "bar-button desktop-only-btn"}
                onClick={() => setShowSideRail((open) => !open)}
                aria-pressed={showSideRail}
              >
                {showSideRail ? "Hide Intel" : "Show Intel"}
              </button>
            </div>
          </div>

          <div className="chart-split-stage">
            <div className="chart-main-pane">
              <MarketChart
                candles={candles}
                marketKey={`${symbol}:${timeframe}:${startDate}:${endDate}`}
                symbol={symbol}
                timeframeLabel={formatTimeframeLabel(timeframe)}
                topDownBiasLabel={topDownBiasLabel}
                breakoutNoticeLabel={breakoutNoticeLabel}
                isFullscreen={isFullscreen}
                onToggleFullscreen={handleToggleFullscreen}
                showTools={showTools}
                onCloseTools={() => setShowTools(false)}
                dateControls={dateControls}
                overlayBundle={overlayBundle}
                activeTradeOverlay={activeTradeOverlay}
                onClearTradeOverlay={() => setActiveTradeOverlay(null)}
              />
            </div>

            {showSideRail && !isFullscreen && (
              <aside className="intel-side-rail" aria-label="Live market intelligence">
                <div className="rail-watchlist">
                  <div className="subblock-header">
                    <h3>Quick Pairs</h3>
                    <span className="muted-meta">Binance Spot</span>
                  </div>
                  <div className="quick-pair-grid">
                    {availablePairs.slice(0, 6).map((pair) => (
                      <button
                        key={pair}
                        type="button"
                        className={pair === symbol ? "quick-pair-btn active" : "quick-pair-btn"}
                        onClick={() => handleSelectSymbol(pair)}
                      >
                        {pair}
                      </button>
                    ))}
                  </div>
                </div>

                {topDownSummary && (
                  <div className="rail-bias-strip">
                    <span className="muted-meta">Top-Down (1D → {formatTimeframeLabel(timeframe)})</span>
                    <strong
                      className={
                        topDownSummary.dominantRegime === "bullish"
                          ? "tone-bullish"
                          : topDownSummary.dominantRegime === "bearish"
                            ? "tone-bearish"
                            : topDownSummary.dominantRegime === "mixed"
                              ? "tone-caution"
                              : "tone-neutral"
                      }
                    >
                      {analysis?.topDownBias && analysis.topDownBias !== "neutral"
                        ? analysis.topDownBias
                        : topDownSummary.dominantRegime === "mixed"
                          ? `${topDownSummary.bullishCount} Bullish · ${topDownSummary.bearishCount} Bearish`
                          : `${topDownSummary.alignedCount}/${topDownSummary.totalAvailable} ${topDownSummary.dominantRegime}`}
                    </strong>
                  </div>
                )}

                {analysis?.breakoutAnticipation && (
                  <div className="surface-card" role="status">
                    <div className="card-top-line">
                      <strong className="card-title">Breakout Expectation Notice</strong>
                      <span className={analysis.breakoutAnticipation.side === "buy" ? "tone-bullish" : "tone-bearish"}>
                        {analysis.breakoutAnticipation.side === "buy" ? "Bullish Watch" : "Bearish Watch"}
                      </span>
                    </div>
                    <p className="evaluation-reason">{analysis.breakoutAnticipation.note}</p>
                    <span className="mono-meta">
                      Key Level {formatPrice(analysis.breakoutAnticipation.levelPrice)} · Dist{" "}
                      {analysis.breakoutAnticipation.distancePercent.toFixed(2)}%
                    </span>
                  </div>
                )}

                <AnalysisView
                  symbol={symbol}
                  analysis={analysis}
                  loading={analysisLoading}
                  error={analysisError}
                  compact
                  onRefresh={() => setAnalysisTick((v) => v + 1)}
                  onPlotTrade={handlePlotTrade}
                  onPreviewStrategy={handlePreviewStrategy}
                  onOpenChartWithAutoLines={() => handlePreviewStrategy("top_down_trendline")}
                />
              </aside>
            )}
          </div>
        </div>
      )}

      {activeTab === "quant" && (
        <QuantSignalsView
          symbol={symbol}
          timeframe={timeframe}
          candles={candles}
          onPlotTrade={handlePlotTrade}
        />
      )}

      {activeTab === "feed" && (
        <SignalFeedView
          watchlist={availablePairs}
          onPlotTrade={handlePlotTrade}
          onSelectSymbol={(nextSymbol, nextTimeframe) => {
            setSymbol(nextSymbol);
            setTimeframe(nextTimeframe);
            setActiveTab("chart");
          }}
        />
      )}

      {activeTab === "analysis" && (
        <AnalysisView
          symbol={symbol}
          analysis={analysis}
          loading={analysisLoading}
          error={analysisError}
          onRefresh={() => setAnalysisTick((v) => v + 1)}
          onPlotTrade={handlePlotTrade}
          onPreviewStrategy={handlePreviewStrategy}
          onOpenChartWithAutoLines={() => handlePreviewStrategy("top_down_trendline")}
        />
      )}

      {activeTab === "desk" && (
        <PaperDashboard
          health={health}
          onPlotTrade={handlePlotTrade}
          onOpenEngineStatus={() => setActiveTab("engine")}
        />
      )}

      {activeTab === "engine" && (
        <EngineStatusView
          health={health}
          loading={healthLoading}
          error={healthError}
          onRefresh={() => setHealthTick((v) => v + 1)}
          onSelectSymbol={(nextSymbol) => {
            handleSelectSymbol(nextSymbol);
            setActiveTab("chart");
          }}
        />
      )}

      <nav className="mobile-bottom-nav" aria-label="Telegram Mini App navigation">
        <button
          type="button"
          className={activeTab === "chart" ? "bottom-nav-item active" : "bottom-nav-item"}
          onClick={() => setActiveTab("chart")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 4v16M7 8h-2v6h2M17 3v18M17 9h2v5h-2M12 6v12M12 10h2v4h-2" />
          </svg>
          <span>Chart</span>
        </button>
        <button
          type="button"
          className={activeTab === "quant" ? "bottom-nav-item active" : "bottom-nav-item"}
          onClick={() => setActiveTab("quant")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
          </svg>
          <span>Quant</span>
        </button>
        <button
          type="button"
          className={activeTab === "feed" ? "bottom-nav-item active" : "bottom-nav-item"}
          onClick={() => setActiveTab("feed")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
          <span>Feed</span>
        </button>
        <button
          type="button"
          className={activeTab === "desk" ? "bottom-nav-item active" : "bottom-nav-item"}
          onClick={() => setActiveTab("desk")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h16v12H4zM8 7V5h8v2M4 12h16" />
          </svg>
          <span>Desk</span>
        </button>
        <button
          type="button"
          className={activeTab === "engine" ? "bottom-nav-item active" : "bottom-nav-item"}
          onClick={() => setActiveTab("engine")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 12h4l3-7 4 14 3-7h4" />
          </svg>
          <span>Engine</span>
        </button>
      </nav>

      <PairPickerModal
        open={pairPickerOpen}
        currentSymbol={symbol}
        pairs={availablePairs}
        onSelect={handleSelectSymbol}
        onClose={() => setPairPickerOpen(false)}
      />
    </main>
  );
}
