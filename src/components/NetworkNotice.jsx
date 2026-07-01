// Dismissible network-limitations warning shown before/during connection setup.
export default function NetworkNotice({ onDismiss }) {
  return (
    <div className="notice" role="note">
      <div className="notice-body">
        <strong>Best on home Wi-Fi.</strong> Mobile data networks and corporate/office
        Wi-Fi often block the direct connections this app needs, and the transfer may fail
        to connect.
      </div>
      <button className="dismiss" onClick={onDismiss} aria-label="Dismiss notice">
        ✕
      </button>
    </div>
  );
}
