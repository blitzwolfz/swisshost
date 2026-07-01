import { useState } from 'react';
import { CONFIG } from './config.js';
import { useSession } from './lib/useSession.js';
import TrustBanner from './components/TrustBanner.jsx';
import NetworkNotice from './components/NetworkNotice.jsx';
import Home from './components/Home.jsx';
import Session from './components/Session.jsx';

export default function App() {
  const s = useSession();
  const [noticeDismissed, setNoticeDismissed] = useState(false);

  const onHome = s.status === 'idle' || s.status === 'creating';
  const showNotice = !noticeDismissed && s.status !== 'connected';

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">{CONFIG.siteName}</div>
        <div className="tag">{CONFIG.tagline}</div>
      </header>

      <TrustBanner />

      {showNotice && <NetworkNotice onDismiss={() => setNoticeDismissed(true)} />}

      {onHome ? (
        <Home onStart={s.startSession} onJoin={s.joinSession} starting={s.status === 'creating'} />
      ) : (
        <Session
          status={s.status}
          role={s.role}
          code={s.code}
          connectionType={s.connectionType}
          error={s.error}
          messages={s.messages}
          transfers={s.transfers}
          incoming={s.incoming}
          onSend={s.sendMessage}
          onFiles={s.sendFiles}
          onLeave={s.leaveSession}
        />
      )}

      <div className="footer">
        {CONFIG.siteName} · {CONFIG.domain} · no accounts · no logs · nothing stored
      </div>
    </div>
  );
}
