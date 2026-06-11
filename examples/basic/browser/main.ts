import { createTRPCClient, type TRPCClient } from '@trpc/client';
import {
  createWebRTCLink,
  type RTCDataChannelLike,
  type WebRTCLink,
} from '@mertushka/trpc-webrtc-link';
import type { Unsubscribable } from '@trpc/server/observable';
import type { AppRouter } from '../shared/router.js';
import { parseSignalingMessage, type SignalingMessage } from '../shared/signaling.js';
import './style.css';

const status = document.querySelector<HTMLParagraphElement>('#status')!;
const output = document.querySelector<HTMLPreElement>('#output')!;
const helloButton = document.querySelector<HTMLButtonElement>('#hello')!;
const incrementButton = document.querySelector<HTMLButtonElement>('#increment')!;
const clockButton = document.querySelector<HTMLButtonElement>('#clock')!;
const cancelButton = document.querySelector<HTMLButtonElement>('#cancel')!;

let client: TRPCClient<AppRouter> | undefined;
let link: WebRTCLink<AppRouter> | undefined;
let clockSubscription: Unsubscribable | undefined;

function log(value: unknown): void {
  output.textContent = `${output.textContent}${JSON.stringify(value, null, 2)}\n`;
}

function send(socket: WebSocket, message: SignalingMessage): void {
  socket.send(JSON.stringify(message));
}

async function connect(): Promise<void> {
  const socket = new WebSocket(`ws://${location.hostname}:8787`);
  const peerConnection = new RTCPeerConnection({ iceServers: [] });
  const channel = peerConnection.createDataChannel('trpc', {
    ordered: true,
  });
  const pendingCandidates: RTCIceCandidateInit[] = [];
  let hasRemoteDescription = false;

  peerConnection.addEventListener('icecandidate', (event) => {
    if (event.candidate) {
      send(socket, {
        type: 'candidate',
        candidate: event.candidate.toJSON(),
      });
    }
  });

  socket.addEventListener('message', async (event) => {
    const message = parseSignalingMessage(String(event.data));
    if (message.type === 'answer') {
      await peerConnection.setRemoteDescription(message);
      hasRemoteDescription = true;
      for (const candidate of pendingCandidates.splice(0)) {
        await peerConnection.addIceCandidate(candidate);
      }
      return;
    }
    if (message.type === 'candidate') {
      if (hasRemoteDescription) {
        await peerConnection.addIceCandidate(message.candidate);
      } else {
        pendingCandidates.push(message.candidate);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener(
      'open',
      () => {
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        reject(new Error('WebSocket signaling connection failed'));
      },
      { once: true },
    );
  });

  await peerConnection.setLocalDescription(await peerConnection.createOffer());
  send(socket, {
    type: 'offer',
    sdp: peerConnection.localDescription!.sdp,
  });

  await new Promise<void>((resolve, reject) => {
    channel.addEventListener(
      'open',
      () => {
        resolve();
      },
      { once: true },
    );
    channel.addEventListener(
      'error',
      () => {
        reject(new Error('RTCDataChannel failed to open'));
      },
      { once: true },
    );
  });

  link = createWebRTCLink<AppRouter>({
    channel: channel as RTCDataChannelLike,
  });
  client = createTRPCClient<AppRouter>({
    links: [link],
  });

  status.textContent = 'Connected';
  for (const button of [helloButton, incrementButton, clockButton]) {
    button.disabled = false;
  }
  log(await client.hello.query());
}

helloButton.addEventListener('click', async () => {
  log(await client!.hello.query());
});

incrementButton.addEventListener('click', async () => {
  log({
    counter: await client!.counter.increment.mutate(),
  });
});

clockButton.addEventListener('click', () => {
  clockSubscription?.unsubscribe();
  clockSubscription = client!.clock.subscribe(
    { intervalMs: 1_000 },
    {
      onStarted() {
        cancelButton.disabled = false;
        log('clock subscription started');
      },
      onData(value) {
        log({ clock: value });
      },
      onStopped() {
        cancelButton.disabled = true;
        log('clock subscription stopped');
      },
      onError(error) {
        log({ error: error.message });
      },
    },
  );
});

cancelButton.addEventListener('click', () => {
  clockSubscription?.unsubscribe();
  clockSubscription = undefined;
  cancelButton.disabled = true;
  log('clock subscription cancelled');
});

window.addEventListener('beforeunload', () => {
  clockSubscription?.unsubscribe();
  link?.close();
});

void connect().catch((error: unknown) => {
  status.textContent = 'Connection failed';
  log({
    error: error instanceof Error ? error.message : String(error),
  });
});
