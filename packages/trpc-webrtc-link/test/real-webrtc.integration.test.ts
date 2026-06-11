import { setTimeout as delay } from 'node:timers/promises';
import { createTRPCClient } from '@trpc/client';
import {
  RTCPeerConnection,
  type RTCDataChannel,
  type RTCDataChannelEvent,
} from '@mertushka/webrtc-node';
import { afterEach, describe, expect, it } from 'vitest';
import superjson from 'superjson';
import {
  createWebRTCHandler,
  createWebRTCLink,
  type RTCDataChannelLike,
  type WebRTCHandler,
} from '../src/index.js';
import { testRouter, type TestRouter, type TestState } from './test-utils.js';

async function waitForIceGatheringComplete(peerConnection: RTCPeerConnection): Promise<void> {
  if (peerConnection.iceGatheringState === 'complete') {
    return;
  }
  await new Promise<void>((resolve) => {
    const onChange = () => {
      if (peerConnection.iceGatheringState === 'complete') {
        peerConnection.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
    };
    peerConnection.addEventListener('icegatheringstatechange', onChange);
  });
}

async function waitForOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === 'open') {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      channel.removeEventListener('open', onOpen);
      channel.removeEventListener('close', onClose);
      channel.removeEventListener('error', onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Data channel closed before opening'));
    };
    const onError = () => {
      cleanup();
      reject(new Error('Data channel failed before opening'));
    };
    channel.addEventListener('open', onOpen);
    channel.addEventListener('close', onClose);
    channel.addEventListener('error', onError);
  });
}

async function createRealChannelPair(): Promise<{
  clientPeer: RTCPeerConnection;
  serverPeer: RTCPeerConnection;
  clientChannel: RTCDataChannel;
  serverChannel: RTCDataChannel;
}> {
  const clientPeer = new RTCPeerConnection({ iceServers: [] });
  const serverPeer = new RTCPeerConnection({ iceServers: [] });
  const clientChannel = clientPeer.createDataChannel('trpc', {
    ordered: true,
  });
  const serverChannelPromise = new Promise<RTCDataChannel>((resolve) => {
    serverPeer.addEventListener('datachannel', (event) => {
      resolve((event as RTCDataChannelEvent).channel);
    });
  });

  await clientPeer.setLocalDescription(await clientPeer.createOffer());
  await waitForIceGatheringComplete(clientPeer);
  await serverPeer.setRemoteDescription(clientPeer.localDescription!);

  await serverPeer.setLocalDescription(await serverPeer.createAnswer());
  await waitForIceGatheringComplete(serverPeer);
  await clientPeer.setRemoteDescription(serverPeer.localDescription!);

  const serverChannel = await serverChannelPromise;
  await Promise.all([waitForOpen(clientChannel), waitForOpen(serverChannel)]);
  return {
    clientPeer,
    serverPeer,
    clientChannel,
    serverChannel,
  };
}

describe('real @mertushka/webrtc-node integration', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('runs queries, mutations, subscriptions, and cancellation over SCTP', async () => {
    const pair = await Promise.race([
      createRealChannelPair(),
      delay(10_000).then(() => {
        throw new Error('Timed out creating real WebRTC peers');
      }),
    ]);
    const state: TestState = {
      counter: 0,
      contextCreations: 0,
      subscriptionCancellations: 0,
      queryCancellations: 0,
    };

    const handler: WebRTCHandler = createWebRTCHandler({
      router: testRouter,
      channel: pair.serverChannel as RTCDataChannelLike,
      peer: pair.serverPeer,
      createContext() {
        state.contextCreations += 1;
        return {
          state,
          peerName: 'real-peer',
        };
      },
    });
    const link = createWebRTCLink<TestRouter>({
      channel: pair.clientChannel as RTCDataChannelLike,
      transformer: superjson,
    });
    const client = createTRPCClient<TestRouter>({
      links: [link],
    });

    cleanup = () => {
      link.close();
      handler.close();
      pair.clientChannel.close();
      pair.serverChannel.close();
      pair.clientPeer.close();
      pair.serverPeer.close();
    };

    await expect(client.hello.query({ name: 'Node' })).resolves.toBe('hello Node from real-peer');
    await expect(client.counter.increment.mutate(4)).resolves.toBe(4);

    const values: number[] = [];
    await new Promise<void>((resolve, reject) => {
      client.clock.subscribe(
        { count: 3, waitMs: 1 },
        {
          onData(value) {
            values.push(value);
          },
          onError: reject,
          onComplete: resolve,
        },
      );
    });
    expect(values).toEqual([0, 1, 2]);

    const subscription = client.clock.subscribe(
      { count: 100, waitMs: 5 },
      {
        onData() {
          subscription.unsubscribe();
        },
      },
    );
    await expect(
      Promise.race([
        handler.ready,
        delay(2_000).then(() => {
          throw new Error('Handler did not become ready');
        }),
      ]),
    ).resolves.toBeUndefined();

    const deadline = Date.now() + 2_000;
    while (state.subscriptionCancellations !== 1 && Date.now() < deadline) {
      await delay(5);
    }
    expect(state.subscriptionCancellations).toBe(1);
    expect(state.contextCreations).toBe(1);
  }, 20_000);
});
