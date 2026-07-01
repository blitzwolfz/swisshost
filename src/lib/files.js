// ============================================================================
// Chunked file transfer over the dedicated "file" DataChannel.
//
// Protocol per file (all frames AES-GCM sealed except the type byte):
//   FILE_META  { id, name, size, mime }
//   FILE_CHUNK <raw bytes>      × N
//   FILE_END   { id }
//
// Sending respects DataChannel backpressure via bufferedAmount so we don't
// blow up memory on TVs / low-end devices.
// ============================================================================

import { CONFIG } from '../config.js';
import { FRAME, seal, buildFrame, sealJsonFrame } from './crypto.js';

let idCounter = 0;
export function nextFileId() {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter}`;
}

function waitForDrain(channel) {
  return new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = CONFIG.file.bufferedLowWater;
    const onLow = () => {
      channel.removeEventListener('bufferedamountlow', onLow);
      resolve();
    };
    channel.addEventListener('bufferedamountlow', onLow);
  });
}

// Sends one File over `channel`, sealing every frame with `key`.
// `onProgress(sentBytes)` is called as chunks flush. Returns when done.
export async function sendFile(channel, key, file, meta, { onProgress, shouldCancel } = {}) {
  const { chunkSize, bufferedHighWater } = CONFIG.file;

  // 1. Metadata frame.
  channel.send(await sealJsonFrame(key, FRAME.FILE_META, meta));

  // 2. Chunk frames.
  let offset = 0;
  while (offset < file.size) {
    if (shouldCancel?.()) return false;

    if (channel.bufferedAmount > bufferedHighWater) {
      await waitForDrain(channel);
    }

    const slice = file.slice(offset, offset + chunkSize);
    const buf = await slice.arrayBuffer();
    const sealed = await seal(key, buf);
    channel.send(buildFrame(FRAME.FILE_CHUNK, sealed));

    offset += buf.byteLength;
    onProgress?.(offset);
  }

  // 3. End frame.
  channel.send(await sealJsonFrame(key, FRAME.FILE_END, { id: meta.id }));
  return true;
}

// Reassembles incoming chunks per file id.
export class FileReceiver {
  constructor() {
    this.active = new Map(); // id -> { meta, chunks[], received }
  }

  begin(meta) {
    this.active.set(meta.id, { meta, chunks: [], received: 0 });
  }

  chunk(id, bytes) {
    const rec = this.active.get(id);
    if (!rec) return null;
    rec.chunks.push(bytes);
    rec.received += bytes.byteLength;
    return { received: rec.received, size: rec.meta.size };
  }

  // Returns { meta, blob, url } and frees the buffers.
  end(id) {
    const rec = this.active.get(id);
    if (!rec) return null;
    const blob = new Blob(rec.chunks, {
      type: rec.meta.mime || 'application/octet-stream',
    });
    const url = URL.createObjectURL(blob);
    this.active.delete(id);
    return { meta: rec.meta, blob, url };
  }

  // The most recently begun (still-open) transfer id, used to route chunks
  // since only one file streams at a time per channel.
  currentId() {
    const keys = [...this.active.keys()];
    return keys[keys.length - 1] || null;
  }
}

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
