import { useEffect, useState } from "react";

/**
 * Play a gentle two-tone transit chime using the Web Audio API (no external audio assets).
 * Works across desktop, Android, and iOS Safari once triggered after a user tap.
 */
export function playStopAlertChime(): void {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const notes = [
      { freq: 659.25, start: 0, dur: 0.18 }, // E5
      { freq: 880.0, start: 0.2, dur: 0.28 }, // A5
    ];
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(n.freq, now + n.start);
      gain.gain.setValueAtTime(0.001, now + n.start);
      gain.gain.exponentialRampToValueAtTime(0.18, now + n.start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + n.start + n.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + n.start);
      osc.stop(now + n.start + n.dur + 0.02);
    }
    setTimeout(() => {
      void ctx.close().catch(() => undefined);
    }, 700);
  } catch {
    // Audio playback blocked or unavailable
  }
}

export async function requestStopNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted" || Notification.permission === "denied") {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

export function triggerStopAlert(input: { stopName: string; status: "current" | "next"; routeLabel?: string }): void {
  // 1. Haptic vibration (Android & supporting browsers)
  if ("vibrate" in navigator) {
    try {
      navigator.vibrate([220, 100, 220, 100, 280]);
    } catch {
      // ignore
    }
  }

  // 2. Pleasant two-tone audio chime (works on iOS Safari & desktop too)
  playStopAlertChime();

  // 3. System / Lock-Screen Notification if granted
  if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
    try {
      const title =
        input.status === "current"
          ? `Arriving now: ${input.stopName}`
          : `Next stop: ${input.stopName}`;
      const body = input.routeLabel
        ? `Get ready to exit Route ${input.routeLabel}.`
        : "Get ready to exit at the upcoming stop.";
      new Notification(title, {
        body,
        icon: "/icons/icon-192.png",
        tag: `swisshost-stop-${input.stopName}`,
      });
    } catch {
      // ignore
    }
  }
}

/**
 * Keep the screen awake using the Screen Wake Lock API while On-Board / Active Trip mode is open.
 */
export function useWakeLock(active: boolean): { awake: boolean } {
  const [awake, setAwake] = useState(false);

  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) {
      setAwake(false);
      return;
    }

    let released = false;
    let sentinel: { release: () => Promise<void> } | null = null;

    const acquire = async () => {
      try {
        const wl = (navigator as unknown as { wakeLock: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        sentinel = await wl.request("screen");
        if (!released) setAwake(true);
      } catch {
        setAwake(false);
      }
    };

    void acquire();

    const onVis = () => {
      if (!document.hidden && !released) {
        void acquire();
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVis);
      setAwake(false);
      if (sentinel) void sentinel.release().catch(() => undefined);
    };
  }, [active]);

  return { awake };
}
