import { useEffect, useState } from "react";

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export type PwaPlatform = "ios" | "android" | "desktop";

function detectPlatform(): PwaPlatform {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent || "";
  const isIos =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIos) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const mq = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return mq || iosStandalone;
}

let cachedDeferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    cachedDeferredPrompt = e as BeforeInstallPromptEvent;
    for (const fn of listeners) fn();
  });
  window.addEventListener("appinstalled", () => {
    cachedDeferredPrompt = null;
    for (const fn of listeners) fn();
  });
}

export function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(cachedDeferredPrompt);
  const [isStandalone, setIsStandalone] = useState<boolean>(detectStandalone);
  const [platform] = useState<PwaPlatform>(detectPlatform);

  useEffect(() => {
    const sync = () => {
      setDeferredPrompt(cachedDeferredPrompt);
      setIsStandalone(detectStandalone());
    };
    listeners.add(sync);

    const mq = window.matchMedia?.("(display-mode: standalone)");
    mq?.addEventListener?.("change", sync);
    return () => {
      listeners.delete(sync);
      mq?.removeEventListener?.("change", sync);
    };
  }, []);

  const promptInstall = async (): Promise<"accepted" | "dismissed" | "unavailable"> => {
    if (!cachedDeferredPrompt) return "unavailable";
    await cachedDeferredPrompt.prompt();
    const { outcome } = await cachedDeferredPrompt.userChoice;
    if (outcome === "accepted") {
      cachedDeferredPrompt = null;
      setDeferredPrompt(null);
      setIsStandalone(true);
    }
    return outcome;
  };

  return {
    platform,
    isStandalone,
    canPrompt: Boolean(deferredPrompt),
    promptInstall,
  };
}
