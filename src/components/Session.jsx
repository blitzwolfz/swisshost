import { useState } from 'react';
import { CONFIG } from '../config.js';
import ConnectionStatus from './ConnectionStatus.jsx';
import Chat from './Chat.jsx';
import FileTransfer from './FileTransfer.jsx';

function failureMessage(reason) {
  switch (reason) {
    case 'timeout':
      return {
        title: "Couldn't establish a direct connection",
        body: "This usually means one side is on a network that blocks peer-to-peer connections — most often mobile data or a corporate/office/school Wi-Fi. Try again with both devices on a home Wi-Fi network. (A relay fallback is planned for a future version.)",
      };
    case 'room-expired':
      return { title: 'This code has expired', body: 'Room codes last 10 minutes or one use. Start a new session to get a fresh code.' };
    case 'room-already-used':
      return { title: 'This code was already used', body: 'Each code works once. Ask the host to start a new session.' };
    case 'room-not-found':
      return { title: 'No session found for that code', body: 'Double-check the code, or ask the host to start a new session.' };
    case 'peer-left':
      return { title: 'The other person disconnected', body: 'The session ended. Start or join a new one to reconnect.' };
    case 'signaling':
      return { title: "Couldn't reach the signaling server", body: 'Check your internet connection and try again.' };
    default:
      return { title: 'Connection ended', body: 'Start or join a new session to continue.' };
  }
}

export default function Session({
  status,
  role,
  code,
  connectionType,
  error,
  messages,
  transfers,
  incoming,
  onSend,
  onFiles,
  onLeave,
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable on TV browsers; code is shown regardless */
    }
  };

  const leave = () => {
    if (status === 'connected' || status === 'connecting') {
      const ok = window.confirm(
        'Leave this session? Chat and any in-progress transfers will be lost — nothing is saved anywhere.'
      );
      if (!ok) return;
    }
    onLeave();
  };

  const isConnected = status === 'connected';
  const isFail = status === 'failed' || status === 'closed';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <ConnectionStatus
        status={status}
        connectionType={connectionType}
        role={role}
        code={code}
      />

      {/* Host waiting room: show the code to share. */}
      {status === 'waiting' && role === 'host' && (
        <div className="panel" style={{ marginBottom: 'var(--safe)', textAlign: 'center' }}>
          <div className="panel-title" style={{ borderBottom: 'none' }}>
            Share this code — expires in {CONFIG.roomCode.expiryMs / 60000} min or on first use
          </div>
          <div className="code-display">{code}</div>
          <button className="btn secondary" onClick={copy}>
            {copied ? 'Copied ✓' : 'Copy code'}
          </button>
          <p className="empty" style={{ marginTop: '1rem' }}>
            Waiting for the other person to join…
          </p>
        </div>
      )}

      {status === 'connecting' && (
        <div className="panel" style={{ marginBottom: 'var(--safe)', textAlign: 'center' }}>
          <p className="empty" style={{ margin: 0 }}>
            Negotiating a direct, encrypted connection…
          </p>
        </div>
      )}

      {/* Failure / ended fallback. */}
      {isFail && (
        <div className="failbox">
          <h2>{failureMessage(error?.reason).title}</h2>
          <p>{failureMessage(error?.reason).body}</p>
          <button className="btn" onClick={onLeave} style={{ marginTop: '0.5rem' }}>
            Back to start
          </button>
        </div>
      )}

      {/* Live session: chat + files. */}
      {(isConnected || status === 'waiting' || status === 'connecting') && !isFail && (
        <div className="session-grid">
          <div className="chat-col" style={{ display: 'flex' }}>
            <Chat messages={messages} onSend={onSend} disabled={!isConnected} />
          </div>
          <div className="file-col" style={{ display: 'flex' }}>
            <FileTransfer
              onFiles={onFiles}
              transfers={transfers}
              incoming={incoming}
              disabled={!isConnected}
            />
          </div>
        </div>
      )}

      {!isFail && (
        <button className="btn secondary" onClick={leave} style={{ marginTop: 'var(--safe)' }}>
          Leave session
        </button>
      )}
    </div>
  );
}
