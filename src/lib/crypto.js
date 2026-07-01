// ============================================================================
// End-to-end encryption primitives (Web Crypto API).
//
// Both peers generate an ephemeral ECDH (P-256) key pair, swap raw public keys
// over the already-DTLS-encrypted DataChannel, and derive a shared AES-GCM-256
// key. Every application payload after that is sealed with AES-GCM before being
// sent — so content is end-to-end encrypted on top of WebRTC's transport layer.
//
// Wire frame (both channels):  [ type:1 ][ iv:12 ][ AES-GCM ciphertext ]
//   type 0 = key exchange  -> body is the raw public key (NOT sealed; pre-key)
//   type 1 = chat text     -> sealed UTF-8 JSON  { text, ts }
//   type 2 = file meta     -> sealed UTF-8 JSON  { id, name, size, mime }
//   type 3 = file chunk    -> sealed raw bytes
//   type 4 = file end      -> sealed UTF-8 JSON  { id }
// ============================================================================

export const FRAME = {
  KEY: 0,
  CHAT: 1,
  FILE_META: 2,
  FILE_CHUNK: 3,
  FILE_END: 4,
};

const IV_BYTES = 12;
const enc = new TextEncoder();
const dec = new TextDecoder();

// --- ECDH -------------------------------------------------------------------

export async function generateKeyPair() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveKey',
  ]);
}

export async function exportPublicKey(publicKey) {
  // Raw uncompressed point (65 bytes for P-256).
  return crypto.subtle.exportKey('raw', publicKey);
}

export async function deriveSharedKey(privateKey, peerPublicRaw) {
  const peerPublic = await crypto.subtle.importKey(
    'raw',
    peerPublicRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPublic },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// --- AES-GCM seal / open ----------------------------------------------------

// Returns [iv:12][ciphertext] as a single Uint8Array.
export async function seal(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const out = new Uint8Array(IV_BYTES + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_BYTES);
  return out;
}

// Accepts [iv:12][ciphertext]; returns the plaintext ArrayBuffer.
export async function open(key, sealed) {
  const bytes = new Uint8Array(sealed);
  const iv = bytes.subarray(0, IV_BYTES);
  const ct = bytes.subarray(IV_BYTES);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
}

// --- Frame codec ------------------------------------------------------------

// Prepends the 1-byte type tag to an already-sealed (or raw, for KEY) body.
export function buildFrame(type, body) {
  const bodyBytes = new Uint8Array(body);
  const frame = new Uint8Array(1 + bodyBytes.byteLength);
  frame[0] = type;
  frame.set(bodyBytes, 1);
  return frame.buffer;
}

export function parseFrame(data) {
  const bytes = new Uint8Array(data);
  return { type: bytes[0], body: bytes.subarray(1) };
}

// Convenience: seal a JS object and wrap it in a typed frame.
export async function sealJsonFrame(key, type, obj) {
  const sealed = await seal(key, enc.encode(JSON.stringify(obj)));
  return buildFrame(type, sealed);
}

export async function openJson(key, body) {
  const plain = await open(key, body);
  return JSON.parse(dec.decode(plain));
}

export const bytes = { enc, dec };
