# Wire protocol

The public protocol identifier is:

```ts
TRPC_WEBRTC_PROTOCOL === 'trpc-webrtc/1';
```

Version 1 uses JSON text frames on one ordered, reliable
`RTCDataChannel`. The transport rejects unordered channels and channels with
packet lifetime or retransmission limits.

## Frames

Every frame contains:

```json
{
  "protocol": "trpc-webrtc/1",
  "type": "..."
}
```

| Frame           | Direction        | Purpose                                      |
| --------------- | ---------------- | -------------------------------------------- |
| `handshake`     | client to server | Start negotiation and send connection params |
| `ready`         | server to client | Context exists; requests may start           |
| `request`       | client to server | Query, mutation, or subscription             |
| `result`        | server to client | Unary value or subscription start            |
| `data`          | server to client | Subscription value and optional tracked ID   |
| `error`         | server to client | Transformed tRPC error shape                 |
| `complete`      | server to client | Normal operation completion                  |
| `cancel`        | client to server | Abort one operation                          |
| `ping` / `pong` | either direction | Connection health check                      |
| `reconnect`     | server to client | Request a replacement channel                |

Operation IDs are opaque collision-resistant strings. Request paths,
identifiers, control values, frame size, procedure types, and legal operation
state transitions are validated at runtime.

## Handshake

The client sends:

```json
{
  "protocol": "trpc-webrtc/1",
  "type": "handshake",
  "role": "client",
  "connectionParams": {
    "authorization": "Bearer ..."
  }
}
```

Connection parameter values must be strings. The server creates context and
then sends `ready`. Requests before readiness and duplicate handshakes are
fatal protocol errors.

## Operations

A request identifies its tRPC procedure type, path, transformed input, and an
optional last tracked event:

```json
{
  "protocol": "trpc-webrtc/1",
  "type": "request",
  "id": "opaque-id",
  "procedureType": "subscription",
  "path": "events",
  "input": {},
  "lastEventId": "event-41"
}
```

Queries and mutations receive one `result: "value"` frame followed by
`complete`. Subscriptions receive `result: "started"`, zero or more `data`
frames, and `complete`.

A tracked data frame carries the event ID outside transformed data:

```json
{
  "protocol": "trpc-webrtc/1",
  "type": "data",
  "id": "opaque-id",
  "eventId": "event-42",
  "data": {
    "id": "event-42",
    "data": {}
  }
}
```

The `data` value is processed by the router's output transformer. The separate
`eventId` remains a protocol string used by tRPC result envelopes and
reconnection bookkeeping.

## Errors

Server errors contain the router's configured tRPC error shape after output
transformation. An operation error uses its request ID. A connection or
handshake error uses `id: null`.

Malformed JSON, an unsupported protocol identifier, invalid connection frames,
or an impossible connection-level state closes the channel. Unknown operation
IDs and correlatable operation-state mistakes are reported through
`onProtocolError` without throwing from event listeners.

## Cancellation

Cancellation contains the operation ID and an optional bounded reason. The
server aborts the procedure signal and removes queued responses for that
operation. Cancellation is best effort and does not provide transactional or
exactly-once semantics.

## Flow control

Frames are serialized before enqueueing and checked against
`maxMessageBytes`. The writer pauses above `highWatermark`, resumes at
`lowWatermark`, bounds the total queued frame count, and schedules queues in
round-robin order by operation ID.

Applications should keep `maxMessageBytes` no larger than the effective SCTP
message size negotiated by their WebRTC implementations. Version 1 does not
fragment one protocol frame across multiple data-channel messages.

## Extensibility

Unknown frame types are rejected. Additive optional properties may be
introduced within version 1 when older endpoints can safely ignore them.
Changes that alter required framing, ordering, reliability, or operation
semantics require a new protocol identifier.
