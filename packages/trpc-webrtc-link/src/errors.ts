export type WebRTCTransportErrorCode =
  | 'CHANNEL_CLOSED'
  | 'CHANNEL_NOT_OPEN'
  | 'HANDSHAKE_TIMEOUT'
  | 'KEEPALIVE_TIMEOUT'
  | 'PROTOCOL_ERROR'
  | 'QUEUE_OVERFLOW'
  | 'RECONNECT_EXHAUSTED'
  | 'UNRELIABLE_CHANNEL';

export class WebRTCTransportError extends Error {
  public readonly code: WebRTCTransportErrorCode;

  public constructor(code: WebRTCTransportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WebRTCTransportError';
    this.code = code;
  }
}

export class WebRTCChannelClosedError extends WebRTCTransportError {
  public constructor(message = 'RTCDataChannel closed', options?: ErrorOptions) {
    super('CHANNEL_CLOSED', message, options);
    this.name = 'WebRTCChannelClosedError';
  }
}

export class WebRTCChannelNotOpenError extends WebRTCTransportError {
  public constructor(message = 'RTCDataChannel is not open', options?: ErrorOptions) {
    super('CHANNEL_NOT_OPEN', message, options);
    this.name = 'WebRTCChannelNotOpenError';
  }
}

export class WebRTCHandshakeTimeoutError extends WebRTCTransportError {
  public constructor(timeoutMs: number) {
    super('HANDSHAKE_TIMEOUT', `WebRTC protocol handshake timed out after ${timeoutMs}ms`);
    this.name = 'WebRTCHandshakeTimeoutError';
  }
}

export class WebRTCKeepAliveTimeoutError extends WebRTCTransportError {
  public constructor(timeoutMs: number) {
    super('KEEPALIVE_TIMEOUT', `WebRTC peer did not respond to a ping within ${timeoutMs}ms`);
    this.name = 'WebRTCKeepAliveTimeoutError';
  }
}

export class WebRTCProtocolError extends WebRTCTransportError {
  public constructor(message: string, options?: ErrorOptions) {
    super('PROTOCOL_ERROR', message, options);
    this.name = 'WebRTCProtocolError';
  }
}

export class WebRTCQueueOverflowError extends WebRTCTransportError {
  public readonly queueLimit: number;

  public constructor(queueLimit: number) {
    super('QUEUE_OVERFLOW', `RTCDataChannel send queue exceeded its ${queueLimit} frame limit`);
    this.name = 'WebRTCQueueOverflowError';
    this.queueLimit = queueLimit;
  }
}

export class WebRTCReconnectExhaustedError extends WebRTCTransportError {
  public readonly attempts: number;

  public constructor(attempts: number, options?: ErrorOptions) {
    super(
      'RECONNECT_EXHAUSTED',
      `Unable to establish an RTCDataChannel after ${attempts} attempt${attempts === 1 ? '' : 's'}`,
      options,
    );
    this.name = 'WebRTCReconnectExhaustedError';
    this.attempts = attempts;
  }
}

export class WebRTCUnreliableChannelError extends WebRTCTransportError {
  public constructor(message: string) {
    super('UNRELIABLE_CHANNEL', message);
    this.name = 'WebRTCUnreliableChannelError';
  }
}
