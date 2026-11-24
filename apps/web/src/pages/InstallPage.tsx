import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Download, Share, Smartphone } from "lucide-react";
import { usePwaInstall, type PwaPlatform } from "../hooks/usePwaInstall";

export default function InstallPage() {
  const { platform, isStandalone, canPrompt, promptInstall } = usePwaInstall();
  const [selectedTab, setSelectedTab] = useState<PwaPlatform>(platform);
  const [installOutcome, setInstallOutcome] = useState<string | null>(null);

  const handleInstall = async () => {
    const res = await promptInstall();
    if (res === "accepted") {
      setInstallOutcome("Swisshost was installed. You can now launch it from your home screen or dock.");
    } else if (res === "dismissed") {
      setInstallOutcome("Install prompt dismissed — you can run it again anytime or follow the manual steps below.");
    }
  };

  return (
    <div className="sh-page sh-page-narrow">
      <div className="sh-page-head">
        <div>
          <p className="sh-kicker">
            <Link to="/">Map</Link> / Install
          </p>
          <h1 className="sh-title sh-title-sm">Save as an App</h1>
          <p className="sh-lede">
            Install Swisshost to your home screen or desktop dock as a standalone Progressive Web App — no app store
            required, instant launch, and offline access to your favourites and recently viewed routes and stops.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {isStandalone ? (
            <span className="sh-pill sh-pill-ok">
              <Check size={14} /> Already installed
            </span>
          ) : canPrompt ? (
            <button type="button" className="sh-btn sh-btn-primary" onClick={handleInstall}>
              <Download size={15} /> Install Swisshost
            </button>
          ) : (
            <span className="sh-pill sh-pill-muted">
              <Smartphone size={13} /> Detected: {platform === "ios" ? "iPhone / iPad" : platform === "android" ? "Android" : "Desktop"}
            </span>
          )}
        </div>
      </div>

      {installOutcome && (
        <div
          role="status"
          className="p-4 text-sm font-medium border-2"
          style={{ borderColor: "var(--ink)", background: "var(--surface)" }}
        >
          {installOutcome}
        </div>
      )}

      {isStandalone && (
        <div
          className="p-4 text-sm border-2 flex items-center gap-3"
          style={{ borderColor: "var(--ink)", background: "var(--surface)" }}
        >
          <Check size={18} style={{ color: "var(--status-ok)" }} />
          <span>You are already running Swisshost in standalone app mode.</span>
        </div>
      )}

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="sh-section-title m-0 border-0 pb-0">Installation steps</h2>
          <div role="tablist" aria-label="Choose device" className="sh-seg">
            {(
              [
                ["ios", "iPhone / iPad"],
                ["android", "Android"],
                ["desktop", "Desktop"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={selectedTab === key}
                aria-pressed={selectedTab === key}
                onClick={() => setSelectedTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {selectedTab === "ios" && (
          <div className="sh-card p-6 space-y-4">
            <div className="font-bold text-base">iPhone &amp; iPad (Safari)</div>
            <ol className="m-0 pl-5 space-y-3 text-sm">
              <li>
                Open <strong>swisshost.cc</strong> in <strong>Safari</strong> (iOS only lets Safari install web apps
                to the Home Screen; if you opened this link in an in-app browser, tap the compass icon to open in Safari).
              </li>
              <li>
                Tap the{" "}
                <span className="inline-flex items-center gap-1 font-semibold">
                  <Share size={14} /> Share
                </span>{" "}
                button in Safari&apos;s toolbar (bottom bar on iPhone, top-right on iPad).
              </li>
              <li>
                Scroll down the share sheet and tap <strong>Add to Home Screen</strong>.
              </li>
              <li>
                Confirm the name <strong>Swisshost</strong> and tap <strong>Add</strong> in the top-right corner.
              </li>
            </ol>
          </div>
        )}

        {selectedTab === "android" && (
          <div className="sh-card p-6 space-y-4">
            <div className="font-bold text-base">Android (Chrome, Edge, or Brave)</div>
            {canPrompt && (
              <div>
                <button type="button" className="sh-btn sh-btn-primary" onClick={handleInstall}>
                  <Download size={15} /> Install Swisshost now
                </button>
              </div>
            )}
            <ol className="m-0 pl-5 space-y-3 text-sm">
              <li>
                Open <strong>swisshost.cc</strong> in <strong>Chrome</strong> (or Edge / Brave).
              </li>
              <li>
                Tap the <strong>⋮ menu</strong> button in the top-right corner of the browser.
              </li>
              <li>
                Tap <strong>Add to Home screen</strong> or <strong>Install app</strong>.
              </li>
              <li>
                Confirm <strong>Install</strong>. Swisshost will appear alongside your native apps with full-screen
                navigation.
              </li>
            </ol>
          </div>
        )}

        {selectedTab === "desktop" && (
          <div className="sh-card p-6 space-y-5">
            {canPrompt && (
              <div>
                <button type="button" className="sh-btn sh-btn-primary" onClick={handleInstall}>
                  <Download size={15} /> Install Swisshost now
                </button>
              </div>
            )}
            <div className="space-y-2">
              <div className="font-bold text-base">Chrome, Edge, or Brave (macOS / Windows / Linux)</div>
              <ol className="m-0 pl-5 space-y-2 text-sm">
                <li>
                  Click the <strong>Install icon</strong> (monitor with a downward arrow) on the right side of the
                  address bar — or open the browser menu and select <strong>Cast, save, and share → Install Swisshost</strong>.
                </li>
                <li>
                  Click <strong>Install</strong> to open Swisshost in its own app window and pin it to your Dock or
                  Start Menu.
                </li>
              </ol>
            </div>
            <div className="space-y-2 pt-4 border-t" style={{ borderColor: "var(--border)" }}>
              <div className="font-bold text-base">Safari on macOS (Sonoma or newer)</div>
              <ol className="m-0 pl-5 space-y-2 text-sm">
                <li>
                  In the top menu bar, click <strong>File → Add to Dock…</strong> (or click the Share button in the
                  toolbar and choose <strong>Add to Dock</strong>).
                </li>
                <li>
                  Click <strong>Add</strong> to keep Swisshost in your macOS Dock.
                </li>
              </ol>
            </div>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="sh-section-title">What works offline</h2>
        <div className="sh-table-wrap">
          <table className="sh-table">
            <thead>
              <tr>
                <th>Feature</th>
                <th>Offline behaviour</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="font-semibold">App shell &amp; favourites</td>
                <td>Available immediately offline from local cache.</td>
              </tr>
              <tr>
                <td className="font-semibold">Recently viewed routes &amp; stops</td>
                <td>Cached from your last synced visit and clearly marked when offline.</td>
              </tr>
              <tr>
                <td className="font-semibold">Live GPS positions &amp; departures</td>
                <td>Requires an active network connection; stale data is never labelled as live.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
