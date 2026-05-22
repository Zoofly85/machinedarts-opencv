import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import Logo from './Logo';
import { connectSystemStatus } from '../../services/systemStatusSocket';

interface InitializationStep {
  status: 'pending' | 'in_progress' | 'completed' | 'error';
  message: string;
}

interface InitializationStatus {
  is_ready: boolean;
  current_step: string;
  steps: {
    cameras: InitializationStep;
    calibration: InitializationStep;
    models: InitializationStep;
    warmup: InitializationStep;
    services: InitializationStep;
    detection: InitializationStep;
  };
  error: string | null;
  uptime_s?: number;
  diagnostics?: {
    camera_indices?: number[];
    scoring_camera_count?: number;
    camera_backend_hint?: string;
    cameras?: Array<{
      slot: number;
      index: number;
      role: string;
      name: string;
      opened: boolean;
      has_recent_frame: boolean;
      frame_age_ms: number | null;
      frame_mean: number | null;
      error?: string | null;
      looks_black: boolean;
      backend: string | null;
      codec: string | null;
      width: number | null;
      height: number | null;
      fps: number | null;
    }>;
  };
}

interface BackendLoadingScreenProps {
  onReady: () => void;
}

const BackendLoadingScreen: React.FC<BackendLoadingScreenProps> = ({ onReady }) => {
  const [status, setStatus] = useState<InitializationStatus | null>(null);
  const [socketState, setSocketState] = useState<"connecting" | "open" | "closed" | "error">("connecting");
  const [startedAt] = useState(() => Date.now());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const elapsedSeconds = Math.floor((nowMs - startedAt) / 1000);
  const canContinue = elapsedSeconds >= 20 || Boolean(status);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let mounted = true;
    let readyTimeout: number | null = null;
    const disconnect = connectSystemStatus((payload) => {
      const init = payload.initialization;
      if (!init || typeof init !== "object") {
        return;
      }
      const data = init as InitializationStatus;
      if (!mounted) return;
      setStatus(data);

      if (data.is_ready) {
        if (readyTimeout != null) {
          window.clearTimeout(readyTimeout);
        }
        readyTimeout = window.setTimeout(() => onReady(), 350);
      }
    }, (state) => {
      if (!mounted) return;
      setSocketState(state);
    });

    return () => {
      mounted = false;
      if (readyTimeout != null) {
        window.clearTimeout(readyTimeout);
      }
      disconnect();
    };
  }, [onReady]);

  const getStepIcon = (stepStatus: string) => {
    switch (stepStatus) {
      case 'completed':
        return <CheckCircle className="h-5 w-5 text-green-400" />;
      case 'in_progress':
        return <Loader2 className="h-5 w-5 text-blue-400 animate-spin" />;
      case 'error':
        return <AlertCircle className="h-5 w-5 text-red-400" />;
      default:
        return <div className="h-5 w-5 rounded-full border-2 border-blue-400/30" />;
    }
  };

  const getStepColor = (stepStatus: string) => {
    switch (stepStatus) {
      case 'completed':
        return 'text-green-300';
      case 'in_progress':
        return 'text-blue-300';
      case 'error':
        return 'text-red-300';
      default:
        return 'text-blue-300/50';
    }
  };

  const steps = [
    { key: 'cameras', label: 'Camera Initialization' },
    { key: 'calibration', label: 'Loading Calibration' },
    { key: 'models', label: 'Loading AI Models' },
    { key: 'warmup', label: 'Warming Up Models' },
    { key: 'services', label: 'Starting Services' },
    { key: 'detection', label: 'Starting Detection' },
  ];
  const cameraDiagnostics = status?.diagnostics?.cameras ?? [];
  const completedSteps = status?.steps ? Object.values(status.steps).filter(s => s.status === 'completed').length : 0;

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      {/* Reflective glossy edges - matching HomePage */}
      <div className="pointer-events-none fixed inset-0 [background:
        radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
        radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
        radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
        radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
        linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95) 30%,rgba(255,255,255,0.04) 60%,rgba(0,0,0,1) 100%)
      ]" />

      {/* Header with Logo */}
      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between">
        <Logo />
      </header>

      {/* Main Content */}
      <main className="relative z-10 w-full px-6 md:px-10 flex items-center justify-center min-h-[calc(100vh-160px)]">
        <div className="max-w-2xl w-full">
          {/* Title */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="text-center mb-12"
          >
            <h1 className="text-5xl sm:text-6xl font-extrabold mb-4">
              Initializing <span className="text-red-500">System</span>
            </h1>
            <p className="text-xl text-zinc-400">
              Preparing cameras, models, and detection
            </p>
            <div className="mt-4 inline-flex items-center gap-3 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-zinc-300">
              <span>Backend socket: <span className={socketState === "open" ? "text-green-300" : socketState === "error" ? "text-red-300" : "text-yellow-300"}>{socketState}</span></span>
              <span className="text-zinc-600">|</span>
              <span>Waiting {elapsedSeconds}s</span>
              {typeof status?.uptime_s === "number" && (
                <>
                  <span className="text-zinc-600">|</span>
                  <span>Backend up {status.uptime_s}s</span>
                </>
              )}
            </div>
          </motion.div>

          {/* Loading Steps */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="backdrop-blur-md bg-white/5 rounded-lg p-8 border border-white/10"
          >
            <div className="space-y-3">
              {steps.map((step, index) => {
                const stepData = status?.steps[step.key as keyof typeof status.steps];
                const stepStatus = stepData?.status || 'pending';
                const stepMessage = stepData?.message || step.label;
                
                return (
                  <motion.div
                    key={step.key}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.4, delay: index * 0.1 }}
                    className="flex items-center gap-4 p-4 rounded-lg bg-white/5 border border-white/10 transition-all duration-300"
                  >
                    <div className="flex-shrink-0">
                      {getStepIcon(stepStatus)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className={`font-semibold ${getStepColor(stepStatus)}`}>
                        {step.label}
                      </div>
                      <div className="text-sm text-zinc-400 mt-0.5 truncate">
                        {stepMessage}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>

            {/* Error Display */}
            {status?.error && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="mt-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg backdrop-blur-md"
              >
                <div className="flex items-center gap-3">
                  <AlertCircle className="h-5 w-5 text-red-400 flex-shrink-0" />
                  <div>
                    <div className="font-semibold text-red-400">Initialization Error</div>
                    <div className="text-sm text-red-300/70 mt-1">{status.error}</div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Progress Bar */}
            <div className="mt-6">
              <div className="flex justify-between text-sm text-zinc-400 mb-2">
                <span>Progress</span>
                <span>
                  {completedSteps} / {steps.length}
                </span>
              </div>
              <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
                <motion.div
                  initial={{ width: '0%' }}
                  animate={{
                    width: status
                      ? `${(completedSteps / steps.length) * 100}%`
                      : '0%'
                  }}
                  transition={{ duration: 0.5, ease: 'easeOut' }}
                  className="bg-gradient-to-r from-blue-500 to-green-500 h-full"
                />
              </div>
            </div>

            <div className="mt-6 rounded-lg border border-white/10 bg-black/30 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-white">Startup diagnostics</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Backend: {status?.diagnostics?.camera_backend_hint || "waiting"} | Mapping: {(status?.diagnostics?.camera_indices || []).join(", ") || "waiting"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onReady}
                  disabled={!canContinue}
                  className="rounded-lg border border-white/15 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Continue anyway
                </button>
              </div>

              <div className="mt-4 grid gap-2">
                {cameraDiagnostics.length > 0 ? cameraDiagnostics.map((camera) => {
                  const live = camera.opened && camera.has_recent_frame && !camera.looks_black;
                  const statusText = live
                    ? "Live"
                    : camera.error
                      ? "Setup required"
                    : camera.looks_black
                      ? "Black frame"
                      : camera.opened
                        ? "No recent frame"
                        : "Not opened";
                  return (
                    <div key={`${camera.slot}-${camera.index}`} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm font-semibold text-zinc-100">
                          {camera.name} <span className="text-xs font-normal text-zinc-500">slot {camera.slot} / device {camera.index}</span>
                        </div>
                        <div className={live ? "text-xs font-semibold text-green-300" : camera.looks_black ? "text-xs font-semibold text-red-300" : "text-xs font-semibold text-yellow-300"}>
                          {statusText}
                        </div>
                      </div>
                      <div className="mt-1 text-xs text-zinc-400">
                        {camera.backend || "-"} / {camera.codec || "-"} | {camera.width || "-"}x{camera.height || "-"}@{camera.fps || "-"} | frame age {camera.frame_age_ms ?? "-"}ms | brightness {camera.frame_mean ?? "-"}
                      </div>
                      {camera.error && (
                        <div className="mt-2 rounded border border-red-500/20 bg-red-500/10 px-2 py-1 text-xs text-red-100">
                          {camera.error}
                        </div>
                      )}
                    </div>
                  );
                }) : (
                  <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3 text-sm text-zinc-400">
                    Waiting for backend camera diagnostics...
                  </div>
                )}
              </div>

              <div className="mt-4 rounded-lg border border-yellow-500/20 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-100">
                If this screen is stuck, send a photo of this panel. It shows the exact camera slot, backend, frame age, and black-frame state.
              </div>
            </div>
          </motion.div>

        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-white/10 py-6 text-center text-xs text-zinc-500">
        © {new Date().getFullYear()} Machine Darts · Built for precision
      </footer>
    </div>
  );
};

export default BackendLoadingScreen;
