# Connection lifecycle

`@webrtc-node/trpc-webrtc-link` treats a data channel as one transport
connection. SDP/ICE signaling creates channels; the link negotiates its wire
protocol, executes tRPC operations, detects connection loss, and can ask an
application factory for a replacement.

## Choosing a channel source

Use a direct channel when its lifetime matches the tRPC client:

```ts
const link = createWebRTCLink<AppRouter>({ channel });
await link.connect();
```

Direct channels negotiate immediately. They cannot be replaced because the
link has no way to create another peer connection.

Use a factory when the signaling layer can create fresh channels:

```ts
const link = createWebRTCLink<AppRouter>({
  channel: ({ signal, attempt, cause }) => signaling.createDataChannel({ signal, attempt, cause }),
});
```

The factory is invoked once per connection attempt. A returned channel must be
new or otherwise safe to negotiate as a new `trpc-webrtc/1` connection. The
remote signaling participant must attach `createWebRTCHandler()` to its paired
channel.

The attempt signal covers factory execution, channel opening, connection
parameters, and protocol negotiation. Respect it to stop ICE gathering and
dispose abandoned peer connections promptly.

## Link states

The extended link reports:

| State        | Meaning                                              |
| ------------ | ---------------------------------------------------- |
| `idle`       | No usable channel; a later operation may connect     |
| `connecting` | Creating, opening, or negotiating a channel          |
| `open`       | The server context exists and operations may be sent |
| `closed`     | `link.close()` permanently disposed this link        |

Read `link.connectionState`, subscribe with
`link.subscribeConnectionState()`, or use the `onConnectionStateChange`
option. tRPC subscription observers receive the native tRPC states `idle`,
`connecting`, and `pending`.

`connect()` joins an in-progress attempt and resolves at `open`.
`reconnect()` intentionally replaces the active channel and requires a
factory. `link.close()` is final.

## Automatic reconnect

Automatic reconnect is opt-in because WebRTC reconnection may involve
signaling traffic, TURN allocation, permissions, and user-visible policy.

```ts
const link = createWebRTCLink<AppRouter>({
  channel: createFreshChannel,
  reconnect: {
    enabled: true,
    maxAttempts: 8,
    retryDelayMs: (attempt) => (attempt === 0 ? 0 : Math.min(1_000 * 2 ** attempt, 30_000)),
    shouldRetry: ({ error }) => !isPermanent(error),
  },
});
```

The default delay follows tRPC's WebSocket backoff: the first retry is
immediate, later attempts grow exponentially, and the delay caps at 30 seconds.
The default attempt count is unlimited. Production applications should usually
set an upper bound or a `shouldRetry` policy for permanent signaling and
authorization failures.

When an established channel fails:

1. sent queries and mutations fail with `TRPCClientError`;
2. active subscriptions remain registered when automatic reconnect is
   enabled;
3. the factory creates and negotiates a new channel;
4. subscriptions are sent again with their last tracked event ID;
5. observers receive a new `started` event and connection state returns to
   `pending`.

Queries and mutations are deliberately not replayed automatically. Place
`retryLink` before the WebRTC link when an operation is safe to retry. A
factory remains reusable by `retryLink` even when automatic subscription
reconnect is disabled.

## Tracked event recovery

A subscription that must recover without gaps should yield tRPC `tracked()`
events and accept an optional `lastEventId` input.

The transport retains an ID only after delivering its data to the tRPC client.
On replacement it sends that ID separately in the request; the server injects
it into object-like input before procedure validation. This matches tRPC's
WebSocket and retry-link behavior.

Recovery is at-least-once unless the application data source makes stronger
guarantees. Event IDs should be stable and ordered for the underlying stream,
and consumers should tolerate duplicate delivery around failures.

## Connection parameters

`connectionParams` is a string record or a function returning one. A function
is evaluated for every attempt, making it suitable for refreshed access
tokens.

```ts
const link = createWebRTCLink<AppRouter>({
  channel: createFreshChannel,
  connectionParams: () => ({
    authorization: `Bearer ${getAccessToken()}`,
  }),
});
```

The server receives the record in `createContext`. Connection parameters are
credentials, not peer identity by themselves; bind them to the authenticated
signaling participant and authorize procedures normally.

## Keep-alive

WebRTC and SCTP may remain apparently open after a remote process or network
path disappears. Protocol ping/pong health checks can detect that condition.

Client defaults when enabled are a 5-second interval and 1-second pong
deadline. Server defaults are 30 seconds and 5 seconds. Enabling both sides is
safe, though one side is often sufficient.

```ts
keepAlive: {
  enabled: true,
  intervalMs: 15_000,
  pongTimeoutMs: 5_000,
}
```

Any valid inbound traffic proves liveness and postpones the next ping. A
deadline failure closes the unusable channel and follows normal reconnect
policy.

## Server rotation

Call `handler.requestReconnect(reason)` before intentionally replacing a
server, peer connection, or authorization context. Factory-backed clients
replace the channel immediately; direct-channel clients fail their active
operations because they cannot create another channel.

The notification is per handler. An application serving many peers should keep
its own handler collection and notify each one during graceful shutdown.

## Lazy factories

`lazy: true` delays a channel factory until `connect()` or the first tRPC
operation. It does not defer negotiation of a direct channel. This distinction
prevents the server from timing out an already-open channel while an otherwise
idle client waits to make its first call.

## Cleanup ownership

`link.close()` removes transport listeners and rejects operations. It closes
the current channel only with `closeChannelOnDispose: true`. Failed and
replaced channels are always closed because they are no longer valid tRPC
connections.

`handler.close()` leaves its channel open by default; pass
`{ closeChannel: true }` during final peer cleanup.
