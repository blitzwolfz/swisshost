import { useRef, useState } from 'react';
import { CONFIG } from '../config.js';
import { humanSize } from '../lib/files.js';

function pct(n, d) {
  return Math.min(100, Math.floor((n / Math.max(d, 1)) * 100));
}

function TransferRow({ name, size, current, done, dir, url }) {
  const p = pct(current, size);
  return (
    <div className="transfer">
      <div className="row">
        <span className="fname" title={name}>
          {name}
        </span>
        <span>
          {humanSize(current)} / {humanSize(size)}
        </span>
      </div>
      <div className="progress">
        <div className={`bar ${done ? 'done' : ''}`} style={{ width: `${p}%` }} />
      </div>
      <div className="row" style={{ marginTop: '0.35rem', marginBottom: 0 }}>
        <span className="dir">
          {dir} {done ? '· complete' : `· ${p}%`}
        </span>
        {done && url && (
          <a className="dl-link" href={url} download={name}>
            Save
          </a>
        )}
      </div>
    </div>
  );
}

// Drag-and-drop / picker + queued transfers with per-file progress.
export default function FileTransfer({ onFiles, transfers, incoming, disabled }) {
  const inputRef = useRef(null);
  const [drag, setDrag] = useState(false);
  const [warn, setWarn] = useState(false);

  const handleFiles = (fileList) => {
    if (!fileList || fileList.length === 0) return;
    const big = Array.from(fileList).some((f) => f.size > CONFIG.file.softWarnBytes);
    setWarn(big);
    onFiles(fileList);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDrag(false);
    if (disabled) return;
    handleFiles(e.dataTransfer.files);
  };

  const openPicker = () => !disabled && inputRef.current?.click();
  const onKey = (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
      e.preventDefault();
      openPicker();
    }
  };

  return (
    <div className="col" style={{ flex: 1 }}>
      <div className="panel-title">Files — encrypted</div>

      <div
        className={`dropzone ${drag ? 'drag' : ''}`}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={openPicker}
        onKeyDown={onKey}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        <div className="dz-title">{disabled ? 'Connect to send files' : 'Drop files or select'}</div>
        <div className="dz-sub">Drag &amp; drop · or press to choose · multiple files OK</div>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {warn && (
        <div className="soft-warn">
          ⚠ One or more files are larger than {humanSize(CONFIG.file.softWarnBytes)}. Big
          transfers still work but may be slow over some connections.
        </div>
      )}

      <div className="transfer-list">
        {transfers.length === 0 && incoming.length === 0 && (
          <div className="empty">No transfers yet</div>
        )}
        {transfers.map((t) => (
          <TransferRow
            key={`out-${t.id}`}
            name={t.name}
            size={t.size}
            current={t.sent}
            done={t.done}
            dir="↑ Sending"
          />
        ))}
        {incoming.map((f) => (
          <TransferRow
            key={`in-${f.id}`}
            name={f.name}
            size={f.size}
            current={f.received}
            done={f.done}
            dir="↓ Receiving"
            url={f.url}
          />
        ))}
      </div>
    </div>
  );
}
