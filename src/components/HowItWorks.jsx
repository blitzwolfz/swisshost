import { CONFIG } from '../config.js';

// Expandable transparency section. Uses <details> so it's keyboard/D-pad
// reachable on TV browsers without JS.
export default function HowItWorks() {
  return (
    <details className="disclosure">
      <summary tabIndex={0}>How this works</summary>
      <div className="disclosure-body">
        <ol>
          <li>
            One person starts a session and gets a short code. The code lives on our
            signaling server for {CONFIG.roomCode.expiryMs / 60000} minutes or until it's
            used once — whichever comes first.
          </li>
          <li>
            The other person enters the code. Our server does nothing but pass the two
            browsers the technical handshake (network addresses) they need to find each
            other. It never sees your messages or files.
          </li>
          <li>
            Your two browsers connect <strong>directly</strong> to each other. They then
            perform a key exchange in-browser and encrypt everything with a shared key that
            never leaves either device.
          </li>
          <li>
            Chat and files travel over that direct link, encrypted end-to-end on top of
            WebRTC's own transport encryption.
          </li>
          <li>
            <em>Future fallback:</em> if a direct connection can't be made on a restrictive
            network, {CONFIG.siteName} may route the encrypted stream through a relay
            (TURN) server. Even then, the relay only forwards encrypted bytes — it still
            can't read your content. The status bar will show <strong>Relayed</strong>{' '}
            instead of <strong>Direct</strong>.
          </li>
        </ol>
      </div>
    </details>
  );
}
