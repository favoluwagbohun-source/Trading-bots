import { useState, useEffect, useMemo } from "react";
import type { Candle } from "@crypto-signal/shared";
import type { MarketTimeframe } from "@crypto-signal/market-data";
import { evaluateQuantitativeConsistency, type QuantSignalResult } from "../../../../packages/strategies/src/index.js";
import { fetchHistoricalCandles } from "../market-api.js";
import { formatPrice } from "../chart-state.js";
import type { ChartTradeOverlay } from "../chart-state.js";

interface SignalFeedViewProps {
  readonly watchlist: readonly string[];
  readonly onPlotTrade: (overlay: ChartTradeOverlay) => void;
  readonly onSelectSymbol: (symbol: string, timeframe: MarketTimeframe) => void;
}

const FEED_TIMEFRAMES: readonly MarketTimeframe[] = ["5m", "1h", "4h", "1d"];

interface FeedSignalItem extends QuantSignalResult {
  readonly datasetCandleCount: number;
}

export function SignalFeedView({
  watchlist,
  onPlotTrade,
  onSelectSymbol
}: SignalFeedViewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signals, setSignals] = useState<readonly FeedSignalItem[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<string>("all");
  const [selectedTimeframe, setSelectedTimeframe] = useState<string>("all");
  const [selectedStrategy, setSelectedStrategy] = useState<string>("all");
  const [minConsistency, setMinConsistency] = useState<number>(50);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    async function loadFeed() {
      setLoading(true);
      setError(null);
      try {
        const aggregated: FeedSignalItem[] = [];
        const activeWatchlist = watchlist.length > 0 ? watchlist : ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];

        for (const symbol of activeWatchlist.slice(0, 8)) {
          for (const timeframe of FEED_TIMEFRAMES) {
            if (!active) return;
            try {
              const candles = await fetchHistoricalCandles({
                symbol,
                timeframe,
                limit: 300
              }, controller.signal);

              if (candles.length > 0) {
                const results = evaluateQuantitativeConsistency({
                  symbol,
                  timeframe,
                  candles
                });
                for (const res of results) {
                  aggregated.push({
                    ...res,
                    datasetCandleCount: candles.length
                  });
                }
              }
            } catch {
              // Ignore individual symbol/tf failures in aggregate feed
            }
          }
        }

        if (!active) return;
        // Sort newest first
        aggregated.sort((a, b) => b.timestamp - a.timestamp);
        setSignals(aggregated);
        setLoading(false);
      } catch (cause: unknown) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      }
    }

    loadFeed();

    return () => {
      active = false;
      controller.abort();
    };
  }, [watchlist]);

  const filteredSignals = useMemo(() => {
    return signals.filter((sig) => {
      if (selectedSymbol !== "all" && sig.symbol !== selectedSymbol) return false;
      if (selectedTimeframe !== "all" && sig.timeframe !== selectedTimeframe) return false;
      if (selectedStrategy !== "all" && sig.strategy !== selectedStrategy) return false;
      if (sig.consistencyScore < minConsistency) return false;
      return true;
    });
  }, [signals, selectedSymbol, selectedTimeframe, selectedStrategy, minConsistency]);

  return (
    <section className="surface-card" aria-label="Signal Feed dashboard" style={{ padding: "20px" }}>
      <div className="subblock-header" style={{ marginBottom: "16px" }}>
        <div>
          <h3>Quantitative Signal Feed</h3>
          <p className="muted-copy">
            Chronological live stream of mathematical expectancy and volatility-filtered trading signals across market watchlists.
          </p>
        </div>
        <span className="mono-label">{filteredSignals.length} active signals</span>
      </div>

      <div className="filter-toolbar" style={{ display: "flex", flexWrap: "wrap", gap: "12px", marginBottom: "20px", background: "var(--surface-raised)", padding: "12px", borderRadius: "8px", border: "1px solid var(--line)" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", color: "var(--muted)" }}>
          <span>Symbol</span>
          <select
            value={selectedSymbol}
            onChange={(e) => setSelectedSymbol(e.target.value)}
            style={{ background: "var(--bg)", color: "var(--text-strong)", border: "1px solid var(--line)", padding: "6px 10px", borderRadius: "6px" }}
          >
            <option value="all">All Symbols ({watchlist.length || 5})</option>
            {watchlist.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", color: "var(--muted)" }}>
          <span>Timeframe</span>
          <select
            value={selectedTimeframe}
            onChange={(e) => setSelectedTimeframe(e.target.value)}
            style={{ background: "var(--bg)", color: "var(--text-strong)", border: "1px solid var(--line)", padding: "6px 10px", borderRadius: "6px" }}
          >
            <option value="all">All Timeframes</option>
            {FEED_TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>{tf}</option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", color: "var(--muted)" }}>
          <span>Strategy</span>
          <select
            value={selectedStrategy}
            onChange={(e) => setSelectedStrategy(e.target.value)}
            style={{ background: "var(--bg)", color: "var(--text-strong)", border: "1px solid var(--line)", padding: "6px 10px", borderRadius: "6px" }}
          >
            <option value="all">All Strategies</option>
            <option value="top_down_trendline">Top-Down Trendline</option>
            <option value="break_and_retest">Break &amp; Retest</option>
            <option value="liquidity_sweep_reversal">Liquidity Sweep Reversal</option>
            <option value="order_block_retest">Order Block Retest</option>
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", color: "var(--muted)" }}>
          <span>Min Consistency</span>
          <select
            value={minConsistency}
            onChange={(e) => setMinConsistency(Number(e.target.value))}
            style={{ background: "var(--bg)", color: "var(--text-strong)", border: "1px solid var(--line)", padding: "6px 10px", borderRadius: "6px" }}
          >
            <option value={50}>50%+</option>
            <option value={70}>70%+</option>
            <option value={80}>80%+</option>
            <option value={90}>90%+</option>
          </select>
        </label>
      </div>

      {loading ? (
        <div className="empty-state-panel" style={{ padding: "40px", textAlign: "center", color: "var(--muted)" }}>
          Scanning live market watchlists for quantitative signals...
        </div>
      ) : error ? (
        <div className="chart-error-strip" role="alert" style={{ marginBottom: "16px" }}>
          <span>Failed to scan signal feed: {error}</span>
        </div>
      ) : filteredSignals.length === 0 ? (
        <div className="empty-state-panel" style={{ padding: "40px", textAlign: "center", color: "var(--muted)" }}>
          No trading signals match the current filters. Try relaxing symbol or consistency constraints.
        </div>
      ) : (
        <div className="stacked-list" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {filteredSignals.map((sig) => {
            const isBuy = sig.side === "buy";
            const timeStr = new Date(sig.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
            const dateStr = new Date(sig.timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
            return (
              <article
                key={sig.id}
                className="surface-card"
                style={{ background: "var(--surface)", border: "1px solid var(--line)", padding: "16px", borderRadius: "10px" }}
              >
                <div className="card-top-line" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <button
                      type="button"
                      onClick={() => onSelectSymbol(sig.symbol, sig.timeframe as MarketTimeframe)}
                      style={{ background: "var(--surface-raised)", border: "1px solid var(--line)", color: "var(--text-strong)", padding: "4px 8px", borderRadius: "6px", fontWeight: "700", fontSize: "13px" }}
                    >
                      {sig.symbol}
                    </button>
                    <span className="mono-meta" style={{ background: "var(--bg)", padding: "2px 6px", borderRadius: "4px", fontSize: "12px" }}>
                      {sig.timeframe}
                    </span>
                    <strong className={isBuy ? "tone-bullish" : "tone-bearish"} style={{ fontSize: "14px" }}>
                      {sig.side.toUpperCase()} · {sig.strategy.replace(/_/g, " ").toUpperCase()}
                    </strong>
                  </div>
                  <div className="metric-strip-inline" style={{ display: "flex", gap: "16px", fontSize: "13px" }}>
                    <span>Consistency: <strong style={{ color: "var(--gold)" }}>{sig.consistencyScore}%</strong></span>
                    <span>Expectancy: <strong className={sig.expectancyScore >= 1 ? "tone-bullish" : "tone-caution"}>{sig.expectancyScore}R</strong></span>
                  </div>
                </div>

                <div className="metric-strip-inline" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "8px", background: "var(--bg)", padding: "10px", borderRadius: "8px", margin: "10px 0", fontSize: "13px" }}>
                  <div>
                    <span className="muted-meta" style={{ display: "block", fontSize: "11px" }}>ENTRY PRICE</span>
                    <strong className="mono-label">{formatPrice(sig.entryPrice)}</strong>
                  </div>
                  <div>
                    <span className="muted-meta" style={{ display: "block", fontSize: "11px" }}>STOP LOSS (EXIT)</span>
                    <strong className="mono-label" style={{ color: "var(--red)" }}>{formatPrice(sig.stopLoss)}</strong>
                  </div>
                  <div>
                    <span className="muted-meta" style={{ display: "block", fontSize: "11px" }}>TARGET 1 (EXIT)</span>
                    <strong className="mono-label" style={{ color: "var(--green)" }}>{formatPrice(sig.target1)}</strong>
                  </div>
                  <div>
                    <span className="muted-meta" style={{ display: "block", fontSize: "11px" }}>TARGET 2 (EXIT)</span>
                    <strong className="mono-label" style={{ color: "var(--green)" }}>{formatPrice(sig.target2)}</strong>
                  </div>
                </div>

                <p className="muted-copy" style={{ margin: "8px 0", fontSize: "13px", color: "var(--text-strong)" }}>
                  {sig.rationale}
                </p>

                <div className="card-footer-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px", paddingTop: "10px", borderTop: "1px solid var(--line)" }}>
                  <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                    <span className="mono-meta" style={{ fontSize: "12px", color: "var(--muted)" }}>
                      {dateStr} {timeStr}
                    </span>
                    <span className="mono-meta" style={{ fontSize: "12px", background: "var(--surface-raised)", padding: "2px 6px", borderRadius: "4px" }}>
                      Confidence: {sig.confidence.toUpperCase()}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="primary-cta"
                    onClick={() =>
                      onPlotTrade({
                        symbol: sig.symbol,
                        strategy: sig.strategy,
                        side: sig.side === "buy" ? "long" : "short",
                        entryPrice: sig.entryPrice,
                        stopPrice: sig.stopLoss,
                        target1: sig.target1,
                        target2: sig.target2,
                        label: `${sig.strategy.replace(/_/g, " ")} (${sig.consistencyScore}%)`
                      })
                    }
                    style={{ background: "var(--gold)", color: "#000", border: 0, padding: "6px 14px", borderRadius: "6px", fontWeight: "600", fontSize: "13px" }}
                  >
                    Plot on Chart
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
