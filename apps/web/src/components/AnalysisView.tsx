import {
  STRATEGY_META,
  formatPrice,
  formatTimeframeMatrixLabel,
  summarizeTopDownAlignment,
  type ChartTradeOverlay
} from "../chart-state.js";
import type { MarketAnalysisData } from "../market-api.js";

interface AnalysisViewProps {
  readonly symbol: string;
  readonly analysis: MarketAnalysisData | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly compact?: boolean;
  readonly onRefresh: () => void;
  readonly onPlotTrade: (overlay: ChartTradeOverlay) => void;
  readonly onOpenChartWithAutoLines: () => void;
}

function regimeClass(regime: "bullish" | "bearish" | "neutral"): string {
  if (regime === "bullish") return "tone-bullish";
  if (regime === "bearish") return "tone-bearish";
  return "tone-neutral";
}

function regimeLabel(regime: "bullish" | "bearish" | "neutral"): string {
  if (regime === "bullish") return "Bullish";
  if (regime === "bearish") return "Bearish";
  return "Ranging";
}

export function AnalysisView({
  symbol,
  analysis,
  loading,
  error,
  compact = false,
  onRefresh,
  onPlotTrade,
  onOpenChartWithAutoLines
}: AnalysisViewProps) {
  const alignment = analysis ? summarizeTopDownAlignment(analysis.timeframes) : null;

  return (
    <section
      className={compact ? "analysis-panel analysis-compact" : "workspace-scroll-page"}
      aria-label="Multi-timeframe market analysis"
    >
      <div className="section-header-row">
        <div>
          <h2 className="section-title">
            {compact ? "Top-Down Engine" : `${symbol} Top-Down Market Analysis`}
          </h2>
          <p className="section-subtitle">
            {alignment
              ? alignment.dominantRegime === "mixed"
                ? `${alignment.bullishCount} bullish · ${alignment.bearishCount} bearish across ${alignment.totalAvailable} timeframes`
                : `${alignment.alignedCount}/${alignment.totalAvailable} timeframes lean ${regimeLabel(alignment.dominantRegime).toLowerCase()}`
              : "Synchronized 1M → 1W → 1D → 4H → 1H → 5M structure & 4-strategy evaluation"}
          </p>
        </div>
        <div className="section-actions">
          <button type="button" className="quiet-button" onClick={onRefresh}>
            {loading ? "Syncing…" : "Refresh"}
          </button>
          {!compact && (
            <button
              type="button"
              className="primary-cta"
              onClick={onOpenChartWithAutoLines}
            >
              Show 4H Lines on Chart
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="inline-alert" role="alert">
          {error}
        </p>
      )}

      {!analysis && loading && (
        <div className="empty-state-panel">
          <p>Evaluating multi-timeframe Binance candles for {symbol}…</p>
        </div>
      )}

      {analysis && (
        <>
          {analysis.candidates.length > 0 && (
            <div className="confirmed-signals-block">
              <div className="subblock-header">
                <h3>Confirmed Active Setups</h3>
                <span className="muted-meta">{analysis.candidates.length} ready</span>
              </div>
              <div className={compact ? "stacked-list" : "cards-grid-2"}>
                {analysis.candidates.map((candidate) => (
                  <article key={candidate.signalId} className="surface-card">
                    <div className="card-top-line">
                      <strong className="card-title">
                        {STRATEGY_META[candidate.strategy].name}
                        {candidate.mode ? ` (${candidate.mode})` : ""}
                      </strong>
                      <span className={candidate.side === "buy" ? "tone-bullish" : "tone-bearish"}>
                        {candidate.side === "buy" ? "Long Setup" : "Short Setup"}
                      </span>
                    </div>
                    <div className="metric-strip-inline">
                      <span>Entry {formatPrice(candidate.entryPrice)}</span>
                      <span>Stop {formatPrice(candidate.stopLoss)}</span>
                      <span>TP1 {formatPrice(candidate.target1)}</span>
                      <span>TP2 {formatPrice(candidate.target2)}</span>
                    </div>
                    <div className="card-footer-row">
                      <span className="muted-meta">
                        Min {candidate.minimumRiskReward}R
                        {candidate.higherTimeframeBias &&
                          candidate.higherTimeframeBias !== "not applicable"
                          ? ` · ${candidate.higherTimeframeBias}`
                          : ""}
                      </span>
                      <button
                        type="button"
                        className="primary-cta"
                        onClick={() =>
                          onPlotTrade({
                            label: `${symbol} · ${STRATEGY_META[candidate.strategy].name}`,
                            symbol,
                            side: candidate.side === "buy" ? "long" : "short",
                            entryPrice: candidate.entryPrice,
                            stopPrice: candidate.stopLoss,
                            target1: candidate.target1,
                            target2: candidate.target2
                          })
                        }
                      >
                        Plot on Chart
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}

          <div className="subblock">
            <div className="subblock-header">
              <h3>Timeframe Alignment</h3>
              <span className="muted-meta">1M → 5M</span>
            </div>
            <div className={compact ? "tf-matrix-compact" : "tf-matrix-grid"}>
              {analysis.timeframes.map((tf) => (
                <div key={tf.timeframe} className="tf-matrix-row">
                  <div className="tf-matrix-left">
                    <strong className="mono-label">
                      {formatTimeframeMatrixLabel(tf.timeframe)}
                    </strong>
                    <span className={regimeClass(tf.regime)}>
                      {tf.availableAt === null ? "No data" : regimeLabel(tf.regime)}
                    </span>
                  </div>
                  <div className="tf-matrix-right">
                    <span className="muted-meta">
                      Vol: {tf.volatilityRegime}
                    </span>
                    {!compact && (
                      <span className="mono-meta">
                        SH {formatPrice(tf.latestHigh)} · SL {formatPrice(tf.latestLow)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {!compact && (
            <div className="cards-grid-2">
              <div className="surface-card">
                <div className="card-top-line">
                  <h3 className="card-title">4H Confirmed Trendlines</h3>
                  <span className="muted-meta">{analysis.fourHourTrendlines.length} tracked</span>
                </div>
                {analysis.fourHourTrendlines.length === 0 ? (
                  <p className="muted-copy">
                    No 3-touch confirmed 4-hour trendlines are active in the current 200-bar window.
                  </p>
                ) : (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Direction</th>
                          <th>Status</th>
                          <th>Touches</th>
                          <th>Projected</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analysis.fourHourTrendlines.map((line) => (
                          <tr key={line.id}>
                            <td>{line.direction === "ascending" ? "Ascending" : "Descending"}</td>
                            <td className={line.status === "valid" ? "tone-bullish" : "tone-neutral"}>
                              {line.status === "valid"
                                ? "Valid"
                                : line.breakStatus === "broken_above"
                                  ? "Broken Above"
                                  : line.breakStatus === "broken_below"
                                    ? "Broken Below"
                                    : "Unbroken"}
                            </td>
                            <td>{line.qualifyingTouchCount}</td>
                            <td>
                              {formatPrice(
                                Number(
                                  line.projectedPrice.toFixed(
                                    Math.abs(line.projectedPrice) >= 100 ? 2 : 4
                                  )
                                )
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="surface-card">
                <div className="card-top-line">
                  <h3 className="card-title">Key Swing Structure (4H &amp; 1H)</h3>
                  <span className="muted-meta">{analysis.swingLevels.length} levels</span>
                </div>
                {analysis.swingLevels.length === 0 ? (
                  <p className="muted-copy">No confirmed 4H or 1H swing levels available yet.</p>
                ) : (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>TF</th>
                          <th>Type</th>
                          <th>Price</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analysis.swingLevels.map((swing) => (
                          <tr key={swing.id}>
                            <td>{swing.timeframe.toUpperCase()}</td>
                            <td className={swing.direction === "high" ? "tone-bearish" : "tone-bullish"}>
                              {swing.direction === "high" ? "Swing High" : "Swing Low"}
                            </td>
                            <td>{formatPrice(swing.price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="subblock">
            <div className="subblock-header">
              <h3>Strategy Engine Evaluations</h3>
              <span className="muted-meta">{analysis.evaluations.length} checks</span>
            </div>
            <div className={compact ? "stacked-list" : "cards-grid-2"}>
              {analysis.evaluations.map((evaluation, index) => {
                const meta = STRATEGY_META[evaluation.strategy];
                const confirmed = evaluation.status === "setup_confirmed";
                return (
                  <article
                    key={`${evaluation.strategy}-${evaluation.variation ?? index}`}
                    className="surface-card"
                  >
                    <div className="card-top-line">
                      <strong className="card-title">
                        {meta.name}
                        {evaluation.variation ? ` · ${evaluation.variation}` : ""}
                      </strong>
                      <span className={confirmed ? "tone-bullish" : "muted-meta"}>
                        {confirmed ? "Confirmed" : "Monitoring"}
                      </span>
                    </div>
                    <p className="evaluation-reason">{evaluation.reason}</p>
                    {!compact && (
                      <div className="evaluation-details">
                        <div>
                          <span className="detail-label">Entry rule</span>
                          <span>{evaluation.entryCondition}</span>
                        </div>
                        <div>
                          <span className="detail-label">Stop rule</span>
                          <span>{evaluation.stopMethodology}</span>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </div>

          {analysis.warnings.length > 0 && (
            <p className="muted-copy">{analysis.warnings.join(" · ")}</p>
          )}
        </>
      )}
    </section>
  );
}
