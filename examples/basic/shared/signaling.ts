export interface SessionDescriptionSignal {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface IceCandidateSignal {
  type: 'candidate';
  candidate: RTCIceCandidateInit;
}

export type SignalingMessage = SessionDescriptionSignal | IceCandidateSignal;

export function parseSignalingMessage(value: string): SignalingMessage {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) {
    throw new Error('Invalid signaling message');
  }
  const message = parsed as Record<string, unknown>;
  if ((message.type === 'offer' || message.type === 'answer') && typeof message.sdp === 'string') {
    return message as unknown as SessionDescriptionSignal;
  }
  if (
    message.type === 'candidate' &&
    typeof message.candidate === 'object' &&
    message.candidate !== null
  ) {
    return message as unknown as IceCandidateSignal;
  }
  throw new Error('Invalid signaling message');
}
