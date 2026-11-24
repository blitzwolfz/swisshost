import { useCallback, useEffect, useRef, useState } from "react";

export interface UserGpsPosition {
  lat: number;
  lon: number;
  accuracy: number;
  speedMps: number | null;
  headingDeg: number | null;
  timestamp: number;
}

/**
 * Explicit opt-in browser geolocation tracker for On-Board Ride Mode and Nearby Stops.
 * Location stays strictly client-side in React state — never persisted or cached.
 */
export function useUserLocation() {
  const [position, setPosition] = useState<UserGpsPosition | null>(null);
  const [watching, setWatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const watchIdRef = useRef<number | null>(null);

  const handleSuccess = useCallback((pos: GeolocationPosition) => {
    setError(null);
    setPosition({
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      accuracy: Math.round(pos.coords.accuracy),
      speedMps: pos.coords.speed !== null && Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
      headingDeg: pos.coords.heading !== null && Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
      timestamp: pos.timestamp,
    });
  }, []);

  const handleError = useCallback((err: GeolocationPositionError) => {
    if (err.code === err.PERMISSION_DENIED) {
      setError("Location permission denied. Allow location access in your browser settings to track your ride.");
    } else if (err.code === err.POSITION_UNAVAILABLE) {
      setError("Location unavailable right now.");
    } else {
      setError("Location request timed out.");
    }
    setWatching(false);
  }, []);

  const startWatching = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setError("Geolocation is not supported in this browser.");
      return;
    }
    setError(null);
    setWatching(true);
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    watchIdRef.current = navigator.geolocation.watchPosition(handleSuccess, handleError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15_000,
    });
  }, [handleError, handleSuccess]);

  const stopWatching = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setWatching(false);
  }, []);

  const locateOnce = useCallback((): Promise<UserGpsPosition> => {
    return new Promise((resolve, reject) => {
      if (!("geolocation" in navigator)) {
        const msg = "Geolocation is not supported in this browser.";
        setError(msg);
        reject(new Error(msg));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const next: UserGpsPosition = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy: Math.round(pos.coords.accuracy),
            speedMps: pos.coords.speed !== null && Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
            headingDeg: pos.coords.heading !== null && Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
            timestamp: pos.timestamp,
          };
          setError(null);
          setPosition(next);
          resolve(next);
        },
        (err) => {
          handleError(err);
          reject(new Error(err.message));
        },
        { enableHighAccuracy: true, maximumAge: 10_000, timeout: 12_000 }
      );
    });
  }, [handleError]);

  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

  return { position, watching, error, startWatching, stopWatching, locateOnce };
}
