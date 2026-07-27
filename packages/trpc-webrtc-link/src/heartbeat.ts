import { normalizeTimeoutMs } from './channel.js';
import { WebRTCKeepAliveTimeoutError } from './errors.js';

export interface WebRTCKeepAliveOptions {
  /**
   * Enable protocol-level ping/pong health checks.
   * @default false
   */
  enabled: boolean;
  /**
   * Wait this long without inbound activity before sending a ping.
   */
  intervalMs?: number;
  /**
   * Close the connection if the matching pong is not received in time.
   */
  pongTimeoutMs?: number;
}

interface NormalizedWebRTCKeepAliveOptions {
  enabled: boolean;
  intervalMs: number;
  pongTimeoutMs: number;
}

export function normalizeKeepAliveOptions(
  options: WebRTCKeepAliveOptions | undefined,
  defaults: { intervalMs: number; pongTimeoutMs: number },
): NormalizedWebRTCKeepAliveOptions {
  if (!options?.enabled) {
    return {
      enabled: false,
      ...defaults,
    };
  }
  return {
    enabled: true,
    intervalMs: normalizeTimeoutMs(options.intervalMs ?? defaults.intervalMs, 'intervalMs'),
    pongTimeoutMs: normalizeTimeoutMs(
      options.pongTimeoutMs ?? defaults.pongTimeoutMs,
      'pongTimeoutMs',
    ),
  };
}

function createNonce(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
}

export class HeartbeatController {
  readonly #options: NormalizedWebRTCKeepAliveOptions;
  readonly #sendPing: (nonce: string) => Promise<void>;
  readonly #onFailure: (error: Error) => void;

  #active = false;
  #pendingNonce: string | null = null;
  #pingTimer: ReturnType<typeof setTimeout> | undefined;
  #pongTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(options: {
    keepAlive: NormalizedWebRTCKeepAliveOptions;
    sendPing(nonce: string): Promise<void>;
    onFailure(error: Error): void;
  }) {
    this.#options = options.keepAlive;
    this.#sendPing = options.sendPing;
    this.#onFailure = options.onFailure;
  }

  public start(): void {
    if (!this.#options.enabled || this.#active) {
      return;
    }
    this.#active = true;
    this.#schedulePing();
  }

  /**
   * Record any valid inbound non-pong frame as proof that the peer is alive.
   */
  public activity(): void {
    if (!this.#active) {
      return;
    }
    this.#clearTimers();
    this.#pendingNonce = null;
    this.#schedulePing();
  }

  public pong(nonce: string): boolean {
    if (!this.#active || nonce !== this.#pendingNonce) {
      return false;
    }
    this.activity();
    return true;
  }

  public stop(): void {
    this.#active = false;
    this.#pendingNonce = null;
    this.#clearTimers();
  }

  #schedulePing(): void {
    this.#pingTimer = setTimeout(() => {
      if (!this.#active) {
        return;
      }
      const nonce = createNonce();
      this.#pendingNonce = nonce;
      this.#pongTimer = setTimeout(() => {
        if (!this.#active || this.#pendingNonce !== nonce) {
          return;
        }
        this.stop();
        this.#notifyFailure(new WebRTCKeepAliveTimeoutError(this.#options.pongTimeoutMs));
      }, this.#options.pongTimeoutMs);
      void this.#sendPing(nonce).catch((cause: unknown) => {
        if (!this.#active) {
          return;
        }
        this.stop();
        this.#notifyFailure(cause instanceof Error ? cause : new Error(String(cause)));
      });
    }, this.#options.intervalMs);
  }

  #clearTimers(): void {
    if (this.#pingTimer !== undefined) {
      clearTimeout(this.#pingTimer);
      this.#pingTimer = undefined;
    }
    if (this.#pongTimer !== undefined) {
      clearTimeout(this.#pongTimer);
      this.#pongTimer = undefined;
    }
  }

  #notifyFailure(error: Error): void {
    try {
      this.#onFailure(error);
    } catch {
      // User-controlled failure handling must not escape a timer callback.
    }
  }
}
