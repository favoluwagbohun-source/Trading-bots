import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type ISeriesApi,
  type Time,
  type UTCTimestamp
} from "lightweight-charts";
import type { Candle } from "@crypto-signal/shared";
import type { ChartOverlayBundle } from "../chart-overlays.js";
import type { ChartTradeOverlay } from "../chart-state.js";

interface PriceLevel {
  readonly id: number;
  readonly price: number;
}

interface PriceZone {
  readonly id: number;
  readonly direction: "supply" | "demand";
  readonly low: number;
  readonly high: number;
}

interface TradePlan {
  readonly side: "long" | "short";
  readonly entry: number;
  readonly stop: number;
  readonly target1: number;
  readonly target2: number;
}

interface Trendline {
  readonly id: number;
  readonly startTime: number;
  readonly startPrice: number;
  readonly endTime: number;
  readonly endPrice: number;
}

interface MarketChartProps {
  readonly candles: readonly Candle[];
  readonly marketKey: string;
  readonly showTools?: boolean;
  readonly onCloseTools?: () => void;
  readonly dateControls?: ReactNode;
  readonly overlayBundle: ChartOverlayBundle;
  readonly activeTradeOverlay?: ChartTradeOverlay | null;
  readonly onClearTradeOverlay?: () => void;
}

function price(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function displayPrice(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8
  });
}

function candleTime(value: number): UTCTimestamp {
  return Math.floor(value / 1000) as UTCTimestamp;
}

export function MarketChart({
  candles,
  marketKey,
  showTools = false,
  onCloseTools,
  dateControls,
  overlayBundle,
  activeTradeOverlay = null,
  onClearTradeOverlay
}: MarketChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const manualLineRef = useRef<Array<ISeriesApi<"Line">>>([]);
  const autoLineRef = useRef<Array<ISeriesApi<"Line">>>([]);
  const priceLinesRef = useRef<Array<IPriceLine>>([]);
  const nextId = useRef(1);
  const fittedMarketKey = useRef("");
  const fittedLengthRef = useRef(0);
  const drawingRef = useRef(false);
  const anchorRef = useRef<{ time: number; price: number } | null>(null);
  const [trendlines, setTrendlines] = useState<Trendline[]>([]);
  const [drawingLine, setDrawingLine] = useState(false);
  const [levels, setLevels] = useState<PriceLevel[]>([]);
  const [zones, setZones] = useState<PriceZone[]>([]);
  const [levelInput, setLevelInput] = useState("");
  const [zoneLowInput, setZoneLowInput] = useState("");
  const [zoneHighInput, setZoneHighInput] = useState("");
  const [zoneDirection, setZoneDirection] = useState<PriceZone["direction"]>("demand");
  const [tradeSide, setTradeSide] = useState<TradePlan["side"]>("long");
  const [tradeInputs, setTradeInputs] = useState({ entry: "", stop: "", target1: "", target2: "" });
  const [tradePlan, setTradePlan] = useState<TradePlan | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [chartError, setChartError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      layout: {
        background: { color: "#0b0e11" },
        textColor: "#848e9c",
        fontFamily: "\"JetBrains Mono\", ui-monospace, monospace",
        attributionLogo: true
      },
      grid: {
        vertLines: { color: "#151a21" },
        horzLines: { color: "#151a21" }
      },
      crosshair: {
        mode: 0,
        vertLine: { color: "#75808c", width: 1, style: LineStyle.Dashed },
        horzLine: { color: "#75808c", width: 1, style: LineStyle.Dashed }
      },
      rightPriceScale: {
        borderColor: "#232a35",
        scaleMargins: { top: 0.08, bottom: 0.22 }
      },
      leftPriceScale: { visible: false },
      timeScale: {
        borderColor: "#232a35",
        timeVisible: true,
        secondsVisible: false
      },
      localization: {
        priceFormatter: displayPrice
      },
      handleScroll: true,
      handleScale: true
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#0ECB81",
      downColor: "#F6465D",
      borderUpColor: "#0ECB81",
      borderDownColor: "#F6465D",
      wickUpColor: "#0ECB81",
      wickDownColor: "#F6465D",
      priceLineVisible: false,
      lastValueVisible: true
    });
    const volumePane = chart.addPane();
    volumePane.setHeight(82);
    const volumeSeries = volumePane.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false
    });
    const markersPlugin = createSeriesMarkers(candleSeries, []);
    chartRef.current = chart;
    candlesRef.current = candleSeries;
    markersRef.current = markersPlugin;
    volumeRef.current = volumeSeries;

    const updateSize = () => {
      chart.applyOptions({ width: host.clientWidth, height: host.clientHeight });
      setLayoutVersion((version) => version + 1);
    };
    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(host);
    chart.timeScale().subscribeVisibleLogicalRangeChange(updateSize);

    const onChartClick = (event: MouseEventParams) => {
      if (!drawingRef.current || event.point === undefined || typeof event.time !== "number") {
        return;
      }
      const selectedPrice = candleSeries.coordinateToPrice(event.point.y);
      if (selectedPrice === null || !Number.isFinite(selectedPrice)) return;
      const selected = { time: event.time, price: selectedPrice };
      const anchor = anchorRef.current;
      if (!anchor) {
        anchorRef.current = selected;
        setChartError("Tap a second candle to finish the trendline.");
        return;
      }
      anchorRef.current = null;
      drawingRef.current = false;
      setDrawingLine(false);
      setChartError(null);
      if (anchor.time === selected.time) {
        setChartError("Choose two different candle times for a trendline.");
        return;
      }
      const [start, end] = anchor.time < selected.time
        ? [anchor, selected]
        : [selected, anchor];
      setTrendlines((items) => [
        ...items,
        {
          id: nextId.current++,
          startTime: start.time,
          startPrice: start.price,
          endTime: end.time,
          endPrice: end.price
        }
      ]);
    };
    chart.subscribeClick(onChartClick);

    return () => {
      resizeObserver.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(updateSize);
      chart.unsubscribeClick(onChartClick);
      markersPlugin.detach();
      chart.remove();
      chartRef.current = null;
      candlesRef.current = null;
      markersRef.current = null;
      volumeRef.current = null;
      manualLineRef.current = [];
      autoLineRef.current = [];
      priceLinesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const candleSeries = candlesRef.current;
    const volumeSeries = volumeRef.current;
    if (!candleSeries || !volumeSeries) return;
    candleSeries.setData(candles.map((item) => ({
      time: candleTime(item.openTime),
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close)
    })));
    volumeSeries.setData(candles.map((item) => ({
      time: candleTime(item.openTime),
      value: Number(item.volume),
      color: Number(item.close) >= Number(item.open)
        ? "rgba(14, 203, 129, 0.34)"
        : "rgba(246, 70, 93, 0.34)"
    })));
    const previousLength = fittedLengthRef.current;
    if (
      candles.length > 0 &&
      (fittedMarketKey.current !== marketKey ||
        (previousLength <= 5 && candles.length > 10) ||
        !chartRef.current?.timeScale().getVisibleLogicalRange())
    ) {
      chartRef.current?.timeScale().fitContent();
    }
    setLayoutVersion((version) => version + 1);
    fittedLengthRef.current = candles.length;
    if (candles.length > 0) fittedMarketKey.current = marketKey;
  }, [candles, marketKey]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = candlesRef.current;
    if (!chart || !series) return;
    for (const line of manualLineRef.current) chart.removeSeries(line);
    manualLineRef.current = trendlines.map((trendline) => {
      const line = chart.addSeries(LineSeries, {
        color: "#cbd5e1",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false
      });
      const latestTime = candles.at(-1)?.openTime;
      const rayEndTime = latestTime === undefined
        ? trendline.endTime
        : Math.max(trendline.endTime, Math.floor(latestTime / 1000));
      const projectedPrice = trendline.startPrice +
        (trendline.endPrice - trendline.startPrice) *
        ((rayEndTime - trendline.startTime) / (trendline.endTime - trendline.startTime));
      line.setData([
        { time: trendline.startTime as UTCTimestamp, value: trendline.startPrice },
        { time: trendline.endTime as UTCTimestamp, value: trendline.endPrice },
        ...(rayEndTime > trendline.endTime
          ? [{ time: rayEndTime as UTCTimestamp, value: projectedPrice }]
          : [])
      ]);
      return line;
    });
    setLayoutVersion((version) => version + 1);
  }, [candles, trendlines]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = candlesRef.current;
    if (!chart || !series) return;
    for (const line of autoLineRef.current) chart.removeSeries(line);
    if (candles.length === 0 || overlayBundle.trendlines.length === 0) {
      autoLineRef.current = [];
      return;
    }

    const firstSec = Math.floor(candles[0]!.openTime / 1000);
    const lastSec = Math.floor(candles.at(-1)!.openTime / 1000);
    const created: Array<ISeriesApi<"Line">> = [];

    for (const item of overlayBundle.trendlines) {
      const startSec = Math.floor(item.anchorA.openTime / 1000);
      const endSec = Math.floor(item.anchorB.openTime / 1000);
      if (endSec <= startSec) continue;
      const clippedStart = Math.max(startSec, firstSec);
      const clippedEnd = Math.max(endSec, lastSec);
      if (clippedEnd <= clippedStart) continue;

      const interpolate = (tSec: number) =>
        item.anchorA.price +
        ((item.anchorB.price - item.anchorA.price) * (tSec - startSec)) / (endSec - startSec);

      const points: { time: UTCTimestamp; value: number }[] = [
        { time: clippedStart as UTCTimestamp, value: interpolate(clippedStart) }
      ];
      if (endSec > clippedStart && endSec < clippedEnd) {
        points.push({ time: endSec as UTCTimestamp, value: item.anchorB.price });
      }
      points.push({ time: clippedEnd as UTCTimestamp, value: interpolate(clippedEnd) });

      const line = chart.addSeries(LineSeries, {
        color: item.color,
        lineWidth: item.lineWidth,
        lineStyle: item.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: () => null
      });
      line.setData(points);
      created.push(line);
    }
    autoLineRef.current = created;
  }, [candles, overlayBundle.trendlines]);

  useEffect(() => {
    const markersPlugin = markersRef.current;
    if (!markersPlugin) return;
    if (candles.length === 0) {
      markersPlugin.setMarkers([]);
      return;
    }
    markersPlugin.setMarkers([...overlayBundle.markers]);
  }, [candles.length, overlayBundle.markers]);

  useEffect(() => {
    const series = candlesRef.current;
    if (!series) return;
    for (const line of priceLinesRef.current) series.removePriceLine(line);
    const lines: IPriceLine[] = levels.map((level) =>
      series.createPriceLine({
        price: level.price,
        color: "#f0b90b",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `Level ${displayPrice(level.price)}`
      })
    );

    for (const lvl of overlayBundle.levels) {
      lines.push(
        series.createPriceLine({
          price: lvl.price,
          color: lvl.color,
          lineWidth: 1,
          lineStyle: lvl.dashed ? LineStyle.Dotted : LineStyle.Solid,
          axisLabelVisible: true,
          title: lvl.label
        })
      );
    }

    const activePlan = activeTradeOverlay
      ? {
          side: activeTradeOverlay.side,
          entry: activeTradeOverlay.entryPrice,
          stop: activeTradeOverlay.stopPrice,
          target1: activeTradeOverlay.target1,
          target2: activeTradeOverlay.target2
        }
      : tradePlan;

    if (activePlan) {
      const risk = Math.abs(activePlan.entry - activePlan.stop);
      const target1R = risk > 0 ? Math.abs(activePlan.target1 - activePlan.entry) / risk : 0;
      const target2R = risk > 0 ? Math.abs(activePlan.target2 - activePlan.entry) / risk : 0;
      lines.push(
        series.createPriceLine({
          price: activePlan.entry,
          color: "#f0b90b",
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `Entry ${displayPrice(activePlan.entry)}`
        }),
        series.createPriceLine({
          price: activePlan.stop,
          color: "#F6465D",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `Stop ${displayPrice(activePlan.stop)}`
        }),
        series.createPriceLine({
          price: activePlan.target1,
          color: "#3d9bff",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `TP1 · ${target1R.toFixed(1)}R`
        }),
        series.createPriceLine({
          price: activePlan.target2,
          color: "#0ecb81",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `TP2 · ${target2R.toFixed(1)}R`
        })
      );
    }
    priceLinesRef.current = lines;
  }, [activeTradeOverlay, levels, overlayBundle.levels, tradePlan]);

  const zoneBoxes = zones.map((zone) => {
    const chart = chartRef.current;
    const series = candlesRef.current;
    if (!chart || !series || candles.length === 0) return null;
    const top = series.priceToCoordinate(zone.high);
    const bottom = series.priceToCoordinate(zone.low);
    const startX = chart.timeScale().timeToCoordinate(candleTime(candles[0]!.openTime));
    if (top === null || bottom === null) return null;
    const left = Math.max(0, startX ?? 0);
    const right = hostRef.current?.clientWidth ?? 0;
    return (
      <div
        className={`chart-zone chart-zone-${zone.direction}`}
        key={zone.id}
        style={{
          left,
          top: Math.min(top, bottom),
          width: Math.max(0, right - left),
          height: Math.abs(bottom - top)
        }}
      />
    );
  });

  const autoZoneBoxes = overlayBundle.zones.map((zone) => {
    const chart = chartRef.current;
    const series = candlesRef.current;
    if (!chart || !series || candles.length === 0) return null;
    const top = series.priceToCoordinate(zone.high);
    const bottom = series.priceToCoordinate(zone.low);
    const startX = chart.timeScale().timeToCoordinate(candleTime(zone.startTime));
    if (top === null || bottom === null) return null;
    const left = Math.max(0, startX ?? 0);
    const right = Math.max(left, (hostRef.current?.clientWidth ?? 0) - 92);
    return (
      <div
        className={`chart-zone chart-zone-${zone.direction} chart-zone-auto`}
        key={zone.id}
        style={{
          left,
          top: Math.min(top, bottom),
          width: Math.max(0, right - left),
          height: Math.max(6, Math.abs(bottom - top))
        }}
      >
        <span className="chart-zone-tag">{zone.label}</span>
      </div>
    );
  });

  const touchDotNodes = overlayBundle.touchDots.map((dot) => {
    const chart = chartRef.current;
    const series = candlesRef.current;
    if (!chart || !series) return null;
    const x = chart.timeScale().timeToCoordinate(candleTime(dot.openTime));
    const y = series.priceToCoordinate(dot.price);
    if (x === null || y === null) return null;
    return (
      <div
        className="chart-touch-dot"
        key={dot.id}
        style={{
          left: x,
          top: y,
          borderColor: dot.color
        }}
      />
    );
  });

  function addLevel(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const value = price(levelInput);
    if (value === undefined) {
      setChartError("Enter a positive price for the horizontal level.");
      return;
    }
    if (levels.length >= 3) {
      setChartError("The chart supports at most three manual horizontal levels.");
      return;
    }
    setLevels((items) => [...items, { id: nextId.current++, price: value }]);
    setLevelInput("");
    setChartError(null);
  }

  function addZone(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const low = price(zoneLowInput);
    const high = price(zoneHighInput);
    if (low === undefined || high === undefined || low >= high) {
      setChartError("Enter a valid zone with a low price below its high price.");
      return;
    }
    if (zones.length >= 2) {
      setChartError("The chart supports at most two supply/demand zones.");
      return;
    }
    setZones((items) => [
      ...items,
      { id: nextId.current++, direction: zoneDirection, low, high }
    ]);
    setZoneLowInput("");
    setZoneHighInput("");
    setChartError(null);
  }

  function applyTradePlan(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const entry = price(tradeInputs.entry);
    const stop = price(tradeInputs.stop);
    const target1 = price(tradeInputs.target1);
    const target2 = price(tradeInputs.target2);
    if (entry === undefined || stop === undefined || target1 === undefined || target2 === undefined) {
      setChartError("Enter positive entry, stop, TP1, and TP2 prices.");
      return;
    }
    const correctlyOrdered = tradeSide === "long"
      ? stop < entry && entry < target1 && target1 < target2
      : stop > entry && entry > target1 && target1 > target2;
    if (!correctlyOrdered) {
      setChartError("Trade prices must follow the selected direction and target order.");
      return;
    }
    setTradePlan({ side: tradeSide, entry, stop, target1, target2 });
    setChartError(null);
  }

  function toggleTrendlineDrawing(): void {
    if (trendlines.length >= 4 && !drawingLine) {
      setChartError("The chart supports at most four manual trendlines.");
      return;
    }
    const next = !drawingLine;
    drawingRef.current = next;
    anchorRef.current = null;
    setDrawingLine(next);
    setChartError(next ? "Tap two candles on the chart to draw a trendline ray." : null);
  }

  const toolsPanel = (
    <div className="chart-tools-panel">
      <div className="tools-sheet-header">
        <span>Drawing Tools &amp; Date Range</span>
        {onCloseTools && (
          <button type="button" className="quiet-button" onClick={onCloseTools}>
            Done
          </button>
        )}
      </div>
      <div className="chart-toolbar">
        <div className="chart-tools">
          <button
            type="button"
            className={drawingLine ? "tool-button active" : "tool-button"}
            onClick={toggleTrendlineDrawing}
            disabled={candles.length === 0}
          >
            {drawingLine ? "Cancel trendline" : "＋ Trendline"}
          </button>
          <form className="compact-form" onSubmit={addLevel}>
            <input
              aria-label="Horizontal level price"
              inputMode="decimal"
              placeholder="Level price"
              value={levelInput}
              onChange={(event) => setLevelInput(event.target.value)}
            />
            <button type="submit" disabled={levels.length >= 3}>＋ Level</button>
          </form>
          {levels.map((level) => (
            <button
              type="button"
              className="overlay-chip"
              key={level.id}
              onClick={() => setLevels((items) => items.filter((item) => item.id !== level.id))}
              title="Remove horizontal level"
            >
              Level {displayPrice(level.price)} ×
            </button>
          ))}
          {trendlines.map((line) => (
            <button
              type="button"
              className="overlay-chip"
              key={line.id}
              onClick={() => setTrendlines((items) => items.filter((item) => item.id !== line.id))}
              title="Remove trendline"
            >
              Trendline ×
            </button>
          ))}
        </div>
        <div className="chart-tools">
          <form className="compact-form" onSubmit={addZone}>
            <select
              aria-label="Zone direction"
              value={zoneDirection}
              onChange={(event) =>
                setZoneDirection(event.target.value === "supply" ? "supply" : "demand")
              }
            >
              <option value="demand">Demand</option>
              <option value="supply">Supply</option>
            </select>
            <input
              aria-label="Zone low price"
              inputMode="decimal"
              placeholder="Low"
              value={zoneLowInput}
              onChange={(event) => setZoneLowInput(event.target.value)}
            />
            <input
              aria-label="Zone high price"
              inputMode="decimal"
              placeholder="High"
              value={zoneHighInput}
              onChange={(event) => setZoneHighInput(event.target.value)}
            />
            <button type="submit" disabled={zones.length >= 2}>＋ Zone</button>
          </form>
          {zones.map((zone) => (
            <button
              type="button"
              className="overlay-chip"
              key={zone.id}
              onClick={() => setZones((items) => items.filter((item) => item.id !== zone.id))}
              title="Remove supply/demand zone"
            >
              {zone.direction} {displayPrice(zone.low)}–{displayPrice(zone.high)} ×
            </button>
          ))}
        </div>
      </div>
      <form className="trade-plan-form" onSubmit={applyTradePlan}>
        <label>
          Direction
          <select value={tradeSide} onChange={(event) =>
            setTradeSide(event.target.value === "short" ? "short" : "long")
          }>
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
        </label>
        {(["entry", "stop", "target1", "target2"] as const).map((field) => (
          <label key={field}>
            {field === "entry"
              ? "Entry"
              : field === "stop"
                ? "Stop"
                : field === "target1"
                  ? "TP1"
                  : "TP2"}
            <input
              inputMode="decimal"
              placeholder="Price"
              value={tradeInputs[field]}
              onChange={(event) => setTradeInputs((values) => ({
                ...values,
                [field]: event.target.value
              }))}
            />
          </label>
        ))}
        <button type="submit">Plot trade levels</button>
        {tradePlan && (
          <button
            type="button"
            className="quiet-button"
            onClick={() => setTradePlan(null)}
          >
            Clear trade
          </button>
        )}
      </form>
      {dateControls}
    </div>
  );

  return (
    <section className="chart-card" aria-label="Market chart">
      {showTools && (
        <>
          <div className="tools-backdrop" onClick={onCloseTools} aria-hidden="true" />
          <div className="chart-tools-drawer">
            <div className="sheet-grab-handle" aria-hidden="true" />
            {toolsPanel}
          </div>
        </>
      )}

      {activeTradeOverlay && (
        <div className="plotted-overlay-strip">
          <span>
            {activeTradeOverlay.label} · {activeTradeOverlay.side === "long" ? "Long" : "Short"} · Entry{" "}
            {displayPrice(activeTradeOverlay.entryPrice)} · Stop {displayPrice(activeTradeOverlay.stopPrice)}
          </span>
          {onClearTradeOverlay && (
            <button type="button" className="quiet-button" onClick={onClearTradeOverlay}>
              Clear overlay
            </button>
          )}
        </div>
      )}

      {chartError && <p className="chart-message" role="status">{chartError}</p>}

      <div className="chart-viewport">
        {overlayBundle.legend && (
          <div className="chart-ta-legend" aria-label="Technical analysis legend">
            <span className="chart-ta-legend-title">{overlayBundle.legend}</span>
            {overlayBundle.legendItems.length > 0 && (
              <span className="chart-ta-legend-items">
                {overlayBundle.legendItems.map((item) => (
                  <span className="chart-ta-legend-chip" key={item.label}>
                    <span className="chart-ta-swatch" style={{ background: item.color }} aria-hidden="true" />
                    {item.label}
                  </span>
                ))}
              </span>
            )}
          </div>
        )}
        <div ref={hostRef} className="chart-host" />
        <div className="chart-zone-layer" aria-hidden="true" key={layoutVersion}>
          {zoneBoxes}
          {autoZoneBoxes}
          {touchDotNodes}
        </div>
        {candles.length === 0 && (
          <div className="chart-empty">
            <strong>Loading Binance candles</strong>
            <span>Connecting to live market data stream…</span>
          </div>
        )}
      </div>
    </section>
  );
}
