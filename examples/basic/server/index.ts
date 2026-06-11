import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  RTCPeerConnection,
  type RTCDataChannelEvent,
  type RTCIceCandidateInit,
  type RTCPeerConnectionIceEvent,
} from '@mertushka/webrtc-node';
import {
  createWebRTCHandler,
  type RTCDataChannelLike,
  type WebRTCHandler,
} from '@mertushka/trpc-webrtc-link';
import { WebSocketServer, type WebSocket } from 'ws';
import { appRouter } from '../shared/router.js';
import { parseSignalingMessage, type SignalingMessage } from '../shared/signaling.js';

const host = '127.0.0.1';
const port = 8787;
const httpServer = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json',
    });
    response.end('{"status":"ok"}');
    return;
  }

  response.writeHead(404);
  response.end();
});
const wss = new WebSocketServer({ server: httpServer });
const peers = new Set<{
  socket: WebSocket;
  peerConnection: RTCPeerConnection;
  handler?: WebRTCHandler;
}>();

function send(socket: WebSocket, message: SignalingMessage): void {
  socket.send(JSON.stringify(message));
}

wss.on('connection', (socket) => {
  const peerConnection = new RTCPeerConnection({ iceServers: [] });
  const peer = { socket, peerConnection } as {
    socket: WebSocket;
    peerConnection: RTCPeerConnection;
    handler?: WebRTCHandler;
  };
  peers.add(peer);

  const pendingCandidates: RTCIceCandidateInit[] = [];
  let hasRemoteDescription = false;

  peerConnection.addEventListener('icecandidate', (event) => {
    const candidate = (event as RTCPeerConnectionIceEvent).candidate;
    if (candidate) {
      send(socket, {
        type: 'candidate',
        candidate: candidate.toJSON(),
      });
    }
  });

  peerConnection.addEventListener('datachannel', (event) => {
    const channel = (event as RTCDataChannelEvent).channel;
    peer.handler = createWebRTCHandler({
      router: appRouter,
      channel: channel as RTCDataChannelLike,
      peer: {
        id: randomUUID(),
        peerConnection,
      },
      createContext({ peer: metadata }) {
        return {
          peerId: metadata.id,
        };
      },
      onError({ error, path }) {
        console.error('tRPC error', path, error);
      },
    });
  });

  socket.on('message', async (raw) => {
    try {
      const message = parseSignalingMessage(raw.toString());
      if (message.type === 'offer') {
        await peerConnection.setRemoteDescription(message);
        hasRemoteDescription = true;
        for (const candidate of pendingCandidates.splice(0)) {
          await peerConnection.addIceCandidate(candidate);
        }
        await peerConnection.setLocalDescription(await peerConnection.createAnswer());
        send(socket, {
          type: 'answer',
          sdp: peerConnection.localDescription!.sdp,
        });
        return;
      }
      if (message.type === 'candidate') {
        if (hasRemoteDescription) {
          await peerConnection.addIceCandidate(message.candidate);
        } else {
          pendingCandidates.push(message.candidate);
        }
      }
    } catch (error) {
      console.error('Signaling error', error);
      socket.close();
    }
  });

  socket.once('close', () => {
    peer.handler?.close();
    peerConnection.close();
    peers.delete(peer);
  });
});

function shutdown(): void {
  for (const peer of peers) {
    peer.handler?.close();
    peer.peerConnection.close();
    peer.socket.close();
  }
  wss.close();
  httpServer.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

httpServer.listen(port, host, () => {
  console.log(`Signaling server listening on ws://${host}:${port}`);
});
