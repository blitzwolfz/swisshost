// ============================================================================
// useSession — the heart of the app. Orchestrates:
//   signaling (WebSocket) → WebRTC handshake → ECDH key exchange → encrypted
//   chat + file channels, plus connection-state + timeout handling.
//
// Everything content-related is AES-GCM sealed before leaving this hook; the
// signaling server only ever relays SDP/ICE.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { CONFIG } from '../config.js';
import * as signaling from './signaling.js';
import { createPeer, makeOffer, makeAnswer, acceptAnswer, addIce, getConnectionType } from './webrtc.js';
import {
  FRAME,
  generateKeyPair,
  exportPublicKey,
  deriveSharedKey,
  buildFrame,
  sealJsonFrame,
  parseFrame,
  openJson,
  open as aesOpen,
} from './crypto.js';
import { sendFile, FileReceiver, nextFileId } from './files.js';

// status: idle | creating | waiting | connecting | connected | failed | closed
export function useSession() {
  const [status, setStatus] = useState('idle');
  const [role, setRole] = useState(null);
  const [code, setCode] = useState(null);
  const [connectionType, setConnectionType] = useState(null);
  const [error, setError] = useState(null);
  const [messages, setMessages] = useState([]);
  const [transfers, setTransfers] = useState([]); // outgoing
  const [incoming, setIncoming] = useState([]);

  const pcRef = useRef(null);
  const sigRef = useRef(null);
  const chatRef = useRef(null);
  const fileRef = useRef(null);
  const keyPairRef = useRef(null);
  const sharedKeyRef = useRef(null);
  const chatOpenRef = useRef(false);
  const remoteSetRef = useRef(false);
  const pendingIceRef = useRef([]);
  const receiverRef = useRef(new FileReceiver());
  const timeoutRef = useRef(null);
  const queueRef = useRef([]);
  const sendingRef = useRef(false);

  // ---- helpers -------------------------------------------------------------

  const clearTimer = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  };

  const startTimer = useCallback(() => {
    clearTimer();
    timeoutRef.current = setTimeout(() => {
      // Only trip if we never reached the connected state.
      setStatus((s) => (s === 'connected' ? s : 'failed'));
      setError((e) => e || { reason: 'timeout' });
    }, CONFIG.connectionTimeoutMs);
  }, []);

  const maybeReady = useCallback(async () => {
    if (chatOpenRef.current && sharedKeyRef.current) {
      clearTimer();
      setStatus('connected');
      // Classify Direct vs Relayed once the pair settles.
      const type = await getConnectionType(pcRef.current);
      if (type) setConnectionType(type);
      setTimeout(async () => {
        const t = await getConnectionType(pcRef.current);
        if (t) setConnectionType(t);
      }, 1500);
    }
  }, []);

  // ---- incoming frame handling --------------------------------------------

  const onChatFrame = useCallback(
    async (data) => {
      const { type, body } = parseFrame(data);
      if (type === FRAME.KEY) {
        // Peer's raw ECDH public key → derive the shared AES-GCM key.
        sharedKeyRef.current = await deriveSharedKey(keyPairRef.current.privateKey, body);
        maybeReady();
        return;
      }
      if (!sharedKeyRef.current) return;
      if (type === FRAME.CHAT) {
        const msg = await openJson(sharedKeyRef.current, body);
        setMessages((m) => [...m, { id: `r${Date.now()}${Math.random()}`, mine: false, text: msg.text, ts: msg.ts }]);
      }
    },
    [maybeReady]
  );

  const onFileFrame = useCallback(async (data) => {
    const key = sharedKeyRef.current;
    if (!key) return;
    const { type, body } = parseFrame(data);

    if (type === FRAME.FILE_META) {
      const meta = await openJson(key, body);
      receiverRef.current.begin(meta);
      setIncoming((list) => [
        ...list,
        { id: meta.id, name: meta.name, size: meta.size, received: 0, done: false, url: null },
      ]);
    } else if (type === FRAME.FILE_CHUNK) {
      const plain = await aesOpen(key, body);
      const id = receiverRef.current.currentId();
      const prog = receiverRef.current.chunk(id, new Uint8Array(plain));
      if (prog) {
        setIncoming((list) =>
          list.map((f) =>
            f.id === id ? { ...f, received: prog.received } : f
          )
        );
      }
    } else if (type === FRAME.FILE_END) {
      const { id } = await openJson(key, body);
      const result = receiverRef.current.end(id);
      if (result) {
        setIncoming((list) =>
          list.map((f) =>
            f.id === id ? { ...f, received: f.size, done: true, url: result.url } : f
          )
        );
      }
    }
  }, []);

  // ---- channel wiring ------------------------------------------------------

  const wireChannel = useCallback(
    (label, channel) => {
      if (label === 'chat') {
        chatRef.current = channel;
        channel.onopen = async () => {
          chatOpenRef.current = true;
          // Send our raw public key as the first (unsealed) KEY frame.
          const raw = await exportPublicKey(keyPairRef.current.publicKey);
          channel.send(buildFrame(FRAME.KEY, raw));
          maybeReady();
        };
        channel.onmessage = (e) => onChatFrame(e.data);
      } else if (label === 'file') {
        fileRef.current = channel;
        channel.onmessage = (e) => onFileFrame(e.data);
      }
    },
    [maybeReady, onChatFrame, onFileFrame]
  );

  const wirePeer = useCallback(
    (isInitiator) => {
      const pc = createPeer({
        isInitiator,
        onIceCandidate: (candidate) => sigRef.current?.send({ type: 'ice', candidate }),
        onChannel: wireChannel,
        onStateChange: (state) => {
          if (state === 'failed' || state === 'disconnected') {
            setStatus((s) => (s === 'connected' ? s : 'failed'));
          }
        },
      });
      pcRef.current = pc;
      return pc;
    },
    [wireChannel]
  );

  const flushPendingIce = useCallback(async () => {
    remoteSetRef.current = true;
    const pending = pendingIceRef.current;
    pendingIceRef.current = [];
    for (const c of pending) await addIce(pcRef.current, c);
  }, []);

  // ---- signaling message handling -----------------------------------------

  const handleSignal = useCallback(
    async (msg) => {
      const pc = pcRef.current;
      switch (msg.type) {
        case 'peer-joined': {
          // Host side: guest is present → become initiator and offer.
          const peer = wirePeer(true);
          setStatus('connecting');
          startTimer();
          const offer = await makeOffer(peer);
          sigRef.current?.send({ type: 'offer', offer });
          break;
        }
        case 'offer': {
          // Guest side: create answerer, reply, flush any buffered ICE.
          const peer = wirePeer(false);
          setStatus('connecting');
          startTimer();
          const answer = await makeAnswer(peer, msg.offer);
          await flushPendingIce();
          sigRef.current?.send({ type: 'answer', answer });
          break;
        }
        case 'answer':
          await acceptAnswer(pc, msg.answer);
          await flushPendingIce();
          break;
        case 'ice':
          if (pc && remoteSetRef.current) await addIce(pc, msg.candidate);
          else pendingIceRef.current.push(msg.candidate);
          break;
        case 'peer-left':
          setStatus((s) => (s === 'connected' ? 'closed' : s));
          setError((e) => e || { reason: 'peer-left' });
          break;
        case 'room-expired':
          setStatus('failed');
          setError({ reason: 'room-expired' });
          break;
        case 'error':
          setStatus('failed');
          setError({ reason: msg.reason });
          break;
        default:
          break;
      }
    },
    [wirePeer, startTimer, flushPendingIce]
  );

  // ---- public actions ------------------------------------------------------

  const startSession = useCallback(async () => {
    setError(null);
    setRole('host');
    setStatus('creating');
    keyPairRef.current = await generateKeyPair();
    try {
      const { code: roomCode } = await signaling.createRoom();
      setCode(roomCode);
      setStatus('waiting');
      sigRef.current = signaling.connect(roomCode, 'host', {
        onMessage: handleSignal,
        onClose: () => {},
        onError: () => {
          setStatus((s) => (s === 'connected' ? s : 'failed'));
          setError((e) => e || { reason: 'signaling' });
        },
      });
    } catch {
      setStatus('failed');
      setError({ reason: 'signaling' });
    }
  }, [handleSignal]);

  const joinSession = useCallback(
    async (roomCode) => {
      setError(null);
      setRole('guest');
      setCode(roomCode);
      setStatus('connecting');
      startTimer();
      keyPairRef.current = await generateKeyPair();
      sigRef.current = signaling.connect(roomCode, 'guest', {
        onMessage: handleSignal,
        onClose: (reason) => {
          if (reason && reason !== 'closed') {
            setStatus((s) => (s === 'connected' ? s : 'failed'));
            setError((e) => e || { reason });
          }
        },
        onError: () => {
          setStatus((s) => (s === 'connected' ? s : 'failed'));
          setError((e) => e || { reason: 'signaling' });
        },
      });
    },
    [handleSignal, startTimer]
  );

  const sendMessage = useCallback(async (text) => {
    const key = sharedKeyRef.current;
    const channel = chatRef.current;
    if (!key || !channel || channel.readyState !== 'open' || !text.trim()) return;
    const ts = Date.now();
    channel.send(await sealJsonFrame(key, FRAME.CHAT, { text, ts }));
    setMessages((m) => [...m, { id: `m${ts}${Math.random()}`, mine: true, text, ts }]);
  }, []);

  const processQueue = useCallback(async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    const key = sharedKeyRef.current;
    const channel = fileRef.current;
    while (queueRef.current.length && key && channel && channel.readyState === 'open') {
      const { file, id } = queueRef.current.shift();
      const meta = { id, name: file.name, size: file.size, mime: file.type };
      let lastPct = -1;
      await sendFile(channel, key, file, meta, {
        onProgress: (sent) => {
          const pct = Math.floor((sent / Math.max(file.size, 1)) * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            setTransfers((list) => list.map((t) => (t.id === id ? { ...t, sent } : t)));
          }
        },
      });
      setTransfers((list) => list.map((t) => (t.id === id ? { ...t, sent: file.size, done: true } : t)));
    }
    sendingRef.current = false;
  }, []);

  const sendFiles = useCallback(
    (fileList) => {
      const files = Array.from(fileList);
      const records = files.map((file) => {
        const id = nextFileId();
        queueRef.current.push({ file, id });
        return { id, name: file.name, size: file.size, sent: 0, done: false };
      });
      setTransfers((list) => [...list, ...records]);
      processQueue();
    },
    [processQueue]
  );

  const cleanup = useCallback(() => {
    clearTimer();
    try {
      chatRef.current?.close();
    } catch {}
    try {
      fileRef.current?.close();
    } catch {}
    try {
      pcRef.current?.close();
    } catch {}
    sigRef.current?.close();
    incoming.forEach((f) => f.url && URL.revokeObjectURL(f.url));
    pcRef.current = null;
    sigRef.current = null;
    chatRef.current = null;
    fileRef.current = null;
    sharedKeyRef.current = null;
    chatOpenRef.current = false;
    remoteSetRef.current = false;
    pendingIceRef.current = [];
    queueRef.current = [];
    sendingRef.current = false;
    receiverRef.current = new FileReceiver();
  }, [incoming]);

  const leaveSession = useCallback(() => {
    cleanup();
    setStatus('idle');
    setRole(null);
    setCode(null);
    setConnectionType(null);
    setError(null);
    setMessages([]);
    setTransfers([]);
    setIncoming([]);
  }, [cleanup]);

  // Warn before leaving mid-session (chat/files not persisted anywhere).
  useEffect(() => {
    const active = status === 'connected' || status === 'connecting' || status === 'waiting';
    if (!active) return;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [status]);

  useEffect(() => () => cleanup(), []); // unmount

  return {
    status,
    role,
    code,
    connectionType,
    error,
    messages,
    transfers,
    incoming,
    startSession,
    joinSession,
    sendMessage,
    sendFiles,
    leaveSession,
  };
}
