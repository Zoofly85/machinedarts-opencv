import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { onDetectionError, onDetectionOpen, subscribeDetection } from "../services/detectionSocket";
import ScoreCorrection from "../components/ScoreCorrection";
import GameRecalibrateButton from "../components/game/GameRecalibrateButton";
import { addDart, correctScore, deleteCorrectionImages } from "../services/correctionApi";
import {
  appendTrainingSessionEvent,
  completeTrainingSession,
  getDetectionRoundDart,
  getTrainingSession,
  getTrainingSessionReport,
  updateTrainingSessionEvent,
  type TrainingBlock,
  type TrainingProgram,
  type TrainingSession,
} from "../services/trainingApi";
import { API_BASE_URL } from "../../services/api";

const API_URL = API_BASE_URL;

type DetectionScore = {
  score: number;
  multiplier: number;
  segment: string;
  zone: string;
  confidence?: number;
};

type ProgressState = {
  blockIndex: number;
  doublesHits: Record<string, number>;
  powerDarts: Record<string, number>;
  blockDarts: number;
  blockHits: number;
  totalScore: number;
  totalHits: number;
  finished: boolean;
};

type DartSlotScore = {
  score: number;
  multiplier: number;
  segment: string;
  zone: string;
  confidence?: number;
} | null;

type CorrectionZone =
  | "single_inner"
  | "single_outer"
  | "single"
  | "double"
  | "triple"
  | "outer_bull"
  | "inner_bull"
  | "miss";

function parseProgramFromSession(session: TrainingSession): TrainingProgram | null {
  const raw = (session.summary?.programSnapshot ?? null) as TrainingProgram | null;
  return raw && Array.isArray(raw.blocks) ? raw : null;
}

function targetFromScore(score: DetectionScore): string {
  const seg = String(score.segment ?? "").toUpperCase();
  if (score.zone === "inner_bull") return "BULL";
  if (score.zone === "outer_bull") return "SBULL";
  if (score.multiplier === 2) return `D${seg}`;
  if (score.multiplier === 3) return `T${seg}`;
  return `S${seg}`;
}

function scoreSegmentValue(score: DetectionScore): number {
  const seg = Number(score.segment);
  if (!Number.isFinite(seg)) return 0;
  if (seg === 25) return score.multiplier === 2 ? 50 : 25;
  return seg * Math.max(1, Number(score.multiplier || 1));
}

function getBlockTargets(block: TrainingBlock): string[] {
  const config = (block.config ?? {}) as Record<string, unknown>;
  const raw = config.targets;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item).trim().toUpperCase()).filter(Boolean);
}

function nextSequentialTarget(targets: string[], counts: Record<string, number>, needed: number): string {
  for (const target of targets) {
    if ((counts[target] ?? 0) < needed) return target;
  }
  return targets[targets.length - 1] ?? "";
}

function getActiveTarget(
  block: TrainingBlock,
  progress: ProgressState,
  detectedTarget: string
): string {
  const config = (block.config ?? {}) as Record<string, unknown>;
  const targets = getBlockTargets(block);
  const orderMode = String(config.orderMode ?? "sequential");
  if (targets.length === 0) return detectedTarget;
  if (orderMode === "any_order") {
    return targets.includes(detectedTarget) ? detectedTarget : targets[0];
  }
  if (String(block.type) === "doubles") {
    const needed = Math.max(1, Number(config.hitsRequiredPerTarget ?? 10));
    return nextSequentialTarget(targets, progress.doublesHits, needed);
  }
  const perTarget = Math.max(1, Number(config.dartsPerTarget ?? 60));
  return nextSequentialTarget(targets, progress.powerDarts, perTarget);
}

function isBlockComplete(block: TrainingBlock, progress: ProgressState): boolean {
  const config = (block.config ?? {}) as Record<string, unknown>;
  const targets = getBlockTargets(block);
  if (targets.length === 0) return progress.blockDarts > 0;
  if (String(block.type) === "doubles") {
    const needed = Math.max(1, Number(config.hitsRequiredPerTarget ?? 10));
    return targets.every((target) => (progress.doublesHits[target] ?? 0) >= needed);
  }
  const perTarget = Math.max(1, Number(config.dartsPerTarget ?? 60));
  return targets.every((target) => (progress.powerDarts[target] ?? 0) >= perTarget);
}

function initProgress(): ProgressState {
  return {
    blockIndex: 0,
    doublesHits: {},
    powerDarts: {},
    blockDarts: 0,
    blockHits: 0,
    totalScore: 0,
    totalHits: 0,
    finished: false,
  };
}

function toScoreLabel(score: DetectionScore | DartSlotScore): string {
  if (!score) return "-";
  const seg = String(score.segment ?? "").toUpperCase();
  const mult = Number(score.multiplier || 1);
  const zone = String(score.zone || "");
  if (zone === "inner_bull" || (seg === "25" && mult === 2)) return "BULL";
  if (zone === "outer_bull" || (seg === "25" && mult === 1)) return "SBULL";
  if (mult === 3) return `T${seg}`;
  if (mult === 2) return `D${seg}`;
  if (zone === "miss" || Number(score.score || 0) === 0) return "MISS";
  return `S${seg}`;
}

function deriveProgressFromSession(program: TrainingProgram | null, session: TrainingSession | null): ProgressState {
  const next = initProgress();
  if (!program || !session) return next;
  const events = Array.isArray(session.events) ? session.events : [];
  for (const ev of events) {
    const blockIndex = Number((ev as Record<string, unknown>).blockIndex ?? 0);
    const scored = Number((ev as Record<string, unknown>).scored ?? 0);
    const targetKey = String((ev as Record<string, unknown>).targetKey ?? "");
    const meta = ((ev as Record<string, unknown>).meta ?? {}) as Record<string, unknown>;
    const isHit = Boolean(meta.isHit);
    next.blockIndex = Math.max(next.blockIndex, blockIndex);
    next.blockDarts += 1;
    next.totalScore += Number.isFinite(scored) ? scored : 0;
    if (isHit) {
      next.blockHits += 1;
      next.totalHits += 1;
      if (targetKey) {
        if (targetKey.startsWith("D")) {
          next.doublesHits[targetKey] = (next.doublesHits[targetKey] ?? 0) + 1;
        } else {
          next.powerDarts[targetKey] = (next.powerDarts[targetKey] ?? 0) + 1;
        }
      }
    } else if (targetKey) {
      if (!targetKey.startsWith("D")) {
        next.powerDarts[targetKey] = (next.powerDarts[targetKey] ?? 0) + 1;
      }
    }
  }
  next.finished = String(session.status || "").toLowerCase() === "completed";
  if (program.blocks.length > 0) {
    next.blockIndex = Math.min(next.blockIndex, program.blocks.length - 1);
  } else {
    next.blockIndex = 0;
  }
  return next;
}

function normalizeCorrectionZone(zone: string | undefined): CorrectionZone {
  const z = String(zone || "").toLowerCase();
  if (
    z === "single_inner" ||
    z === "single_outer" ||
    z === "single" ||
    z === "double" ||
    z === "triple" ||
    z === "outer_bull" ||
    z === "inner_bull" ||
    z === "miss"
  ) {
    return z;
  }
  return "single";
}

function scoreFromRoundDart(roundDart: Record<string, unknown> | null): DetectionScore | null {
  if (!roundDart) return null;
  const voted = (roundDart.voted_score ?? null) as Record<string, unknown> | null;
  if (!voted) return null;
  return {
    score: Number(voted.score ?? roundDart.voted_score_value ?? 0),
    multiplier: Number(voted.multiplier ?? 1),
    segment: String(voted.segment ?? ""),
    zone: String(voted.zone ?? "miss"),
    confidence: Number(voted.confidence ?? 0),
  };
}

export default function TrainingSessionPage() {
  const { sessionId = "" } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<TrainingSession | null>(null);
  const [program, setProgram] = useState<TrainingProgram | null>(null);
  const [progress, setProgress] = useState<ProgressState>(initProgress);
  const [status, setStatus] = useState("Connecting...");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [detectionCount, setDetectionCount] = useState(0);
  const [lastBoardCount, setLastBoardCount] = useState(0);
  const [lastProcessed, setLastProcessed] = useState(0);
  const [slotScores, setSlotScores] = useState<Array<DartSlotScore>>([null, null, null]);
  const [slotEventIds, setSlotEventIds] = useState<Array<number | null>>([null, null, null]);
  const [lastHits, setLastHits] = useState<Array<{ target: string; value: number; at: string }>>([]);
  const [sessionReport, setSessionReport] = useState<Record<string, unknown> | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionDartIndex, setCorrectionDartIndex] = useState(0);

  const currentBlock = program?.blocks?.[progress.blockIndex];
  const totalBlocks = program?.blocks?.length ?? 0;
  const currentBlockTargets = currentBlock ? getBlockTargets(currentBlock) : [];
  const liveBlockStatus = React.useMemo(() => {
    if (!currentBlock) {
      return {
        modeLabel: "None",
        currentTarget: "-",
        currentRemaining: 0,
        totalRemaining: 0,
      };
    }
    const config = (currentBlock.config ?? {}) as Record<string, unknown>;
    const orderMode = String(config.orderMode ?? "sequential");
    const targets = currentBlockTargets;
    if (!targets.length) {
      return {
        modeLabel: orderMode === "any_order" ? "Any order" : "Sequential",
        currentTarget: "-",
        currentRemaining: 0,
        totalRemaining: 0,
      };
    }

    if (String(currentBlock.type) === "doubles") {
      const needed = Math.max(1, Number(config.hitsRequiredPerTarget ?? 10));
      const remainingByTarget = targets.map((target) => ({
        target,
        remaining: Math.max(0, needed - Number(progress.doublesHits[target] ?? 0)),
      }));
      const totalRemaining = remainingByTarget.reduce((sum, row) => sum + row.remaining, 0);
      const currentRow =
        orderMode === "any_order"
          ? remainingByTarget.find((row) => row.remaining > 0) ?? remainingByTarget[0]
          : remainingByTarget.find((row) => row.remaining > 0) ?? remainingByTarget[remainingByTarget.length - 1];
      return {
        modeLabel: orderMode === "any_order" ? "Any order" : "Sequential",
        currentTarget: currentRow?.target ?? "-",
        currentRemaining: Number(currentRow?.remaining ?? 0),
        totalRemaining,
      };
    }

    const perTarget = Math.max(1, Number(config.dartsPerTarget ?? 60));
    const remainingByTarget = targets.map((target) => ({
      target,
      remaining: Math.max(0, perTarget - Number(progress.powerDarts[target] ?? 0)),
    }));
    const totalRemaining = remainingByTarget.reduce((sum, row) => sum + row.remaining, 0);
    const currentRow =
      orderMode === "any_order"
        ? remainingByTarget.find((row) => row.remaining > 0) ?? remainingByTarget[0]
        : remainingByTarget.find((row) => row.remaining > 0) ?? remainingByTarget[remainingByTarget.length - 1];
    return {
      modeLabel: orderMode === "any_order" ? "Any order" : "Sequential",
      currentTarget: currentRow?.target ?? "-",
      currentRemaining: Number(currentRow?.remaining ?? 0),
      totalRemaining,
    };
  }, [currentBlock, currentBlockTargets, progress.doublesHits, progress.powerDarts]);

  const refreshSession = React.useCallback(async () => {
    if (!sessionId) return;
    const data = await getTrainingSession(sessionId);
    setSession(data);
    const parsedProgram = parseProgramFromSession(data);
    if (parsedProgram) {
      setProgram(parsedProgram);
      setProgress((prev) => {
        const rebuilt = deriveProgressFromSession(parsedProgram, data);
        return {
          ...prev,
          ...rebuilt,
        };
      });
      return;
    }
    const programId = String(data.programId || "").trim();
    if (programId) {
      const programResponse = await fetch(`${API_URL}/api/training/programs/${programId}`);
      if (programResponse.ok) {
        const payload = (await programResponse.json()) as { program?: TrainingProgram };
        if (payload.program) {
          setProgram(payload.program);
          setProgress((prev) => {
            const rebuilt = deriveProgressFromSession(payload.program ?? null, data);
            return {
              ...prev,
              ...rebuilt,
            };
          });
        }
      }
    }
  }, [sessionId]);

  useEffect(() => {
    refreshSession().catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to load training session");
    });
  }, [refreshSession]);

  const loadSessionReport = React.useCallback(async () => {
    if (!sessionId) return;
    try {
      const report = await getTrainingSessionReport(sessionId);
      setSessionReport(report);
    } catch {
      // Keep session runner alive even if reports fail.
    }
  }, [sessionId]);

  useEffect(() => {
    loadSessionReport();
  }, [loadSessionReport]);

  const refreshBoardScores = React.useCallback(async () => {
    try {
      const nextScores: Array<DartSlotScore> = [null, null, null];
      for (let idx = 1; idx <= 3; idx += 1) {
        try {
          const roundDart = await getDetectionRoundDart(idx);
          nextScores[idx - 1] = scoreFromRoundDart(roundDart);
        } catch {
          nextScores[idx - 1] = null;
        }
      }
      setSlotScores(nextScores);
    } catch {
      // Keep session page responsive if backend momentarily fails.
    }
  }, []);

  useEffect(() => {
    refreshBoardScores();
  }, [refreshBoardScores]);

  useEffect(() => {
    const offOpen = onDetectionOpen(() => setStatus("Detection connected"));
    const offErr = onDetectionError(() => setStatus("Detection connection issue"));
    const unsubscribe = subscribeDetection((payload) => {
      if (typeof payload?.dart_count === "number") {
        setDetectionCount(payload.dart_count);
      }
      if (payload?.event === "darts_removed") {
        setStatus("Board cleared");
        setSlotScores([null, null, null]);
        setSlotEventIds([null, null, null]);
      }
    });
    return () => {
      offOpen();
      offErr();
      unsubscribe();
    };
  }, []);

  const processNewDarts = React.useCallback(
    async (newCount: number): Promise<number> => {
      if (!sessionId || !currentBlock || progress.finished) return lastProcessed;
      const scores: Array<DetectionScore | null> = [null, null, null];
      for (let idx = 1; idx <= 3; idx += 1) {
        try {
          const roundDart = await getDetectionRoundDart(idx);
          scores[idx - 1] = scoreFromRoundDart(roundDart);
        } catch {
          scores[idx - 1] = null;
        }
      }
      setSlotScores([scores[0], scores[1], scores[2]]);

      let workingProgress: ProgressState = { ...progress };
      let nextProcessed = lastProcessed;

      for (let idx = lastProcessed; idx < newCount; idx += 1) {
        const detected = scores[idx];
        if (!detected) {
          // Tip vote can arrive slightly after dart_count increments; leave this index pending.
          break;
        }
        const detectedTarget = targetFromScore(detected);
        const activeTarget = getActiveTarget(currentBlock, workingProgress, detectedTarget);
        const value = scoreSegmentValue(detected);
        const isHit = detectedTarget === activeTarget;

        let boardX: number | null = null;
        let boardY: number | null = null;
        try {
          const dartDetail = await getDetectionRoundDart(idx + 1);
          const primary = (dartDetail?.primary_candidate ?? null) as Record<string, unknown> | null;
          const board = (primary?.board ?? null) as Record<string, unknown> | null;
          const nx = Number(board?.norm_x);
          const ny = Number(board?.norm_y);
          if (Number.isFinite(nx) && Number.isFinite(ny)) {
            boardX = nx;
            boardY = ny;
          }
        } catch {
          // Coordinate capture is best-effort; keep event ingestion resilient.
        }

        const nextProgress: ProgressState = {
          ...workingProgress,
          blockDarts: workingProgress.blockDarts + 1,
          blockHits: workingProgress.blockHits + (isHit ? 1 : 0),
          totalScore: workingProgress.totalScore + value,
          totalHits: workingProgress.totalHits + (isHit ? 1 : 0),
        };
        if (String(currentBlock.type) === "doubles") {
          nextProgress.doublesHits = { ...workingProgress.doublesHits };
          if (isHit) {
            nextProgress.doublesHits[activeTarget] = (nextProgress.doublesHits[activeTarget] ?? 0) + 1;
          }
        } else {
          nextProgress.powerDarts = { ...workingProgress.powerDarts };
          nextProgress.powerDarts[activeTarget] = (nextProgress.powerDarts[activeTarget] ?? 0) + 1;
        }

        const updatedSession = await appendTrainingSessionEvent(sessionId, {
          block_index: workingProgress.blockIndex,
          target_key: activeTarget,
          scored: value,
          multiplier: Number(detected.multiplier || 1),
          segment: String(detected.segment || ""),
          zone: String(detected.zone || ""),
          board_x: boardX,
          board_y: boardY,
          meta: {
            detectedTarget,
            expectedTarget: activeTarget,
            isHit,
            confidence: Number(detected.confidence ?? 0),
            boardCoordSource: boardX != null && boardY != null ? "round_dart_norm" : "none",
          },
        });
        setSession(updatedSession);
        const newestEventId =
          Array.isArray(updatedSession.events) && updatedSession.events.length > 0
            ? Number((updatedSession.events[updatedSession.events.length - 1] as Record<string, unknown>).id ?? 0)
            : 0;
        if (newestEventId > 0) {
          setSlotEventIds((prev) => {
            const next = [...prev];
            next[idx] = newestEventId;
            return next;
          });
        }

        setLastHits((prev) =>
          [{ target: detectedTarget, value, at: new Date().toLocaleTimeString() }, ...prev].slice(0, 8)
        );

        const done = isBlockComplete(currentBlock, nextProgress);
        if (done) {
          if ((workingProgress.blockIndex + 1) < totalBlocks) {
            nextProgress.blockIndex = workingProgress.blockIndex + 1;
            nextProgress.blockDarts = 0;
            nextProgress.blockHits = 0;
          } else {
            nextProgress.finished = true;
          }
        }
        workingProgress = nextProgress;
        nextProcessed = idx + 1;
      }
      setProgress(workingProgress);
      return nextProcessed;
    },
    [currentBlock, lastProcessed, progress, sessionId, totalBlocks]
  );

  useEffect(() => {
    if (detectionCount < lastBoardCount) {
      setLastBoardCount(detectionCount);
      setLastProcessed(0);
      setSlotEventIds([null, null, null]);
      setSlotScores([null, null, null]);
      return;
    }
    if (detectionCount > lastProcessed) {
      processNewDarts(detectionCount)
        .catch((err) => setError(err instanceof Error ? err.message : "Failed processing dart"))
        .then((processedUntil) => {
          setLastBoardCount(detectionCount);
          if (typeof processedUntil === "number") {
            setLastProcessed(processedUntil);
          }
        });
    }
  }, [detectionCount, lastBoardCount, lastProcessed, processNewDarts]);

  const handleFinish = async () => {
    if (!sessionId || !program) return;
    setSaving(true);
    setError(null);
    try {
      const summary = {
        totalDarts: lastProcessed,
        totalScore: progress.totalScore,
        completedBlocks: progress.finished ? totalBlocks : progress.blockIndex,
        finished: progress.finished,
        programSnapshot: program,
      };
      const metrics = {
        doublesHits: progress.doublesHits,
        powerDarts: progress.powerDarts,
        blockDarts: progress.blockDarts,
        blockHits: progress.blockHits,
        hitRate: lastProcessed > 0 ? progress.totalHits / lastProcessed : 0,
      };
      await completeTrainingSession(sessionId, { summary, metrics });
      await refreshSession();
      await loadSessionReport();
      setStatus("Session completed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete session");
    } finally {
      setSaving(false);
    }
  };

  const handleResetBoard = async () => {
    await fetch(`${API_URL}/api/detection/reset`, { method: "POST" });
    setLastBoardCount(0);
    setLastProcessed(0);
    setSlotScores([null, null, null]);
    setSlotEventIds([null, null, null]);
  };

  const handleOpenCorrection = (dartIndex: number) => {
    setCorrectionDartIndex(dartIndex);
    setCorrectionOpen(true);
  };

  const handleSaveCorrection = async (correction: {
    dartIndex: number;
    multiplier: number;
    segment: number;
    score: number;
    zone?: string;
  }) => {
    if (!sessionId || !currentBlock) return;
    const payload = {
      ...correction,
      zone: normalizeCorrectionZone(correction.zone),
    };
    await correctScore(payload);
    await refreshBoardScores();
    const eventId = slotEventIds[correction.dartIndex];
    if (!eventId) return;

    const correctedDetected: DetectionScore = {
      score: correction.score,
      multiplier: correction.multiplier,
      segment: String(correction.segment),
      zone: String(payload.zone || "single"),
      confidence: 1.0,
    };
    const detectedTarget = targetFromScore(correctedDetected);
    const activeTarget = getActiveTarget(currentBlock, progress, detectedTarget);
    const isHit = detectedTarget === activeTarget;
    const updatedSession = await updateTrainingSessionEvent(sessionId, eventId, {
      scored: correction.score,
      multiplier: correction.multiplier,
      segment: String(correction.segment),
      zone: String(payload.zone || "single"),
      meta: {
        corrected: true,
        detectedTarget,
        expectedTarget: activeTarget,
        isHit,
      },
    });
    setSession(updatedSession);
    if (program) {
      setProgress(deriveProgressFromSession(program, updatedSession));
    }
    await loadSessionReport();
  };

  const handleAddDart = async (correction: {
    dartIndex: number;
    multiplier: number;
    segment: number;
    score: number;
    zone?: string;
  }) => {
    if (!sessionId || !currentBlock) return;
    const payload = {
      ...correction,
      zone: normalizeCorrectionZone(correction.zone),
    };
    await addDart(payload);
    await refreshBoardScores();

    const detected: DetectionScore = {
      score: correction.score,
      multiplier: correction.multiplier,
      segment: String(correction.segment),
      zone: String(payload.zone || "single"),
      confidence: 1.0,
    };
    const detectedTarget = targetFromScore(detected);
    const activeTarget = getActiveTarget(currentBlock, progress, detectedTarget);
    const isHit = detectedTarget === activeTarget;

    const updatedSession = await appendTrainingSessionEvent(sessionId, {
      block_index: progress.blockIndex,
      target_key: activeTarget,
      scored: correction.score,
      multiplier: correction.multiplier,
      segment: String(correction.segment),
      zone: String(payload.zone || "single"),
      meta: {
        manualAdd: true,
        corrected: true,
        detectedTarget,
        expectedTarget: activeTarget,
        isHit,
        confidence: 1.0,
      },
    });
    setSession(updatedSession);
    const newestEventId =
      Array.isArray(updatedSession.events) && updatedSession.events.length > 0
        ? Number((updatedSession.events[updatedSession.events.length - 1] as Record<string, unknown>).id ?? 0)
        : 0;
    if (newestEventId > 0) {
      setSlotEventIds((prev) => {
        const next = [...prev];
        next[correction.dartIndex] = newestEventId;
        return next;
      });
    }
    if (program) {
      setProgress(deriveProgressFromSession(program, updatedSession));
    }
    await loadSessionReport();
  };

  const reportAnalytics = (sessionReport?.analytics ?? {}) as Record<string, unknown>;
  const overall = (reportAnalytics?.overall ?? {}) as Record<string, unknown>;
  const perTarget = (reportAnalytics?.perTarget ?? []) as Array<Record<string, unknown>>;

  const powerVisitSize = React.useMemo(() => {
    if (!program?.blocks?.length) return 3;
    for (const block of program.blocks) {
      if (String(block.type) !== "power_scoring") continue;
      const cfg = (block.config ?? {}) as Record<string, unknown>;
      const size = Number(cfg.visitSize ?? 3);
      if (size === 1 || size === 3) return size;
    }
    return 3;
  }, [program?.blocks]);

  const avgPerDart = Number(overall.avgScorePerDart ?? 0);
  const avgPerVisit = avgPerDart * powerVisitSize;

  const scoringTrend = React.useMemo(() => {
    const events = Array.isArray(session?.events) ? session.events : [];
    const scored = events
      .map((ev) => Number((ev as Record<string, unknown>).scored ?? 0))
      .filter((v) => Number.isFinite(v));
    if (scored.length < 6) return null;

    const windowSize = Math.min(Math.max(3, powerVisitSize * 3), Math.floor(scored.length / 2));
    if (windowSize < 3) return null;

    const recent = scored.slice(-windowSize);
    const previous = scored.slice(-(windowSize * 2), -windowSize);
    if (!previous.length) return null;

    const avg = (arr: number[]) => arr.reduce((sum, n) => sum + n, 0) / arr.length;
    const recentAvg = avg(recent);
    const previousAvg = avg(previous);
    const delta = recentAvg - previousAvg;
    const direction = delta > 0.75 ? "up" : delta < -0.75 ? "down" : "flat";

    return { delta, direction };
  }, [powerVisitSize, session?.events]);

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden flex flex-col">
      <div className="pointer-events-none fixed inset-0 [background:
        radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
        radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
        radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
        radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
        linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
      ]" />

      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between">
        <h1 className="text-2xl font-extrabold tracking-wide">
          Training <span className="text-red-500">Session</span>
        </h1>
        <div className="flex items-center gap-2">
          <GameRecalibrateButton />
          <button
            onClick={handleResetBoard}
            className="px-3 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors"
          >
            Reset Board
          </button>
          <Link to="/training" className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors">
            Back
          </Link>
        </div>
      </header>

      <main className="relative z-10 w-full px-6 md:px-10 pb-10">
        <div className="max-w-6xl mx-auto grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-6">
          <section className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
            <h2 className="text-xl font-bold mb-2">{program?.name || "Loading program..."}</h2>
            <p className="text-sm text-zinc-400 mb-4">{program?.description || "Training session is active."}</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Block</div>
                <div className="text-3xl font-bold">{Math.min(progress.blockIndex + 1, Math.max(1, totalBlocks))}/{Math.max(1, totalBlocks)}</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Detected</div>
                <div className="text-3xl font-bold">{lastProcessed}</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Block Darts</div>
                <div className="text-3xl font-bold">{progress.blockDarts}</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Block Hits</div>
                <div className="text-3xl font-bold">{progress.blockHits}</div>
              </div>
            </div>

            <div className="mt-5 rounded-xl border border-cyan-700/40 bg-cyan-900/10 p-4">
              <div className="text-xs uppercase tracking-[0.25em] text-cyan-300 mb-2">Current Block</div>
              {currentBlock ? (
                <>
                  <div className="text-lg font-semibold">
                    {String(currentBlock.type) === "doubles" ? "Doubles Block" : "Power Scoring Block"}
                  </div>
                  <div className="text-sm text-zinc-300 mt-1">
                    Targets: {currentBlockTargets.join(", ") || "None"}
                  </div>
                  <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div className="rounded-md border border-cyan-700/30 bg-black/25 p-2">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-cyan-300/80">Mode</div>
                      <div className="text-sm font-semibold text-white">{liveBlockStatus.modeLabel}</div>
                    </div>
                    <div className="rounded-md border border-cyan-700/30 bg-black/25 p-2">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-cyan-300/80">Now Aiming</div>
                      <div className="text-sm font-semibold text-white">{liveBlockStatus.currentTarget}</div>
                    </div>
                    <div className="rounded-md border border-cyan-700/30 bg-black/25 p-2">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-cyan-300/80">
                        {String(currentBlock.type) === "doubles" ? "Hits Left (Target)" : "Darts Left (Target)"}
                      </div>
                      <div className="text-sm font-semibold text-white">{liveBlockStatus.currentRemaining}</div>
                    </div>
                    <div className="rounded-md border border-cyan-700/30 bg-black/25 p-2">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-cyan-300/80">
                        {String(currentBlock.type) === "doubles" ? "Hits Left (Block)" : "Darts Left (Block)"}
                      </div>
                      <div className="text-sm font-semibold text-white">{liveBlockStatus.totalRemaining}</div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-sm text-zinc-300">No active block.</div>
              )}
            </div>

            <div className="mt-5 flex items-center gap-3">
              <button
                onClick={handleFinish}
                disabled={saving || !sessionId}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 font-semibold"
              >
                {saving ? "Saving..." : "Complete Session"}
              </button>
              <button
                onClick={() => navigate("/training")}
                className="px-4 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 font-semibold"
              >
                Exit
              </button>
              <button
                onClick={loadSessionReport}
                className="px-4 py-2 rounded-lg bg-indigo-700 hover:bg-indigo-600 font-semibold"
              >
                Refresh Analytics
              </button>
            </div>

            <div className="mt-5 rounded-xl border border-white/10 bg-black/30 p-4">
              <div className="text-xs uppercase tracking-[0.25em] text-zinc-500 mb-3">
                Dart Corrections (tap to edit or add)
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {[0, 1, 2].map((idx) => {
                  const score = slotScores[idx];
                  return (
                    <button
                      key={`training-dart-${idx}`}
                      type="button"
                      onClick={() => handleOpenCorrection(idx)}
                      className="rounded-xl border border-red-500/40 bg-red-600/10 hover:bg-red-600/20 hover:border-red-500/70 transition px-4 py-4 text-left"
                    >
                      <div className="text-xs uppercase tracking-[0.2em] text-zinc-400">Dart {idx + 1}</div>
                      <div className="mt-2 text-2xl font-bold text-white">
                        {score ? toScoreLabel(score) : "No dart"}
                      </div>
                      <div className="text-sm text-zinc-400 mt-1">
                        {score ? `Score ${Number(score.score || 0)}` : "Click to add missed dart"}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {error && <div className="mt-4 text-sm text-red-300">{error}</div>}
          </section>

          <section className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
            <h3 className="text-lg font-bold mb-3">Live Status</h3>
            <div className="text-sm text-zinc-300 mb-4">{status}</div>
            <div className="rounded-lg border border-white/10 bg-black/30 p-3 mb-4">
              <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Session</div>
              <div className="text-sm mt-1">ID: {session?.id || sessionId}</div>
              <div className="text-sm">Player: {session?.playerName || "Unknown"}</div>
              <div className="text-sm">State: {progress.finished ? "Finished" : "Running"}</div>
            </div>

            <div className="rounded-lg border border-white/10 bg-black/30 p-3">
              <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Recent Darts</div>
              {lastHits.length === 0 ? (
                <div className="text-sm text-zinc-500">Waiting for darts...</div>
              ) : (
                <div className="space-y-2">
                  {lastHits.map((hit, idx) => (
                    <div key={`${hit.at}-${idx}`} className="flex items-center justify-between text-sm">
                      <span className="text-zinc-200">{hit.target}</span>
                      <span className="text-cyan-300">{hit.value}</span>
                      <span className="text-zinc-500">{hit.at}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-white/10 bg-black/30 p-3 mt-4">
              <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Session Analytics</div>
              <div className="text-sm text-zinc-300 mb-2">
                Darts: {Number(overall.totalDarts ?? 0)} | Hit Rate: {(Number(overall.hitRate ?? 0) * 100).toFixed(1)}%
              </div>
              <div className="text-sm text-zinc-300 mb-2">
                Avg/Dart: <span className="text-emerald-300">{avgPerDart.toFixed(2)}</span>
                {" "} | Avg/Visit ({powerVisitSize}): <span className="text-cyan-300">{avgPerVisit.toFixed(2)}</span>
                {scoringTrend && (
                  <>
                    {" "} | Trend:{" "}
                    <span
                      className={
                        scoringTrend.direction === "up"
                          ? "text-emerald-300"
                          : scoringTrend.direction === "down"
                          ? "text-red-300"
                          : "text-zinc-300"
                      }
                    >
                      {scoringTrend.direction === "up" ? "↑" : scoringTrend.direction === "down" ? "↓" : "→"}{" "}
                      {scoringTrend.delta >= 0 ? "+" : ""}
                      {scoringTrend.delta.toFixed(2)}
                    </span>
                  </>
                )}
              </div>
              {perTarget.length === 0 ? (
                <div className="text-sm text-zinc-500">No analytics yet.</div>
              ) : (
                <div className="space-y-1 max-h-40 overflow-auto pr-1">
                  {perTarget.map((row) => (
                    <div key={String(row.target)} className="grid grid-cols-[70px_1fr_1fr_1fr_1fr] gap-2 text-xs">
                      <span className="text-zinc-200">{String(row.target)}</span>
                      <span className="text-zinc-400">D:{Number(row.darts ?? 0)}</span>
                      <span className="text-cyan-300">H:{(Number(row.hitRate ?? 0) * 100).toFixed(1)}%</span>
                      <span className="text-emerald-300">A:{Number(row.avgScorePerDart ?? 0).toFixed(2)}</span>
                      <span className="text-indigo-300">V:{(Number(row.avgScorePerDart ?? 0) * powerVisitSize).toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      <ScoreCorrection
        isOpen={correctionOpen}
        onClose={() => setCorrectionOpen(false)}
        dartIndex={correctionDartIndex}
        originalScore={slotScores[correctionDartIndex]}
        onSaveCorrection={handleSaveCorrection}
        onDeleteImages={(dartIndex) => {
          void deleteCorrectionImages(dartIndex);
        }}
        onAddDart={handleAddDart}
      />
    </div>
  );
}
