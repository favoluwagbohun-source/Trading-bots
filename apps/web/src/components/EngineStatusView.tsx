import { formatHealthLabel, formatRelativeTime } from "../chart-state.js";
import type { PlatformHealthBundle } from "../market-api.js";

interface EngineStatusViewProps {
  readonly health: PlatformHealthBundle | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRefresh: () => void;
  readonly onSelectSymbol: (symbol: string) => void;
}

const BOT_COMMANDS = [
  { command: "/start", description: "Initialize your simulated paper account and open Mini App" },
  { command: "/account", description: "Set or view your starting paper account size (USD)" },
  { command: "/balance", description: "Check current simulated equity and 1% fixed risk budget" },
  { command: "/paper on|off", description: "Enable or disable automatic paper trade entries" },
  { command: "/signals", description: "List active open paper setups with entry and stops" },
  { command: "/performance", description: "View completed trades, win rate, and realized P&L" },
  { command: "/strategies", description: "Review the four independent deterministic strategies" },
  { command: "/settings", description: "Enable or disable specific strategies for your chat" },
  { command: "/pause · /resume", description: "Pause or resume Telegram alert delivery" }
] as const;

function healthTone(state: PlatformHealthBundle["overall"]["state"]): string {
  if (state === "HEALTHY") return "tone-bullish";
  if (state === "DEGRADED" || state === "DISCONNECTED") return "tone-bearish";
  return "tone-caution";
}

export function EngineStatusView({
  health,
  loading,
  error,
  onRefresh,
  onSelectSymbol
}: EngineStatusViewProps) {
  return (
    <section className="workspace-scroll-page" aria-label="Engine and Telegram bot status">
      <div className="section-header-row">
        <div>
          <h2 className="section-title">Engine &amp; Telegram Bot Status</h2>
          <p className="section-subtitle">
            Live Binance data feed, 5-minute signal scanner, and Telegram bot health
          </p>
        </div>
        <button type="button" className="quiet-button" onClick={onRefresh}>
          {loading ? "Refreshing…" : "Refresh Status"}
        </button>
      </div>

      {error && (
        <p className="inline-alert" role="alert">
          {error}
        </p>
      )}

      {health && (
        <>
          <div className="kpi-grid-4">
            <article className="surface-card kpi-card">
              <span className="kpi-label">Worker State</span>
              <strong className={healthTone(health.overall.workerState)}>
                {formatHealthLabel(health.overall.workerState)}
              </strong>
              <span className="muted-meta">
                Host: {health.overall.hostingEnvironment}
              </span>
            </article>
            <article className="surface-card kpi-card">
              <span className="kpi-label">Binance Feed</span>
              <strong className={healthTone(health.marketData.state)}>
                {formatHealthLabel(health.marketData.state)}
              </strong>
              <span className="muted-meta">
                Updated {formatRelativeTime(health.marketData.lastSuccessfulUpdateAt)}
              </span>
            </article>
            <article className="surface-card kpi-card">
              <span className="kpi-label">Signal Scanner</span>
              <strong className={healthTone(health.signalEngine.state)}>
                {formatHealthLabel(health.signalEngine.state)}
              </strong>
              <span className="muted-meta">
                {health.signalEngine.activePaperTradeCount} active paper trades
              </span>
            </article>
            <article className="surface-card kpi-card">
              <span className="kpi-label">Telegram Bot</span>
              <strong className={healthTone(health.telegram.state)}>
                {formatHealthLabel(health.telegram.state)}
              </strong>
              <span className="muted-meta">
                {health.telegram.configured
                  ? `Poll ${formatRelativeTime(health.telegram.lastPollAt)}`
                  : "Token not configured"}
              </span>
            </article>
          </div>

          <div className="cards-grid-2">
            <article className="surface-card">
              <div className="card-top-line">
                <h3 className="card-title">Monitored Watchlist</h3>
                <span className="muted-meta">
                  Every {Math.round(health.signalEngine.scanIntervalMs / 1000)}s
                </span>
              </div>
              {health.signalEngine.watchlist.length === 0 ? (
                <p className="muted-copy">No worker watchlist heartbeat recorded yet.</p>
              ) : (
                <div className="watchlist-buttons">
                  {health.signalEngine.watchlist.map((item) => {
                    const lastBar = health.signalEngine.lastProcessedOpenTimeBySymbol[item];
                    return (
                      <button
                        key={item}
                        type="button"
                        className="watchlist-row-button"
                        onClick={() => onSelectSymbol(item)}
                      >
                        <strong className="mono-label">{item}</strong>
                        <span className="muted-meta">
                          Last 5m candle: {lastBar ? formatRelativeTime(lastBar) : "Pending"} · Open Chart
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </article>

            <article className="surface-card">
              <div className="card-top-line">
                <h3 className="card-title">Telegram Bot Commands</h3>
                <span className="muted-meta">Paper trading only</span>
              </div>
              <div className="command-list">
                {BOT_COMMANDS.map((entry) => (
                  <div key={entry.command} className="command-row">
                    <code className="mono-label command-name">{entry.command}</code>
                    <span className="muted-copy">{entry.description}</span>
                  </div>
                ))}
              </div>
            </article>
          </div>
        </>
      )}
    </section>
  );
}
