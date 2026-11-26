import { Resvg } from "@resvg/resvg-js";
import type { Candle } from "@crypto-signal/shared";
import type { SignalChart } from "./market-analysis.js";

const WIDTH = 1280;
const HEIGHT = 760;
const PLOT = { left: 92, right: 1165, top: 78, bottom: 650 };
const MAX_CANDLES = 120;
const COLORS = {
  background: "#0b1220",
  panel: "#111b2d",
  grid: "#273449",
  text: "#e5edf8",
  muted: "#9bacbf",
  up: "#22c55e",
  down: "#ef4444",
  entry: "#38bdf8",
  stop: "#fb7185",
  target: "#fbbf24",
  trendline: "#c084fc",
  level: "#2dd4bf",
  zone: "#a78bfa"
} as const;

export interface RenderedSignalChart {
  readonly snapshotId: string;
  readonly image: Blob;
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "\"": "&quot;",
    "'": "&apos;"
  })[character]!);
}

function assertPositivePrice(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite price`);
  }
}

function svgLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width = 2,
  dash?: string
): string {
  return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
}

function candlePrice(candle: Candle, field: "open" | "high" | "low" | "close"): number {
  const value = Number(candle[field]);
  assertPositivePrice(value, `Candle ${field}`);
  return value;
}

export function renderSignalChart(candidate: SignalChart): RenderedSignalChart {
  if (!candidate.snapshotId.trim() || !candidate.symbol.trim()) {
    throw new Error("Signal chart requires a snapshot ID and symbol");
  }
  if (candidate.chartCandles.length === 0) {
    throw new Error("Signal chart requires actual market candles");
  }
  if (!candidate.chartCandles.every((candle) => candle.closed)) {
    throw new Error("Signal chart cannot include unfinished candles");
  }
  if (candidate.analysisSnapshot) {
    const snapshot = candidate.analysisSnapshot;
    if (
      candidate.snapshotId !== snapshot.snapshotId ||
      candidate.symbol !== snapshot.symbol ||
      candidate.signalCandle !== snapshot.signalCandle ||
      candidate.chartCandles !== snapshot.timeframes["5m"].candles
    ) {
      throw new Error("Signal chart must consume its exact immutable analysis snapshot");
    }
  }

  const candles = candidate.chartCandles.slice(-MAX_CANDLES);
  const last = candles.at(-1)!;
  if (last.openTime !== candidate.signalCandle.openTime) {
    throw new Error("Chart candles and signal must use the same market snapshot");
  }

  for (const [label, price] of Object.entries({
    entry: candidate.entryPrice,
    stop: candidate.stopLoss,
    target1: candidate.target1,
    target2: candidate.target2
  })) {
    assertPositivePrice(price, label);
  }

  const startTime = candles[0]!.openTime;
  const endTime = last.closeTime;
  if (endTime <= startTime) throw new Error("Signal chart candle times are invalid");
  const xForTime = (time: number): number =>
    PLOT.left + (time - startTime) / (endTime - startTime) * (PLOT.right - PLOT.left);
  const candleGap = (PLOT.right - PLOT.left) / candles.length;
  const trendline = candidate.chartAnnotations.trendline;
  const trendlineSlope = trendline
    ? (trendline.anchorB.price - trendline.anchorA.price) /
      (trendline.anchorB.openTime - trendline.anchorA.openTime)
    : undefined;
  const priceValues = candles.flatMap((candle) => [
    candlePrice(candle, "high"),
    candlePrice(candle, "low")
  ]);
  priceValues.push(
    candidate.entryPrice,
    candidate.stopLoss,
    candidate.target1,
    candidate.target2
  );
  for (const level of candidate.chartAnnotations.levels) {
    assertPositivePrice(level.price, "Chart level");
    priceValues.push(level.price);
  }
  for (const zone of candidate.chartAnnotations.zones) {
    assertPositivePrice(zone.low, "Zone low");
    assertPositivePrice(zone.high, "Zone high");
    if (zone.high <= zone.low) throw new Error("Chart zone high must exceed its low");
    priceValues.push(zone.low, zone.high);
  }
  for (const line of [
    candidate.chartAnnotations.actionLine,
    candidate.chartAnnotations.safetyLine
  ]) {
    if (!line) continue;
    if (line.anchorA.openTime >= line.anchorB.openTime) {
      throw new Error(`${line.id} anchors must have increasing timestamps`);
    }
    const slope =
      (line.anchorB.price - line.anchorA.price) /
      (line.anchorB.openTime - line.anchorA.openTime);
    const startPrice = line.anchorA.price + slope * (startTime - line.anchorA.openTime);
    const endPrice = line.anchorA.price + slope * (endTime - line.anchorA.openTime);
    assertPositivePrice(line.anchorA.price, `${line.id} Point A`);
    assertPositivePrice(line.anchorB.price, `${line.id} Point B`);
    assertPositivePrice(line.projectedPrice, `${line.id} projection`);
    assertPositivePrice(startPrice, `${line.id} chart start`);
    assertPositivePrice(endPrice, `${line.id} chart end`);
    priceValues.push(
      line.anchorA.price,
      line.anchorB.price,
      line.projectedPrice,
      startPrice,
      endPrice
    );
  }
  if (trendline) {
    assertPositivePrice(trendline.anchorA.price, "Trendline anchor A");
    assertPositivePrice(trendline.anchorB.price, "Trendline anchor B");
    if (trendline.anchorA.openTime === trendline.anchorB.openTime) {
      throw new Error("Trendline anchors must have different timestamps");
    }
    priceValues.push(
      trendline.anchorA.price,
      trendline.anchorB.price,
      trendline.anchorA.price + trendlineSlope! * (startTime - trendline.anchorA.openTime),
      trendline.anchorA.price + trendlineSlope! * (endTime - trendline.anchorA.openTime)
    );
  }

  let minimum = Math.min(...priceValues);
  let maximum = Math.max(...priceValues);
  const margin = (maximum - minimum) * 0.08 || maximum * 0.01;
  minimum = Math.max(Number.EPSILON, minimum - margin);
  maximum += margin;
  const yForPrice = (price: number): number =>
    PLOT.bottom - (price - minimum) / (maximum - minimum) * (PLOT.bottom - PLOT.top);

  const elements: string[] = [
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${COLORS.background}"/>`,
    `<rect x="24" y="20" width="${WIDTH - 48}" height="${HEIGHT - 40}" rx="16" fill="${COLORS.panel}"/>`
  ];

  for (let step = 0; step <= 5; step += 1) {
    const price = minimum + (maximum - minimum) * step / 5;
    const y = yForPrice(price);
    elements.push(svgLine(PLOT.left, y, PLOT.right, y, COLORS.grid, 1));
    elements.push(
      `<text x="${PLOT.right + 12}" y="${(y + 5).toFixed(2)}" fill="${COLORS.muted}" font-size="13">${price.toPrecision(6)}</text>`
    );
  }

  for (const line of [
    candidate.chartAnnotations.actionLine,
    candidate.chartAnnotations.safetyLine
  ]) {
    if (!line) continue;
    const isActionLine = line === candidate.chartAnnotations.actionLine;
    const color = isActionLine ? COLORS.trendline : COLORS.stop;
    const slope =
      (line.anchorB.price - line.anchorA.price) /
      (line.anchorB.openTime - line.anchorA.openTime);
    const startPrice = line.anchorA.price +
      slope * (startTime - line.anchorA.openTime);
    const endPrice = line.anchorA.price +
      slope * (endTime - line.anchorA.openTime);
    elements.push(svgLine(
      PLOT.left,
      yForPrice(startPrice),
      PLOT.right,
      yForPrice(endPrice),
      color,
      2,
      isActionLine ? "8 5" : "4 4"
    ));
    elements.push(
      `<text x="${PLOT.left + 8}" y="${PLOT.top + (isActionLine ? 17 : 34)}" fill="${color}" font-size="12">${isActionLine ? "Action" : "Safety"} · ${escapeXml(line.id)} · ${line.status}</text>`
    );
  }

  for (const zone of candidate.chartAnnotations.zones) {
    const top = yForPrice(zone.high);
    const bottom = yForPrice(zone.low);
    elements.push(
      `<rect x="${PLOT.left}" y="${top.toFixed(2)}" width="${PLOT.right - PLOT.left}" height="${(bottom - top).toFixed(2)}" fill="${COLORS.zone}" fill-opacity="0.13" stroke="${COLORS.zone}" stroke-dasharray="6 4"/>`
    );
    elements.push(
      `<text x="${PLOT.left + 8}" y="${(top + 17).toFixed(2)}" fill="${COLORS.zone}" font-size="12">${escapeXml(zone.label)}</text>`
    );
  }

  if (trendline) {
    const slope =
      (trendline.anchorB.price - trendline.anchorA.price) /
      (trendline.anchorB.openTime - trendline.anchorA.openTime);
    const projectedStartPrice = trendline.anchorA.price +
      slope * (startTime - trendline.anchorA.openTime);
    const projectedEndPrice = trendline.anchorA.price +
      slope * (endTime - trendline.anchorA.openTime);
    elements.push(svgLine(
      PLOT.left,
      yForPrice(projectedStartPrice),
      PLOT.right,
      yForPrice(projectedEndPrice),
      COLORS.trendline,
      2,
      "8 5"
    ));
    elements.push(
      `<text x="${PLOT.left + 8}" y="${PLOT.top + 17}" fill="${COLORS.trendline}" font-size="12">Trendline: ${escapeXml(trendline.id)}</text>`
    );
  }

  for (const level of candidate.chartAnnotations.levels) {
    const y = yForPrice(level.price);
    elements.push(svgLine(PLOT.left, y, PLOT.right, y, COLORS.level, 1.5, "5 4"));
    elements.push(
      `<text x="${PLOT.left + 8}" y="${(y - 5).toFixed(2)}" fill="${COLORS.level}" font-size="12">${escapeXml(level.label)}</text>`
    );
  }

  for (const [label, price, color] of [
    ["ENTRY", candidate.entryPrice, COLORS.entry],
    ["STOP", candidate.stopLoss, COLORS.stop],
    ["TP1", candidate.target1, COLORS.target],
    ["TP2", candidate.target2, COLORS.target]
  ] as const) {
    const y = yForPrice(price);
    elements.push(svgLine(PLOT.left, y, PLOT.right, y, color, 1.5, "7 4"));
    elements.push(
      `<text x="${PLOT.right - 5}" y="${(y - 5).toFixed(2)}" text-anchor="end" fill="${color}" font-size="12">${label} ${price.toPrecision(6)}</text>`
    );
  }

  candles.forEach((candle, index) => {
    const open = candlePrice(candle, "open");
    const close = candlePrice(candle, "close");
    const high = candlePrice(candle, "high");
    const low = candlePrice(candle, "low");
    const x = xForTime((candle.openTime + candle.closeTime) / 2);
    const color = close >= open ? COLORS.up : COLORS.down;
    const bodyTop = yForPrice(Math.max(open, close));
    const bodyBottom = yForPrice(Math.min(open, close));
    const bodyHeight = Math.max(1, bodyBottom - bodyTop);
    const bodyWidth = Math.max(2, Math.min(9, candleGap * 0.65));
    elements.push(svgLine(x, yForPrice(high), x, yForPrice(low), color, 1.5));
    elements.push(
      `<rect x="${(x - bodyWidth / 2).toFixed(2)}" y="${bodyTop.toFixed(2)}" width="${bodyWidth.toFixed(2)}" height="${bodyHeight.toFixed(2)}" fill="${color}"/>`
    );
  });

  elements.push(
    `<text x="${PLOT.left}" y="48" fill="${COLORS.text}" font-size="23" font-weight="700">${escapeXml(candidate.symbol)} · 5M</text>`,
    `<text x="${PLOT.right}" y="48" text-anchor="end" fill="${COLORS.muted}" font-size="14">${escapeXml(candidate.strategy.replaceAll("_", " "))} · ${candidate.side.toUpperCase()}</text>`,
    `<text x="${PLOT.left}" y="${HEIGHT - 52}" fill="${COLORS.muted}" font-size="12">Snapshot ${escapeXml(candidate.snapshotId)} · signal candle close ${new Date(last.closeTime).toISOString()}</text>`,
    `<text x="${PLOT.right}" y="${HEIGHT - 52}" text-anchor="end" fill="${COLORS.target}" font-size="12">TP3: trailing runner</text>`
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">${elements.join("")}</svg>`;
  const rendered = new Resvg(svg, {
    fitTo: { mode: "original" },
    background: COLORS.background
  }).render().asPng();
  const png = new Uint8Array(rendered.byteLength);
  png.set(rendered);
  const image = new Blob([png], { type: "image/png" });
  if (image.size === 0 || image.size > 10 * 1024 * 1024) {
    throw new Error("Rendered signal chart must be a non-empty PNG below 10 MB");
  }
  return { snapshotId: candidate.snapshotId, image };
}
