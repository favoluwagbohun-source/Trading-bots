import { mkdir, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BinanceRestClient, type MarketTimeframe } from "@crypto-signal/market-data";

const SYMBOLS = ["BTCUSDT", "BTCUSDC"] as const;
const TIMEFRAMES: readonly MarketTimeframe[] = ["1M", "1w", "1d", "4h", "1h", "5m"];

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return argument?.slice(prefix.length);
}

function parseDate(value: string | undefined, name: string, endOfDay = false): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} must use YYYY-MM-DD`);
  }
  const parsed = Date.parse(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  if (
    !Number.isSafeInteger(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${name} is not a valid date`);
  }
  return parsed;
}

function parseSymbols(): string[] {
  const configured = option("symbols");
  const symbols = configured
    ? configured.split(",").map((symbol) => symbol.trim().toUpperCase())
    : [...SYMBOLS];
  if (
    symbols.length === 0 ||
    symbols.some((symbol) => !/^[A-Z0-9]{6,20}$/.test(symbol)) ||
    new Set(symbols).size !== symbols.length
  ) {
    throw new Error("--symbols must be a comma-separated list of unique Binance symbols");
  }
  return symbols;
}

function getRange(): { startTime: number; endTime: number } {
  const startDate = parseDate(option("start"), "--start");
  const endDate = parseDate(option("end"), "--end", true);
  if (startDate !== undefined || endDate !== undefined) {
    if (startDate === undefined || endDate === undefined || endDate < startDate) {
      throw new Error("Provide both --start and --end as an ordered UTC date range");
    }
    return { startTime: startDate, endTime: endDate };
  }

  const years = Number(option("years") ?? "10");
  if (!Number.isInteger(years) || years < 1 || years > 10) {
    throw new Error("--years must be an integer from 1 to 10");
  }
  const endTime = Date.now();
  const startDateTime = new Date(endTime);
  startDateTime.setUTCFullYear(startDateTime.getUTCFullYear() - years);
  return { startTime: startDateTime.getTime(), endTime };
}

async function main(): Promise<void> {
  const symbols = parseSymbols();
  const { startTime, endTime } = getRange();
  const outputRoot = resolve(option("output") ?? "research-data");
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDirectory = resolve(outputRoot, `binance-spot-${runId}`);
  await mkdir(outputRoot, { recursive: true });
  await mkdir(runDirectory, { recursive: false });

  const client = new BinanceRestClient();
  const manifest: {
    readonly source: string;
    readonly product: string;
    readonly requestedStartTime: number;
    readonly requestedEndTime: number;
    readonly generatedAt: string;
    readonly markets: Record<string, Record<string, {
      readonly file: string;
      readonly candleCount: number;
      readonly firstOpenTime: number | null;
      readonly lastCloseTime: number | null;
      readonly closedCandleCount: number;
      readonly skippedNoTradeCandles: number;
    }>>;
  } = {
    source: "Binance public Spot klines",
    product: "spot",
    requestedStartTime: startTime,
    requestedEndTime: endTime,
    generatedAt: new Date().toISOString(),
    markets: {}
  };

  for (const symbol of symbols) {
    manifest.markets[symbol] = {};
    for (const timeframe of TIMEFRAMES) {
      const file = `${symbol}-${timeframe}.jsonl`;
      const handle = await open(resolve(runDirectory, file), "wx");
      let candleCount = 0;
      let closedCandleCount = 0;
      const skippedBefore = client.skippedNoTradeCandleCount;
      let firstOpenTime: number | null = null;
      let lastCloseTime: number | null = null;
      try {
        for await (const page of client.iterateHistoricalKlines({
          symbol,
          timeframe,
          startTime,
          endTime
        })) {
          await handle.writeFile(page.map((candle) => JSON.stringify(candle)).join("\n") + "\n");
          candleCount += page.length;
          closedCandleCount += page.filter((candle) => candle.closed).length;
          firstOpenTime ??= page[0]!.openTime;
          lastCloseTime = page.at(-1)!.closeTime;
        }
      } finally {
        await handle.close();
      }
      manifest.markets[symbol]![timeframe] = {
        file,
        candleCount,
        firstOpenTime,
        lastCloseTime,
        closedCandleCount,
        skippedNoTradeCandles: client.skippedNoTradeCandleCount - skippedBefore
      };
      console.log(`${symbol} ${timeframe}: ${candleCount} candles`);
    }
  }

  await writeFile(
    resolve(runDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" }
  );
  console.log(`Historical data saved to ${runDirectory}`);
}

main().catch((error: unknown) => {
  console.error("Binance historical data download failed:", error);
  process.exitCode = 1;
});
