export const SUPPORTED_TIMEFRAMES = [
  "1m",
  "5m",
  "1h",
  "4h",
  "1d",
  "1w"
] as const;

export type MarketTimeframe = (typeof SUPPORTED_TIMEFRAMES)[number];

export interface KlineStreamMessage {
  readonly e: "kline";
  readonly s: string;
  readonly k: {
    readonly t: number;
    readonly T: number;
    readonly o: string;
    readonly h: string;
    readonly l: string;
    readonly c: string;
    readonly v: string;
    readonly x: boolean;
  };
}

export type KlineSocket = {
  readonly readyState: number;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: string | ArrayBuffer }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
};

export type SocketFactory = (url: string) => KlineSocket;

export interface StreamOptions {
  readonly symbol: string;
  readonly timeframe: MarketTimeframe;
  readonly onCandle: (candle: import("@crypto-signal/shared").Candle) => void;
  readonly onStatus: (status: StreamStatus) => void;
  readonly socketFactory?: SocketFactory;
  readonly initialReconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
  readonly jitterMs?: number;
}

export interface StreamStatus {
  readonly connected: boolean;
  readonly lastUpdateTime: number | null;
  readonly reconnectAttempt: number;
  readonly message: string;
}
