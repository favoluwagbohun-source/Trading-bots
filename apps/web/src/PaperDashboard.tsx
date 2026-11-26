import { useEffect, useState } from "react";
import {
  formatHealthLabel,
  formatPrice,
  type ChartTradeOverlay
} from "./chart-state.js";
import type { PlatformHealthBundle } from "./market-api.js";

type Strategy =
  | "top_down_trendline"
  | "break_and_retest"
  | "liquidity_sweep_reversal"
  | "order_block_retest";

interface DashboardTrade {
  readonly signalId: string;
  readonly symbol: string;
  readonly strategy: Strategy;
  readonly side: "buy" | "sell";
  readonly status: "active" | "closed";
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly target1: number;
  readonly target2: number;
  readonly realizedPnl: number;
  readonly openedAt: number;
  readonly closedAt: number | null;
}

interface PaperDashboardData {
  readonly account: {
    readonly startingEquity: number | null;
    readonly currentEquity: number | null;
    readonly realizedPnl: number;
    readonly activeTradeCount: number;
  };
  readonly settings: {
    readonly paused: boolean;
    readonly paperTradingEnabled: boolean;
    readonly enabledStrategies: readonly Strategy[];
  };
  readonly activeTrades: readonly DashboardTrade[];
  readonly history: readonly DashboardTrade[];
  readonly strategyPerformance: readonly {
    readonly strategy: Strategy;
    readonly closedTrades: number;
    readonly wins: number;
    readonly realizedPnl: number;
  }[];
}

interface PaperDashboardProps {
  readonly health: PlatformHealthBundle | null;
  readonly onPlotTrade?: (overlay: ChartTradeOverlay) => void;
  readonly onOpenEngineStatus?: () => void;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        readonly initData: string;
        readonly initDataUnsafe?: {
          readonly user?: {
            readonly first_name?: string;
            readonly username?: string;
          };
        };
        ready(): void;
        expand(): void;
        setHeaderColor?(color: string): void;
        setBackgroundColor?(color: string): void;
      };
    };
  }
}

const STRATEGY_LABELS: Record<Strategy, string> = {
  top_down_trendline: "Top-down trendline",
  break_and_retest: "Break and retest",
  liquidity_sweep_reversal: "Liquidity sweep reversal",
  order_block_retest: "Order-block retest"
};

function formatCurrency(value: number | null): string {
  if (value === null) return "Not set";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(value);
}

function formatDate(value: number): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

export function PaperDashboard({
  health,
  onPlotTrade,
  onOpenEngineStatus
}: PaperDashboardProps) {
  const [data, setData] = useState<PaperDashboardData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const telegramUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
  const userLabel = telegramUser?.first_name
    ? telegramUser.username
      ? `${telegramUser.first_name} (@${telegramUser.username})`
      : telegramUser.first_name
    : null;

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp?.initData) {
      setStatus("unavailable");
      return;
    }

    webApp.ready();
    webApp.expand();
    const controller = new AbortController();
    setStatus("loading");
    fetch("/api/paper/dashboard", {
      headers: { authorization: `tma ${webApp.initData}` },
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) {
          const result: unknown = await response.json().catch(() => undefined);
          const message = typeof result === "object" && result !== null &&
            "error" in result && typeof result.error === "string"
            ? result.error
            : `Dashboard request failed (${response.status})`;
          throw new Error(message);
        }
        return response.json() as Promise<PaperDashboardData>;
      })
      .then((result) => {
        setData(result);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("error");
      });

    return () => controller.abort();
  }, [reloadTick]);

  const onePercentRisk = data?.account.currentEquity !== null && data?.account.currentEquity !== undefined
    ? data.account.currentEquity * 0.01
    : null;

  return (
    <section
      className="workspace-scroll-page"
      id="performance"
      aria-labelledby="performance-title"
    >
      <div className="section-header-row">
        <div>
          <h2 className="section-title" id="performance-title">
            {userLabel ? `Paper Desk · ${userLabel}` : "Paper Trading Desk"}
          </h2>
          <p className="section-subtitle">
            {data
              ? `${data.settings.paperTradingEnabled ? "Automatic paper entries on" : "Automatic paper entries off"} · Signal delivery ${data.settings.paused ? "paused" : "active"}`
              : "Simulated paper-trading portfolio authenticated via Telegram Mini App"}
          </p>
        </div>
        {status !== "unavailable" && (
          <button
            type="button"
            className="quiet-button"
            onClick={() => setReloadTick((value) => value + 1)}
          >
            {status === "loading" ? "Loading…" : "Refresh"}
          </button>
        )}
      </div>

      {status === "loading" && (
        <div className="empty-state-panel">
          <p>Authenticating your Telegram Mini App account…</p>
        </div>
      )}

      {status === "error" && (
        <p className="inline-alert" role="alert">
          {error ?? "Unable to load account performance."}
        </p>
      )}

      {status === "unavailable" && (
        <div className="cards-grid-2">
          <article className="surface-card">
            <div className="card-top-line">
              <h3 className="card-title">Open Inside Telegram Bot</h3>
              <span className="tone-caution">Web Preview</span>
            </div>
            <p className="muted-copy">
              Your private simulated balance, active paper trades, and signal history are tied directly to your Telegram chat ID and verified cryptographically via Telegram WebApp authorization.
            </p>
            <ol className="step-list">
              <li>Send <code>/start</code> to your trading bot in Telegram.</li>
              <li>Set your simulated USD balance with <code>/account 1000</code>.</li>
              <li>Enable automatic entries with <code>/paper on</code>.</li>
              <li>Tap <strong>Open Market Chart</strong> from the bot menu to unlock your authenticated desk here.</li>
            </ol>
          </article>

          <article className="surface-card">
            <div className="card-top-line">
              <h3 className="card-title">Live Paper Engine Summary</h3>
              {onOpenEngineStatus && (
                <button
                  type="button"
                  className="quiet-button"
                  onClick={onOpenEngineStatus}
                >
                  Engine Details
                </button>
              )}
            </div>
            {health ? (
              <div className="summary-kv-list">
                <div className="summary-kv">
                  <span className="muted-meta">Scanner state</span>
                  <strong>{formatHealthLabel(health.signalEngine.state)}</strong>
                </div>
                <div className="summary-kv">
                  <span className="muted-meta">Active system paper trades</span>
                  <strong className="mono-label">{health.signalEngine.activePaperTradeCount}</strong>
                </div>
                <div className="summary-kv">
                  <span className="muted-meta">Telegram bot</span>
                  <strong>{formatHealthLabel(health.telegram.state)}</strong>
                </div>
                <div className="summary-kv">
                  <span className="muted-meta">Watchlist</span>
                  <strong className="mono-label">
                    {health.signalEngine.watchlist.join(" · ") || "BTCUSDT · BTCUSDC"}
                  </strong>
                </div>
              </div>
            ) : (
              <p className="muted-copy">Waiting for worker engine health snapshot…</p>
            )}
          </article>
        </div>
      )}

      {data && (
        <>
          <div className="kpi-grid-4">
            <article className="surface-card kpi-card">
              <span className="kpi-label">Starting Balance</span>
              <strong className="kpi-value">{formatCurrency(data.account.startingEquity)}</strong>
              <span className="muted-meta">Per-chat baseline</span>
            </article>
            <article className="surface-card kpi-card">
              <span className="kpi-label">Simulated Equity</span>
              <strong className="kpi-value">{formatCurrency(data.account.currentEquity)}</strong>
              <span className="muted-meta">
                1% risk budget: {formatCurrency(onePercentRisk)}
              </span>
            </article>
            <article className="surface-card kpi-card">
              <span className="kpi-label">Realized P&amp;L</span>
              <strong className={data.account.realizedPnl >= 0 ? "kpi-value positive-change" : "kpi-value negative-change"}>
                {formatCurrency(data.account.realizedPnl)}
              </strong>
              <span className="muted-meta">Simulated closed trades</span>
            </article>
            <article className="surface-card kpi-card">
              <span className="kpi-label">Active Paper Trades</span>
              <strong className="kpi-value">{data.account.activeTradeCount}</strong>
              <span className="muted-meta">
                {data.settings.enabledStrategies.length}/4 strategies enabled
              </span>
            </article>
          </div>

          <div className="cards-grid-2">
            <section className="surface-card" aria-labelledby="active-trades-title">
              <div className="card-top-line">
                <h3 className="card-title" id="active-trades-title">Active Paper Trades</h3>
                <span className="muted-meta">{data.activeTrades.length} open</span>
              </div>
              {data.activeTrades.length === 0 ? (
                <p className="muted-copy">No active paper trades for this chat right now.</p>
              ) : (
                <div className="stacked-list">
                  {data.activeTrades.map((trade) => (
                    <div key={trade.signalId} className="trade-item-row">
                      <div className="card-top-line">
                        <strong className="mono-label">
                          {trade.symbol} · {trade.side === "buy" ? "LONG" : "SHORT"}
                        </strong>
                        <span className="muted-meta">{STRATEGY_LABELS[trade.strategy]}</span>
                      </div>
                      <div className="metric-strip-inline">
                        <span>Entry {formatPrice(trade.entryPrice)}</span>
                        <span>Stop {formatPrice(trade.stopPrice)}</span>
                        <span>TP1 {formatPrice(trade.target1)}</span>
                        <span>TP2 {formatPrice(trade.target2)}</span>
                      </div>
                      {onPlotTrade && (
                        <div className="card-footer-row">
                          <span className="muted-meta">{formatDate(trade.openedAt)}</span>
                          <button
                            type="button"
                            className="primary-cta"
                            onClick={() =>
                              onPlotTrade({
                                label: `${trade.symbol} · ${STRATEGY_LABELS[trade.strategy]}`,
                                symbol: trade.symbol,
                                side: trade.side === "buy" ? "long" : "short",
                                entryPrice: trade.entryPrice,
                                stopPrice: trade.stopPrice,
                                target1: trade.target1,
                                target2: trade.target2
                              })
                            }
                          >
                            Plot on Chart
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="surface-card" aria-labelledby="strategy-performance-title">
              <div className="card-top-line">
                <h3 className="card-title" id="strategy-performance-title">Strategy Performance</h3>
                <span className="muted-meta">4 engines</span>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Strategy</th>
                      <th>Closed</th>
                      <th>Win Rate</th>
                      <th>Realized P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.strategyPerformance.map((strategy) => (
                      <tr key={strategy.strategy}>
                        <td>{STRATEGY_LABELS[strategy.strategy]}</td>
                        <td>{strategy.closedTrades}</td>
                        <td>
                          {strategy.closedTrades
                            ? `${((strategy.wins / strategy.closedTrades) * 100).toFixed(0)}%`
                            : "—"}
                        </td>
                        <td className={strategy.realizedPnl >= 0 ? "positive-change" : "negative-change"}>
                          {formatCurrency(strategy.realizedPnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <section className="surface-card" aria-labelledby="signal-history-title">
            <div className="card-top-line">
              <h3 className="card-title" id="signal-history-title">Paper Signal History</h3>
              <span className="muted-meta">{data.history.length} recorded</span>
            </div>
            {data.history.length === 0 ? (
              <p className="muted-copy">No paper signals recorded for this chat yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Market</th>
                      <th>Strategy</th>
                      <th>Status</th>
                      <th>Opened</th>
                      <th>Realized P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.history.map((trade) => (
                      <tr key={trade.signalId}>
                        <td>{trade.symbol}</td>
                        <td>{STRATEGY_LABELS[trade.strategy]}</td>
                        <td>{trade.status}</td>
                        <td>{formatDate(trade.openedAt)}</td>
                        <td className={trade.realizedPnl >= 0 ? "positive-change" : "negative-change"}>
                          {formatCurrency(trade.realizedPnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}
