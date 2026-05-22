import { useEffect, useRef } from "react";
import { subscribeDetection } from "./detectionSocket";

interface UseGameStateSyncOptions {
  enabled?: boolean;
  refresh: () => Promise<unknown> | unknown;
  onStatus?: (status: { dartCount?: number; detectionState?: string }) => void;
  onEvent?: (data: Record<string, any>) => boolean | void;
  pollMs?: number;
  debounceMs?: number;
}

export function useGameStateSync({
  enabled = true,
  refresh,
  onStatus,
  onEvent,
  pollMs = 0,
  debounceMs = 150,
}: UseGameStateSyncOptions): void {
  const refreshInFlightRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);
  const lastRefreshScheduledAtRef = useRef(0);
  const refreshRef = useRef(refresh);
  const onStatusRef = useRef(onStatus);
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!enabled) return;

    const runRefresh = async () => {
      if (refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      try {
        await Promise.resolve(refreshRef.current());
      } finally {
        refreshInFlightRef.current = false;
      }
    };

    const scheduleRefresh = () => {
      const now = Date.now();
      // Prevent duplicate refresh bursts (e.g. dart_detected + dart_score + state_updated).
      if (now - lastRefreshScheduledAtRef.current < 180) {
        return;
      }
      lastRefreshScheduledAtRef.current = now;

      if (debounceMs <= 0) {
        void runRefresh();
        return;
      }
      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        void runRefresh();
      }, debounceMs);
    };

    const unsubscribe = subscribeDetection((data) => {
      if (typeof data.dart_count === "number" || typeof data.detection_state === "string") {
        onStatusRef.current?.({
          dartCount: typeof data.dart_count === "number" ? data.dart_count : undefined,
          detectionState: typeof data.detection_state === "string" ? data.detection_state : undefined,
        });
      }
      if (onEventRef.current?.(data)) {
        return;
      }

      if (
        data.event === "dart_detected" ||
        data.event === "dart_score" ||
        data.event === "dart_score_unavailable" ||
        data.event === "x01_state_updated" ||
        data.event === "cricket_state_updated" ||
        data.event === "around_the_clock_state_updated" ||
        data.event === "shanghai_state_updated" ||
        data.event === "beer_race_state_updated" ||
        data.event === "bermuda_state_updated" ||
        data.event === "bob27_state_updated" ||
        data.event === "one_two_one_state_updated" ||
        data.event === "target_trainer_state_updated" ||
        data.event === "pacman_state_updated" ||
        data.event === "dart_score_corrected" ||
        data.event === "darts_removed"
      ) {
        scheduleRefresh();
      }
    });

    let pollTimer: number | null = null;
    if (pollMs > 0) {
      pollTimer = window.setInterval(() => {
        scheduleRefresh();
      }, pollMs);
    }

    return () => {
      unsubscribe();
      if (pollTimer) {
        window.clearInterval(pollTimer);
      }
      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [enabled, pollMs, debounceMs]);
}
