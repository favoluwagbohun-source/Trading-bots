import { useEffect, useState } from "react";

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

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        readonly initData: string;
        ready(): void;
        expand(): void;
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

export function PaperDashboard() {
  const [data, setData] = useState<PaperDashboardData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp?.initData) {
      setStatus("unavailable");
      return;
    }

    webApp.ready();
    webApp.expand();
    const controller = new AbortController();
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
  }, []);

  return (
    <section className="paper-dashboard" id="performance" aria-labelledby="performance-title">
      <div className="dashboard-heading">
        <div>
          <span className="eyebrow">YOUR ACCOUNT</span>
          <h2 id="performance-title">Paper performance</h2>
        </div>
        {data && (
          <span className={`paper-status ${data.settings.paperTradingEnabled ? "enabled" : ""}`}>
            {data.settings.paperTradingEnabled ? "Paper entries on" : "Paper entries off"}
          </span>
        )}
      </div>

      {status === "loading" && <p className="dashboard-message">Loading your secure account view…</p>}
      {status === "unavailable" && (
        <p className="dashboard-message">
          Account and trade information is only available when this page is opened as the Telegram Mini App.
        </p>
      )}
      {status === "error" && (
        <p className="dashboard-message dashboard-error" role="alert">
          {error ?? "Unable to load account performance."}
        </p>
      )}

      {data && (
        <>
          <div className="dashboard-metrics">
            <article className="dashboard-metric">
              <span>Starting balance</span>
              <strong>{formatCurrency(data.account.startingEquity)}</strong>
            </article>
            <article className="dashboard-metric">
              <span>Simulated equity</span>
              <strong>{formatCurrency(data.account.currentEquity)}</strong>
            </article>
            <article className="dashboard-metric">
              <span>Realized P&amp;L</span>
              <strong className={data.account.realizedPnl >= 0 ? "positive-change" : "negative-change"}>
                {formatCurrency(data.account.realizedPnl)}
              </strong>
            </article>
            <article className="dashboard-metric">
              <span>Active paper trades</span>
              <strong>{data.account.activeTradeCount}</strong>
            </article>
          </div>

          <div className="dashboard-columns">
            <section className="dashboard-panel" aria-labelledby="active-trades-title">
              <h3 id="active-trades-title">Active paper trades</h3>
              {data.activeTrades.length === 0
                ? <p className="dashboard-empty">No active trades.</p>
                : (
                  <div className="dashboard-table-wrap">
                    <table className="dashboard-table">
                      <thead>
                        <tr><th>Market</th><th>Side</th><th>Entry</th><th>Stop</th><th>Targets</th></tr>
                      </thead>
                      <tbody>
                        {data.activeTrades.map((trade) => (
                          <tr key={trade.signalId}>
                            <td>{trade.symbol}<small>{STRATEGY_LABELS[trade.strategy]}</small></td>
                            <td>{trade.side.toUpperCase()}</td>
                            <td>{formatCurrency(trade.entryPrice)}</td>
                            <td>{formatCurrency(trade.stopPrice)}</td>
                            <td>{formatCurrency(trade.target1)} / {formatCurrency(trade.target2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </section>

            <section className="dashboard-panel" aria-labelledby="strategy-performance-title">
              <h3 id="strategy-performance-title">Strategy performance</h3>
              <div className="dashboard-table-wrap">
                <table className="dashboard-table">
                  <thead>
                    <tr><th>Strategy</th><th>Closed</th><th>Win rate</th><th>Realized P&amp;L</th></tr>
                  </thead>
                  <tbody>
                    {data.strategyPerformance.map((strategy) => (
                      <tr key={strategy.strategy}>
                        <td>{STRATEGY_LABELS[strategy.strategy]}</td>
                        <td>{strategy.closedTrades}</td>
                        <td>{strategy.closedTrades
                          ? `${((strategy.wins / strategy.closedTrades) * 100).toFixed(0)}%`
                          : "—"}</td>
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

          <section className="dashboard-panel history-panel" aria-labelledby="signal-history-title">
            <h3 id="signal-history-title">Paper signal history</h3>
            {data.history.length === 0
              ? <p className="dashboard-empty">No paper signals recorded.</p>
              : (
                <div className="dashboard-table-wrap">
                  <table className="dashboard-table">
                    <thead>
                      <tr><th>Market</th><th>Strategy</th><th>Status</th><th>Opened</th><th>Realized P&amp;L</th></tr>
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
