// Connection-state bar: live/waiting/dead + Direct(P2P) vs Relayed.
export default function ConnectionStatus({ status, connectionType, role, code }) {
  let pill = { cls: 'wait', label: 'Waiting' };
  if (status === 'connected') pill = { cls: 'live', label: 'Connected' };
  else if (status === 'connecting') pill = { cls: 'wait', label: 'Connecting' };
  else if (status === 'waiting') pill = { cls: 'wait', label: 'Waiting for peer' };
  else if (status === 'failed' || status === 'closed')
    pill = { cls: 'dead', label: status === 'closed' ? 'Ended' : 'Failed' };

  return (
    <div className="status-bar">
      <span className={`pill ${pill.cls} ${status === 'connecting' ? 'blink' : ''}`}>
        ● {pill.label}
      </span>

      {status === 'connected' && (
        <span className="pill type" title="Selected ICE candidate pair type">
          {connectionType === 'relayed' ? 'Relayed' : 'Direct (P2P)'}
        </span>
      )}

      {role && <span className="dir">Role: {role}</span>}
      {code && status !== 'connected' && <span className="dir">Code: {code}</span>}
    </div>
  );
}
