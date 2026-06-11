export const TRPC_WEBRTC_PROTOCOL = 'trpc-webrtc/1' as const;

export type WebRTCRequestId = string;
export type WebRTCProcedureType = 'query' | 'mutation' | 'subscription';

interface WebRTCProtocolFrameBase<TType extends string> {
  protocol: typeof TRPC_WEBRTC_PROTOCOL;
  type: TType;
}

export interface WebRTCHandshakeFrame extends WebRTCProtocolFrameBase<'handshake'> {
  role: 'client';
}

export type WebRTCReadyFrame = WebRTCProtocolFrameBase<'ready'>;

export interface WebRTCRequestFrame extends WebRTCProtocolFrameBase<'request'> {
  id: WebRTCRequestId;
  procedureType: WebRTCProcedureType;
  path: string;
  input?: unknown;
}

export type WebRTCResultFrame =
  | (WebRTCProtocolFrameBase<'result'> & {
      id: WebRTCRequestId;
      result: 'started';
    })
  | (WebRTCProtocolFrameBase<'result'> & {
      id: WebRTCRequestId;
      result: 'value';
      data?: unknown;
    });

export interface WebRTCDataFrame extends WebRTCProtocolFrameBase<'data'> {
  id: WebRTCRequestId;
  data?: unknown;
}

export interface WebRTCErrorFrame extends WebRTCProtocolFrameBase<'error'> {
  id: WebRTCRequestId | null;
  error: unknown;
}

export interface WebRTCCompleteFrame extends WebRTCProtocolFrameBase<'complete'> {
  id: WebRTCRequestId;
}

export interface WebRTCCancelFrame extends WebRTCProtocolFrameBase<'cancel'> {
  id: WebRTCRequestId;
  reason?: string;
}

export interface WebRTCPingFrame extends WebRTCProtocolFrameBase<'ping'> {
  nonce: string;
}

export interface WebRTCPongFrame extends WebRTCProtocolFrameBase<'pong'> {
  nonce: string;
}

export type WebRTCClientFrame =
  | WebRTCHandshakeFrame
  | WebRTCRequestFrame
  | WebRTCCancelFrame
  | WebRTCPingFrame
  | WebRTCPongFrame;

export type WebRTCServerFrame =
  | WebRTCReadyFrame
  | WebRTCResultFrame
  | WebRTCDataFrame
  | WebRTCErrorFrame
  | WebRTCCompleteFrame
  | WebRTCPingFrame
  | WebRTCPongFrame;

export type WebRTCProtocolFrame = WebRTCClientFrame | WebRTCServerFrame;

export interface WebRTCFrameParseError {
  code: 'malformed_frame' | 'unsupported_protocol';
  message: string;
}

export type WebRTCFrameParseResult =
  | { ok: true; frame: WebRTCProtocolFrame }
  | { ok: false; error: WebRTCFrameParseError };

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const MAX_PATH_LENGTH = 4096;
const MAX_NONCE_LENGTH = 128;
const MAX_REASON_LENGTH = 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

function hasValidNonce(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_NONCE_LENGTH;
}

function malformed(message: string): WebRTCFrameParseResult {
  return {
    ok: false,
    error: {
      code: 'malformed_frame',
      message,
    },
  };
}

export function getUTF8ByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).byteLength;
  }
  return value.length;
}

export function parseWebRTCFrame(
  data: unknown,
  maxMessageBytes = 1024 * 1024,
): WebRTCFrameParseResult {
  if (typeof data !== 'string') {
    return malformed('RTCDataChannel messages must be JSON text frames');
  }
  if (getUTF8ByteLength(data) > maxMessageBytes) {
    return malformed(`Frame exceeds the ${maxMessageBytes} byte limit`);
  }

  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return malformed('Frame is not valid JSON');
  }

  if (!isRecord(value)) {
    return malformed('Frame must be a JSON object');
  }
  if (value.protocol !== TRPC_WEBRTC_PROTOCOL) {
    return {
      ok: false,
      error: {
        code: 'unsupported_protocol',
        message: `Unsupported protocol version: ${String(value.protocol)}`,
      },
    };
  }
  if (typeof value.type !== 'string') {
    return malformed('Frame type must be a string');
  }

  switch (value.type) {
    case 'handshake':
      return value.role === 'client'
        ? { ok: true, frame: value as unknown as WebRTCHandshakeFrame }
        : malformed('Handshake role must be "client"');
    case 'ready':
      return { ok: true, frame: value as unknown as WebRTCReadyFrame };
    case 'request':
      if (!isRequestId(value.id)) {
        return malformed('Request id is invalid');
      }
      if (
        value.procedureType !== 'query' &&
        value.procedureType !== 'mutation' &&
        value.procedureType !== 'subscription'
      ) {
        return malformed('Request procedureType is invalid');
      }
      if (
        typeof value.path !== 'string' ||
        value.path.length === 0 ||
        value.path.length > MAX_PATH_LENGTH
      ) {
        return malformed('Request path is invalid');
      }
      return { ok: true, frame: value as unknown as WebRTCRequestFrame };
    case 'result':
      if (!isRequestId(value.id)) {
        return malformed('Result id is invalid');
      }
      if (value.result !== 'started' && value.result !== 'value') {
        return malformed('Result kind is invalid');
      }
      return { ok: true, frame: value as unknown as WebRTCResultFrame };
    case 'data':
      return isRequestId(value.id)
        ? { ok: true, frame: value as unknown as WebRTCDataFrame }
        : malformed('Data id is invalid');
    case 'error':
      if (value.id !== null && !isRequestId(value.id)) {
        return malformed('Error id is invalid');
      }
      if (!Object.hasOwn(value, 'error')) {
        return malformed('Error frame is missing its error payload');
      }
      return { ok: true, frame: value as unknown as WebRTCErrorFrame };
    case 'complete':
      return isRequestId(value.id)
        ? { ok: true, frame: value as unknown as WebRTCCompleteFrame }
        : malformed('Complete id is invalid');
    case 'cancel':
      if (!isRequestId(value.id)) {
        return malformed('Cancel id is invalid');
      }
      if (
        value.reason !== undefined &&
        (typeof value.reason !== 'string' || value.reason.length > MAX_REASON_LENGTH)
      ) {
        return malformed('Cancel reason is invalid');
      }
      return { ok: true, frame: value as unknown as WebRTCCancelFrame };
    case 'ping':
      return hasValidNonce(value.nonce)
        ? { ok: true, frame: value as unknown as WebRTCPingFrame }
        : malformed('Ping nonce is invalid');
    case 'pong':
      return hasValidNonce(value.nonce)
        ? { ok: true, frame: value as unknown as WebRTCPongFrame }
        : malformed('Pong nonce is invalid');
    default:
      return malformed(`Unknown frame type: ${value.type}`);
  }
}

export function serializeWebRTCFrame(frame: WebRTCProtocolFrame): string {
  return JSON.stringify(frame);
}
