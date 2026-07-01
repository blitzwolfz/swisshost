import { useEffect, useRef, useState } from 'react';

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// Encrypted real-time text chat over its own DataChannel.
export default function Chat({ messages, onSend, disabled }) {
  const [draft, setDraft] = useState('');
  const logRef = useRef(null);

  useEffect(() => {
    // Auto-scroll to newest.
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  const submit = (e) => {
    e.preventDefault();
    if (!draft.trim()) return;
    onSend(draft);
    setDraft('');
  };

  return (
    <div className="col chat-col-inner" style={{ flex: 1 }}>
      <div className="panel-title">Chat — encrypted</div>
      <div className="chat-log" ref={logRef} aria-live="polite">
        {messages.length === 0 ? (
          <div className="empty">No messages yet</div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`msg ${m.mine ? 'mine' : 'theirs'}`}>
              {m.text}
              <span className="ts">{fmtTime(m.ts)}</span>
            </div>
          ))
        )}
      </div>
      <form className="chat-input" onSubmit={submit}>
        <input
          className="text-field"
          placeholder={disabled ? 'Connect to chat…' : 'Type a message'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={disabled}
          aria-label="Chat message"
        />
        <button className="btn" type="submit" disabled={disabled || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
