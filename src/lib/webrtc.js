// ============================================================================
// WebRTC layer — RTCPeerConnection + the two DataChannels.
//
//  - "chat" channel: text messages + the ECDH public-key exchange.
//  - "file" channel: chunked file transfer. Separate channel so a large file
//    can never head-of-line-block a chat message.
//
// The HOST is the initiator: it creates both channels and the SDP offer. The
// GUEST answers and receives channels via `ondatachannel`.
// ============================================================================

import { RTC_CONFIG } from '../config.js';

export function createPeer({ isInitiator, onIceCandidate, onChannel, onStateChange }) {
  const pc = new RTCPeerConnection(RTC_CONFIG);

  pc.onicecandidate = (e) => {
    if (e.candidate) onIceCandidate(e.candidate);
  };
  pc.onconnectionstatechange = () => onStateChange?.(pc.connectionState);
  pc.oniceconnectionstatechange = () => onStateChange?.(pc.connectionState);

  if (isInitiator) {
    const chat = pc.createDataChannel('chat', { ordered: true });
    const file = pc.createDataChannel('file', { ordered: true });
    chat.binaryType = 'arraybuffer';
    file.binaryType = 'arraybuffer';
    onChannel('chat', chat);
    onChannel('file', file);
  } else {
    pc.ondatachannel = (e) => {
      e.channel.binaryType = 'arraybuffer';
      onChannel(e.channel.label, e.channel);
    };
  }

  return pc;
}

export async function makeOffer(pc) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  return offer;
}

export async function makeAnswer(pc, offer) {
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return answer;
}

export async function acceptAnswer(pc, answer) {
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
}

export async function addIce(pc, candidate) {
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch {
    // Candidates can arrive before remote description in edge cases; ignore.
  }
}

// Inspects the selected ICE candidate pair to classify the connection.
// Returns 'direct' (host/srflx/prflx) or 'relayed' (relay) or null.
export async function getConnectionType(pc) {
  try {
    const stats = await pc.getStats();
    let selectedPairId = null;
    const pairs = new Map();
    const local = new Map();

    stats.forEach((report) => {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        selectedPairId = report.selectedCandidatePairId;
      }
      if (report.type === 'candidate-pair') pairs.set(report.id, report);
      if (report.type === 'local-candidate') local.set(report.id, report);
    });

    // Fallback: some engines don't expose transport.selectedCandidatePairId.
    let pair = selectedPairId ? pairs.get(selectedPairId) : null;
    if (!pair) {
      pairs.forEach((p) => {
        if (p.selected || p.state === 'succeeded') pair = pair || p;
      });
    }
    if (!pair) return null;

    const localCand = local.get(pair.localCandidateId);
    const type = localCand?.candidateType;
    if (!type) return null;
    return type === 'relay' ? 'relayed' : 'direct';
  } catch {
    return null;
  }
}
