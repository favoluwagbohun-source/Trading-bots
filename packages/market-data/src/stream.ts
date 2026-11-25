import type { Candle } from "@crypto-signal/shared";
import { CandleStore, validateCandle } from "./candle.js";
import { normalizeSymbol } from "./candle.js";
import type {
  KlineSocket,
  KlineStreamMessage,
  SocketFactory,
  StreamOptions,
  StreamStatus
} from "./types.js";

const DEFAULT_SOCKET_FACTORY: SocketFactory = (url) => {
  const WebSocketConstructor = globalThis.WebSocket;
  if (!WebSocketConstructor) {
    throw new Error("WebSocket is unavailable in this runtime");
  }
  return new WebSocketConstructor(url) as unknown as KlineSocket;
};

export class BinanceKlineStream {
  private socket: KlineSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private stopped = false;
  private readonly initialDelay: number;
  private readonly maxDelay: number;
  private readonly jitterMs: number;
  private readonly socketFactory: SocketFactory;
  private readonly store: CandleStore;

  constructor(private readonly options: StreamOptions) {
    this.initialDelay = options.initialReconnectDelayMs ?? 1000;
    this.maxDelay = options.maxReconnectDelayMs ?? 60_000;
    this.jitterMs = options.jitterMs ?? 250;
    this.socketFactory = options.socketFactory ?? DEFAULT_SOCKET_FACTORY;
    const intervalMs: Record<string, number> = {
      "1m": 60_000,
      "5m": 300_000,
      "1h": 3_600_000,
      "4h": 14_400_000,
      "1d": 86_400_000,
      "1w": 604_800_000
    };
    this.store = new CandleStore(intervalMs[options.timeframe]);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close();
    this.socket = undefined;
  }

  getStatus(): StreamStatus {
    return {
      connected: this.socket?.readyState === 1,
      lastUpdateTime: this.store.latest()?.closeTime ?? null,
      reconnectAttempt: this.reconnectAttempt,
      message: this.stopped ? "Stopped" : "Streaming"
    };
  }

  private connect(): void {
    if (this.stopped) return;
    const symbol = normalizeSymbol(this.options.symbol).toLowerCase();
    const url = `wss://data-stream.binance.vision/ws/${symbol}@kline_${this.options.timeframe}`;

    try {
      const socket = this.socketFactory(url);
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.reconnectAttempt = 0;
        this.options.onStatus({
          connected: true,
          lastUpdateTime: this.store.latest()?.closeTime ?? null,
          reconnectAttempt: 0,
          message: "Connected"
        });
      });
      socket.addEventListener("message", (event) => {
        try {
          const text = typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data);
          const message = JSON.parse(text) as KlineStreamMessage;
          if (message.e !== "kline") return;
          const candle: Candle = {
            openTime: message.k.t,
            closeTime: message.k.T,
            open: message.k.o,
            high: message.k.h,
            low: message.k.l,
            close: message.k.c,
            volume: message.k.v,
            closed: message.k.x
          };
          validateCandle(candle);
          const result = this.store.merge(candle);
          if (result.updated) this.options.onCandle(result.candle);
        } catch (error) {
          this.options.onStatus({
            connected: this.socket?.readyState === 1,
            lastUpdateTime: this.store.latest()?.closeTime ?? null,
            reconnectAttempt: this.reconnectAttempt,
            message: `Ignored invalid message: ${String(error)}`
          });
        }
      });
      socket.addEventListener("close", () => this.scheduleReconnect());
      socket.addEventListener("error", () => this.scheduleReconnect());
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const exponential = Math.min(
      this.initialDelay * 2 ** this.reconnectAttempt,
      this.maxDelay
    );
    const delay = exponential + Math.floor(Math.random() * (this.jitterMs + 1));
    this.reconnectAttempt += 1;
    this.options.onStatus({
      connected: false,
      lastUpdateTime: this.store.latest()?.closeTime ?? null,
      reconnectAttempt: this.reconnectAttempt,
      message: `Reconnecting in ${delay} ms`
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.socket = undefined;
      this.connect();
    }, delay);
  }
}
