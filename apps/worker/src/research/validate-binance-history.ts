import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  BinanceRestClient,
  validateCandle
} from "@crypto-signal/market-data";
import type { Candle } from "@crypto-signal/shared";
import type { BacktestConfig } from "@crypto-signal/backtesting";
import {
  prepareHistoricalTimeframe,
  validateHistoricalMarket,
  type HistoricalTimeframes,
  type HistoricalTimeframe,
  type HistoricalTimeframeId
} from "./historical-validation.js";

const WARMUP_BARS = 180 * 24 * 12;
const TEST_BARS = 30 * 24 * 12;

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return argument?.slice(prefix.length);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadCandles(path: string): Promise<Candle[]> {
  const input = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  const candles: Candle[] = [];
  for await (const line of input) {
    if (!line.trim()) continue;
    const parsed: unknown = JSON.parse(line);
    if (
      !record(parsed) ||
      typeof parsed.openTime !== "number" ||
      typeof parsed.closeTime !== "number" ||
      typeof parsed.open !== "string" ||
      typeof parsed.high !== "string" ||
      typeof parsed.low !== "string" ||
      typeof parsed.close !== "string" ||
      typeof parsed.volume !== "string" ||
      typeof parsed.closed !== "boolean"
    ) {
      throw new Error(`Malformed historical candle in ${path}`);
    }
    const candle: Candle = {
      openTime: parsed.openTime,
      closeTime: parsed.closeTime,
      open: parsed.open,
      high: parsed.high,
      low: parsed.low,
      close: parsed.close,
      volume: parsed.volume,
      closed: parsed.closed
    };
    validateCandle(candle);
    if (candle.closed) candles.push(candle);
  }
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index]!.openTime <= candles[index - 1]!.openTime) {
      throw new Error(`Historical candles are not strictly ordered in ${path}`);
    }
  }
  return candles;
}

function resolveDatasetPath(): string {
  const configured = option("dataset");
  if (!configured) {
    throw new Error("--dataset is required (path to a completed download directory)");
  }
  const dataset = resolve(configured);
  if (!dataset.includes("binance-spot-")) {
    throw new Error("--dataset must point to a Binance Spot history directory");
  }
  return dataset;
}

async function loadTimeframe(
  market: Record<string, unknown>,
  dataset: string,
  timeframe: HistoricalTimeframeId
): Promise<HistoricalTimeframe> {
  const metadata = market[timeframe];
  if (!record(metadata) || typeof metadata.file !== "string") {
    throw new Error(`Manifest is missing ${timeframe} data`);
  }
  const candles = await loadCandles(resolve(dataset, metadata.file));
  return prepareHistoricalTimeframe(candles, timeframe);
}

function summarizeResults(results: ReturnType<typeof validateHistoricalMarket>) {
  return results.map(({ strategy, variation, report }) => ({
    strategy,
    ...(variation === undefined ? {} : { variation }),
    summary: report.validation.summary,
    folds: report.validation.folds.map(({ fold, startTime, endTime, result }) => ({
      fold,
      startTime,
      endTime,
      totalTrades: result.metrics.totalTrades,
      netProfit: result.metrics.netProfit,
      profitFactor: result.metrics.profitFactor,
      maximumDrawdownPercent: result.metrics.maximumDrawdownPercent,
      totalFees: result.metrics.totalFees
    })),
    regimes: report.regimes
  }));
}

async function main(): Promise<void> {
  const dataset = resolveDatasetPath();
  const manifest = JSON.parse(
    await readFile(resolve(dataset, "manifest.json"), "utf8")
  ) as unknown;
  if (!record(manifest) || manifest.product !== "spot" || !record(manifest.markets)) {
    throw new Error("Dataset manifest is not a Binance Spot history manifest");
  }

  const feeRatePerSide = Number(option("fee-rate") ?? "0.001");
  const slippageRatePerSide = Number(option("slippage-rate") ?? "0.0005");
  if (
    !Number.isFinite(feeRatePerSide) ||
    feeRatePerSide < 0 ||
    !Number.isFinite(slippageRatePerSide) ||
    slippageRatePerSide < 0
  ) {
    throw new Error("Fee and slippage rates must be non-negative finite numbers");
  }

  const client = new BinanceRestClient();
  const outputMarkets: Record<string, unknown> = {};
  const symbols = Object.keys(manifest.markets);
  for (const symbol of symbols) {
    const inputMarket = manifest.markets[symbol];
    if (!record(inputMarket)) throw new Error(`Malformed manifest entry for ${symbol}`);
    const [month, week, day, fourHour, hour, fiveMinute] = await Promise.all([
      loadTimeframe(inputMarket, dataset, "1M"),
      loadTimeframe(inputMarket, dataset, "1w"),
      loadTimeframe(inputMarket, dataset, "1d"),
      loadTimeframe(inputMarket, dataset, "4h"),
      loadTimeframe(inputMarket, dataset, "1h"),
      loadTimeframe(inputMarket, dataset, "5m")
    ]);
    const timeframeData: HistoricalTimeframes = {
      "1M": month,
      "1w": week,
      "1d": day,
      "4h": fourHour,
      "1h": hour,
      "5m": fiveMinute
    };
    if (timeframeData["5m"].candles.length < WARMUP_BARS + TEST_BARS) {
      throw new Error(`${symbol} needs at least six months of warm-up and one month of test data`);
    }
    const instrument = await client.getInstrumentRules(symbol);
    const options: BacktestConfig = {
      strategy: "break_and_retest",
      initialEquity: 10_000,
      instrument,
      costs: { feeRatePerSide, slippageRatePerSide }
    };
    const results = validateHistoricalMarket({
      symbol,
      timeframes: timeframeData,
      options,
      warmupBars: WARMUP_BARS,
      evaluationBars: TEST_BARS
    });
    outputMarkets[symbol] = summarizeResults(results);
    console.log(`${symbol}: completed ${results.length} independent strategy variations`);
  }

  const output = {
    source: "Binance public Spot historical klines",
    dataset,
    generatedAt: new Date().toISOString(),
    validation: {
      method: "fixed-rule, non-overlapping out-of-sample folds",
      warmupDays: 180,
      testDaysPerFold: 30,
      target2R: 3,
      initialEquity: 10_000,
      riskPerTradePercent: 1,
      instrumentRules: "Current Binance Spot exchangeInfo applied to historical dates.",
      feeRatePerSide,
      slippageRatePerSide,
      maximumRecentSwingsPerDirectionPerTimeframe: 50,
      trendlineLookbackBars4h: 500,
      trendlineMinimumTouches: 3,
      safetyStopBufferPercent: 0.1,
      sourceAttribution: "Rules are engineering assumptions, not source-verified methodology."
    },
    markets: outputMarkets
  };
  const reportPath = resolve(dataset, `validation-report-${Date.now()}.json`);
  await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
  console.log(`Research report saved to ${reportPath}`);
}

main().catch((error: unknown) => {
  console.error("Binance historical validation failed:", error);
  process.exitCode = 1;
});
