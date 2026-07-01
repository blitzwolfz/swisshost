import { useState } from 'react';
import { CONFIG } from '../config.js';
import HowItWorks from './HowItWorks.jsx';

// Landing view: start a session or join with a code.
export default function Home({ onStart, onJoin, starting }) {
  const [entry, setEntry] = useState('');

  const submitJoin = (e) => {
    e.preventDefault();
    const code = entry.trim().toUpperCase();
    if (code.length >= CONFIG.roomCode.length) onJoin(code);
  };

  return (
    <div className="hero">
      <h1>{CONFIG.siteName}</h1>
      <div className="sub">{CONFIG.tagline}</div>

      <div className="home-grid">
        {/* Start a session */}
        <div className="start-cell">
          <div className="cell-label">▸ Start a session</div>
          <p style={{ marginTop: 0 }}>
            Generate a one-time {CONFIG.roomCode.length}-character code and share it with the
            person you want to connect to.
          </p>
          <button className="btn block" onClick={onStart} disabled={starting}>
            {starting ? 'Starting…' : 'Start Session'}
          </button>
        </div>

        {/* Join a session */}
        <div className="join-cell">
          <div className="cell-label">▸ Join a session</div>
          <form className="join-form" onSubmit={submitJoin}>
            {/* Single large field — easier for TV on-screen keyboards. */}
            <input
              className="field"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={CONFIG.roomCode.length}
              placeholder={'•'.repeat(CONFIG.roomCode.length)}
              value={entry}
              onChange={(e) => setEntry(e.target.value.toUpperCase())}
              aria-label="Room code"
            />
            <button
              className="btn secondary block"
              type="submit"
              disabled={entry.trim().length < CONFIG.roomCode.length}
            >
              Join Session
            </button>
          </form>
        </div>
      </div>

      <div style={{ marginTop: 'var(--safe)' }}>
        <HowItWorks />
      </div>
    </div>
  );
}
