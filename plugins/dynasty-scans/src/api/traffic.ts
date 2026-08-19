/**
 * Real-time session network traffic and bandwidth tracker.
 * Tracks bytes downloaded, network requests, and SQLite cache hits across the current app session.
 */

export interface SessionTraffic {
  bytesDownloaded: number;
  networkRequests: number;
  cacheHits: number;
  bytesSaved: number;
}

const trafficState: SessionTraffic = {
  bytesDownloaded: 0,
  networkRequests: 0,
  cacheHits: 0,
  bytesSaved: 0,
};

type TrafficListener = (state: SessionTraffic) => void;
const listeners = new Set<TrafficListener>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener({ ...trafficState });
    } catch (err) {
      console.warn("[ds-traffic] listener error:", err);
    }
  }
}

/** Records inbound network payload traffic. */
export function recordNetworkTraffic(bytes: number): void {
  trafficState.bytesDownloaded += Math.max(0, bytes);
  trafficState.networkRequests += 1;
  notify();
}

/** Records a local cache hit (saving online bandwidth). */
export function recordCacheHit(savedBytes = 0): void {
  trafficState.cacheHits += 1;
  trafficState.bytesSaved += Math.max(0, savedBytes);
  notify();
}

/** Returns the current session traffic snapshot. */
export function getSessionTraffic(): SessionTraffic {
  return { ...trafficState };
}

/** Subscribes to live traffic updates. Returns an unsubscribe callback. */
export function subscribeSessionTraffic(listener: TrafficListener): () => void {
  listeners.add(listener);
  listener({ ...trafficState });
  return () => {
    listeners.delete(listener);
  };
}

/** Formats byte counts into human-readable strings (canonical, from `lib/format`). */
export { formatBytes } from "../../../lib/format";
