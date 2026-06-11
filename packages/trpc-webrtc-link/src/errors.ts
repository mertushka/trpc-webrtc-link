export type WebRTCTransportErrorCode =
  | 'CHANNEL_CLOSED'
  | 'CHANNEL_NOT_OPEN'
  | 'HANDSHAKE_TIMEOUT'
  | 'PROTOCOL_ERROR'
  | 'QUEUE_OVERFLOW'
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

export class WebRTCUnreliableChannelError extends WebRTCTransportError {
  public constructor(message: string) {
    super('UNRELIABLE_CHANNEL', message);
    this.name = 'WebRTCUnreliableChannelError';
  }
}
