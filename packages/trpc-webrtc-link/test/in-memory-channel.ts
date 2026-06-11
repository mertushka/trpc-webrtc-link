import {
  getUTF8ByteLength,
  type RTCDataChannelEventListener,
  type RTCDataChannelLike,
  type RTCDataChannelReadyState,
} from '../src/index.js';

export class InMemoryDataChannel implements RTCDataChannelLike {
  public readyState: RTCDataChannelReadyState = 'open';
  public bufferedAmount = 0;
  public bufferedAmountLowThreshold = 0;
  public readonly ordered = true;
  public readonly maxPacketLifeTime = null;
  public readonly maxRetransmits = null;
  public autoDrain = true;
  public readonly sent: string[] = [];

  readonly #listeners = new Map<string, Set<RTCDataChannelEventListener>>();
  #peer: InMemoryDataChannel | null = null;

  public pairWith(peer: InMemoryDataChannel): void {
    this.#peer = peer;
  }

  public addEventListener(type: string, listener: RTCDataChannelEventListener): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: RTCDataChannelEventListener): void {
    const listeners = this.#listeners.get(type);
    listeners?.delete(listener);
    if (listeners?.size === 0) {
      this.#listeners.delete(type);
    }
  }

  public send(data: string): void {
    if (this.readyState !== 'open') {
      throw new Error('Channel is not open');
    }
    this.sent.push(data);
    const bytes = getUTF8ByteLength(data);
    this.bufferedAmount += bytes;
    queueMicrotask(() => {
      if (this.#peer?.readyState === 'open') {
        this.#peer.dispatch('message', { type: 'message', data });
      }
      if (this.autoDrain) {
        this.drain(bytes);
      }
    });
  }

  public close(): void {
    if (this.readyState === 'closed') {
      return;
    }
    this.readyState = 'closed';
    queueMicrotask(() => this.dispatch('close', { type: 'close' }));
    const peer = this.#peer;
    if (peer && peer.readyState !== 'closed') {
      peer.readyState = 'closed';
      queueMicrotask(() => peer.dispatch('close', { type: 'close' }));
    }
  }

  public drain(bytes = Number.POSITIVE_INFINITY): void {
    const previous = this.bufferedAmount;
    this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes);
    if (
      previous > this.bufferedAmountLowThreshold &&
      this.bufferedAmount <= this.bufferedAmountLowThreshold
    ) {
      queueMicrotask(() => this.dispatch('bufferedamountlow', { type: 'bufferedamountlow' }));
    }
  }

  public inject(data: unknown): void {
    this.dispatch('message', { type: 'message', data });
  }

  public listenerCount(type?: string): number {
    if (type) {
      return this.#listeners.get(type)?.size ?? 0;
    }
    let count = 0;
    for (const listeners of this.#listeners.values()) {
      count += listeners.size;
    }
    return count;
  }

  public dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

export function createInMemoryChannelPair(): {
  client: InMemoryDataChannel;
  server: InMemoryDataChannel;
} {
  const client = new InMemoryDataChannel();
  const server = new InMemoryDataChannel();
  client.pairWith(server);
  server.pairWith(client);
  return { client, server };
}
