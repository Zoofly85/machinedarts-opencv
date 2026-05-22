import React from "react";
import { motion } from "framer-motion";
import { PlayCircle, Target, User, LayoutGrid, Compass, Settings } from "lucide-react";
import Logo from "../components/Logo";
import DartboardSVG from "../components/DartboardSVG";
import ActionButton from "../components/ActionButton";
import { getBackendUiBaseUrl } from "../services/runtimeUrls";

export default function HomePage() {
  const [dartboardSize, setDartboardSize] = React.useState(700);
  const backendUiBaseUrl = React.useMemo(() => getBackendUiBaseUrl(), []);
  const backendCalibrationUrl = `${backendUiBaseUrl}/#/calibration`;
  const backendSettingsUrl = `${backendUiBaseUrl}/#/settings/runtime`;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      if (key === "p") window.location.hash = "#/practice";
      if (key === "g") window.location.hash = "#/game";
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => {
    const updateSize = () => {
      const maxWidth = Math.min(window.innerWidth * 0.95, 800);
      const maxHeight = Math.min(window.innerHeight * 0.8, 800);
      setDartboardSize(Math.min(maxWidth, maxHeight));
    };

    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      <div className="pointer-events-none fixed inset-0 [background:
        radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
        radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
        radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
        radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
        linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95) 30%,rgba(255,255,255,0.04) 60%,rgba(0,0,0,1) 100%)
      ]" />

      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between">
        <Logo />
      </header>

      <main className="relative z-10 w-full px-6 md:px-10 flex-1 flex items-center">
        <section className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-4 items-center py-8 w-full min-h-[calc(100vh-160px)]">
          <div className="space-y-12 max-w-3xl mx-auto">
            <motion.h1
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="text-6xl sm:text-7xl font-extrabold leading-tight text-center lg:text-left"
            >
              Precision <span className="text-red-500">Automatic</span> Dart Scoring
            </motion.h1>

            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.1 }}
              className="flex flex-col gap-6 w-full max-w-xl mx-auto lg:mx-0"
            >
              <ActionButton
                href="/practice"
                label="Practice"
                aria="Start practice session"
                icon={<Target className="h-7 w-7" />}
                kbd="P"
              />
              <ActionButton
                href="/game"
                label="Game"
                aria="Start a new match"
                icon={<PlayCircle className="h-7 w-7" />}
                kbd="G"
              />
              <ActionButton
                href="/custom-games"
                label="Custom Games"
                aria="Browse custom web games"
                icon={<LayoutGrid className="h-7 w-7" />}
              />
              <ActionButton
                href="/profile"
                label="Profiles"
                aria="View player profiles and stats"
                icon={<User className="h-7 w-7" />}
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <a
                  href={backendCalibrationUrl}
                  className="group inline-flex items-center justify-between gap-4 w-full rounded-2xl px-8 py-5 text-lg font-semibold tracking-wide border border-white/20 bg-white/5 text-white hover:border-cyan-400 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-500 transition"
                >
                  <span className="flex items-center gap-3">
                    <Compass className="h-7 w-7" />
                    Calibration
                  </span>
                </a>
                <a
                  href={backendSettingsUrl}
                  className="group inline-flex items-center justify-between gap-4 w-full rounded-2xl px-8 py-5 text-lg font-semibold tracking-wide border border-white/20 bg-white/5 text-white hover:border-cyan-400 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-500 transition"
                >
                  <span className="flex items-center gap-3">
                    <Settings className="h-7 w-7" />
                    Backend Settings
                  </span>
                </a>
              </div>
            </motion.div>
          </div>

          <div className="relative flex items-center justify-center w-full h-full">
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 120, damping: 18 }}
              className="relative w-full h-full flex items-center justify-center"
            >
              <motion.div
                initial={{ rotate: 0 }}
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, repeatType: "loop", duration: 24, ease: "linear" }}
                style={{ transformOrigin: "50% 50%" }}
                className="drop-shadow-[0_0_60px_rgba(220,38,38,0.4)]"
              >
                <DartboardSVG size={dartboardSize} />
              </motion.div>
            </motion.div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/10 py-6 text-center text-xs text-zinc-500">
        © {new Date().getFullYear()} Machine Darts
      </footer>
    </div>
  );
}
