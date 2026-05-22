import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import Logo from './Logo';

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
}

interface BackendLoadingScreenProps {
  onReady: () => void;
}

const BackendLoadingScreen: React.FC<BackendLoadingScreenProps> = ({ onReady }) => {
  const [status, setStatus] = useState<InitializationStatus | null>(null);

  useEffect(() => {
    let pollInterval: NodeJS.Timeout;
    let mounted = true;

    const checkStatus = async () => {
      try {
        const response = await fetch('http://localhost:8000/api/initialization/status');
        if (!response.ok) {
          throw new Error('Failed to fetch status');
        }
        const data: InitializationStatus = await response.json();
        
        if (mounted) {
          setStatus(data);

          // If backend is ready, notify parent
          if (data.is_ready) {
            clearInterval(pollInterval);
            setTimeout(() => {
              onReady();
            }, 500); // Small delay to show completion
          }
        }
      } catch (error) {
        // Silently retry - don't show error messages during initial connection
        // The loading screen will show once backend responds
      }
    };

    // Initial check
    checkStatus();

    // Poll every 500ms for updates
    pollInterval = setInterval(checkStatus, 500);

    return () => {
      mounted = false;
      clearInterval(pollInterval);
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
              Please wait while we prepare the dart detection system
            </p>
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
                  {status ? Object.values(status.steps).filter(s => s.status === 'completed').length : 0} / {steps.length}
                </span>
              </div>
              <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
                <motion.div
                  initial={{ width: '0%' }}
                  animate={{
                    width: status
                      ? `${(Object.values(status.steps).filter(s => s.status === 'completed').length / steps.length) * 100}%`
                      : '0%'
                  }}
                  transition={{ duration: 0.5, ease: 'easeOut' }}
                  className="bg-gradient-to-r from-blue-500 to-green-500 h-full"
                />
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