import React, { useState } from "react";
import { HashRouter as Router, Navigate, Route, Routes, useLocation } from "react-router-dom";

import { LobbyProvider } from "../../game/context/LobbyContext";
import BackendLoadingScreen from "../../game/components/BackendLoadingScreen";
import { sendBoardHeartbeat } from "./services/heartbeat";
import BoardSetupPage from "./pages/BoardSetupPage";
import KioskHomePage from "./pages/KioskHomePage";
import KioskPlayersPage from "./pages/KioskPlayersPage";
import KioskNamesPage from "./pages/KioskNamesPage";
import KioskGamesPage from "./pages/KioskGamesPage";
import KioskConfirmPage from "./pages/KioskConfirmPage";
import { endClubKioskSession, getClubKioskSession, isClubKioskSessionExpired, touchClubKioskSession } from "./kioskSession";
import SessionPlayerStatsModal from "./components/SessionPlayerStatsModal";

const GamesPage = React.lazy(() => import("../../game/pages/GamesPage"));
const LobbyPage = React.lazy(() => import("../../game/pages/LobbyPage"));
const X01GamePage = React.lazy(() => import("../../game/pages/X01GamePage"));
const X01StatsPage = React.lazy(() => import("../../game/pages/X01StatsPage"));
const X01AdvancedStatsPage = React.lazy(() => import("../../game/pages/X01AdvancedStatsPage"));
const CricketGamePage = React.lazy(() => import("../../game/pages/CricketGamePage"));
const CricketStatsPage = React.lazy(() => import("../../game/pages/CricketStatsPage"));
const AroundTheClockGamePage = React.lazy(() => import("../../game/pages/AroundTheClockGamePage"));
const AroundTheClockStatsPage = React.lazy(() => import("../../game/pages/AroundTheClockStatsPage"));
const BeerRaceGamePage = React.lazy(() => import("../../game/pages/BeerRaceGamePage"));
const BeerRaceStatsPage = React.lazy(() => import("../../game/pages/BeerRaceStatsPage"));
const ShanghaiGamePage = React.lazy(() => import("../../game/pages/ShanghaiGamePage"));
const ShanghaiStatsPage = React.lazy(() => import("../../game/pages/ShanghaiStatsPage"));
const Bob27GamePage = React.lazy(() => import("../../game/pages/Bob27GamePage"));
const Bob27StatsPage = React.lazy(() => import("../../game/pages/Bob27StatsPage"));
const BermudaGamePage = React.lazy(() => import("../../game/pages/BermudaGamePage"));
const BermudaStatsPage = React.lazy(() => import("../../game/pages/BermudaStatsPage"));
const OneTwoOneGamePage = React.lazy(() => import("../../game/pages/OneTwoOneGamePage"));
const OneTwoOneStatsPage = React.lazy(() => import("../../game/pages/OneTwoOneStatsPage"));
const PacmanGamePage = React.lazy(() => import("../../game/pages/PacmanGamePage"));
const PacmanStatsPage = React.lazy(() => import("../../game/pages/PacmanStatsPage"));
const TargetTrainerGamePage = React.lazy(() => import("../../game/pages/TargetTrainerGamePage"));
const TargetTrainerStatsPage = React.lazy(() => import("../../game/pages/TargetTrainerStatsPage"));
const PracticePage = React.lazy(() => import("../../game/pages/PracticePage"));
const BullOffPage = React.lazy(() => import("../../game/pages/BullOffPage"));

function ClubKioskSessionKeeper() {
  const location = useLocation();
  const isKioskOrSetupRoute = React.useMemo(
    () => location.pathname.startsWith("/kiosk") || location.pathname.startsWith("/setup") || location.pathname === "/",
    [location.pathname],
  );

  React.useEffect(() => {
    const markActivity = () => {
      if (getClubKioskSession()) {
        touchClubKioskSession();
      }
    };
    markActivity();
    window.addEventListener("pointerdown", markActivity, { passive: true });
    window.addEventListener("keydown", markActivity);
    window.addEventListener("touchstart", markActivity, { passive: true });
    window.addEventListener("focus", markActivity);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") markActivity();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pointerdown", markActivity);
      window.removeEventListener("keydown", markActivity);
      window.removeEventListener("touchstart", markActivity);
      window.removeEventListener("focus", markActivity);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  React.useEffect(() => {
    const enforceSessionRules = () => {
      const session = getClubKioskSession();
      if (session && isClubKioskSessionExpired(session)) {
        endClubKioskSession();
        window.location.hash = "#/kiosk";
        return;
      }
      if (!session && !isKioskOrSetupRoute) {
        window.location.hash = "#/kiosk";
      }
    };
    enforceSessionRules();
    const id = window.setInterval(enforceSessionRules, 5000);
    return () => window.clearInterval(id);
  }, [isKioskOrSetupRoute]);

  return null;
}

export default function ClubBoardShell() {
  const [backendReady, setBackendReady] = useState(false);

  React.useEffect(() => {
    if (!backendReady) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const hash = window.location.hash || "#/";
      const inGame = hash.includes("/x01") ||
        hash.includes("/cricket") ||
        hash.includes("/around-the-clock") ||
        hash.includes("/beer-race") ||
        hash.includes("/shanghai") ||
        hash.includes("/bob27") ||
        hash.includes("/bermuda") ||
        hash.includes("/one-two-one") ||
        hash.includes("/pacman") ||
        hash.includes("/target-trainer");
      try {
        await sendBoardHeartbeat({
          status: inGame ? "in_session" : "idle",
          shell: "club-board",
          active_game: inGame ? hash.replace(/^#\//, "") : "",
          fps: null,
          diagnostics: { route: hash },
        });
      } catch {
        // Non-fatal; heartbeat retry on next interval.
      }
    };
    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, 5000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [backendReady]);

  if (!backendReady) {
    return <BackendLoadingScreen onReady={() => setBackendReady(true)} />;
  }

  return (
    <Router>
      <LobbyProvider>
        <ClubKioskSessionKeeper />
        <SessionPlayerStatsModal />
        <React.Suspense
          fallback={
            <div className="min-h-screen bg-black text-white flex items-center justify-center">
              <div className="text-sm text-zinc-400">Loading...</div>
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<Navigate to="/kiosk" replace />} />
            <Route path="/kiosk" element={<KioskHomePage />} />
            <Route path="/kiosk/players" element={<KioskPlayersPage />} />
            <Route path="/kiosk/names" element={<KioskNamesPage />} />
            <Route path="/kiosk/games" element={<KioskGamesPage />} />
            <Route path="/kiosk/confirm" element={<KioskConfirmPage />} />
            <Route path="/setup" element={<BoardSetupPage />} />
            <Route path="/game" element={<GamesPage />} />
            <Route path="/games" element={<GamesPage />} />
            <Route path="/lobby" element={<LobbyPage />} />
            <Route path="/practice" element={<PracticePage />} />
            <Route path="/bull-off" element={<BullOffPage />} />
            <Route path="/x01" element={<X01GamePage />} />
            <Route path="/x01/stats" element={<X01StatsPage />} />
            <Route path="/x01/stats/advanced" element={<X01AdvancedStatsPage />} />
            <Route path="/cricket" element={<CricketGamePage />} />
            <Route path="/cricket/stats" element={<CricketStatsPage />} />
            <Route path="/around-the-clock" element={<AroundTheClockGamePage />} />
            <Route path="/around-the-clock/stats" element={<AroundTheClockStatsPage />} />
            <Route path="/beer-race" element={<BeerRaceGamePage />} />
            <Route path="/beer-race/stats" element={<BeerRaceStatsPage />} />
            <Route path="/shanghai" element={<ShanghaiGamePage />} />
            <Route path="/shanghai/stats" element={<ShanghaiStatsPage />} />
            <Route path="/bob27" element={<Bob27GamePage />} />
            <Route path="/bob27/stats" element={<Bob27StatsPage />} />
            <Route path="/bermuda" element={<BermudaGamePage />} />
            <Route path="/bermuda/stats" element={<BermudaStatsPage />} />
            <Route path="/one-two-one" element={<OneTwoOneGamePage />} />
            <Route path="/one-two-one/stats" element={<OneTwoOneStatsPage />} />
            <Route path="/pacman" element={<PacmanGamePage />} />
            <Route path="/pacman/stats" element={<PacmanStatsPage />} />
            <Route path="/target-trainer" element={<TargetTrainerGamePage />} />
            <Route path="/target-trainer/stats" element={<TargetTrainerStatsPage />} />
            <Route path="*" element={<Navigate to="/kiosk" replace />} />
          </Routes>
        </React.Suspense>
      </LobbyProvider>
    </Router>
  );
}
