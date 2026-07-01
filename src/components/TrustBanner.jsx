import { CONFIG } from '../config.js';

// Persistent trust statement — always visible.
export default function TrustBanner() {
  return (
    <div className="trust" role="note">
      <span className="lock">■ </span>
      This connection is <strong>peer-to-peer</strong> and{' '}
      <strong>end-to-end encrypted</strong>. {CONFIG.siteName} cannot see your files or
      messages.
    </div>
  );
}
