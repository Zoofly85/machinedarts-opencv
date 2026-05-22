import React, { useState } from "react";
import { HashRouter as Router, Navigate, Route, Routes } from "react-router-dom";

import { LobbyProvider } from "../../game/context/LobbyContext";
import BackendLoadingScreen from "../../game/components/BackendLoadingScreen";
import { isOwnerAnalyticsUiEnabled } from "../../config/ownerAnalyticsUi";

const HomePage = React.lazy(() => import("../../game/pages/HomePage"));
const PracticePage = React.lazy(() => import("../../game/pages/PracticePage"));
const GamesPage = React.lazy(() => import("../../game/pages/GamesPage"));
const CustomGamesPage = React.lazy(() => import("../../game/pages/CustomGamesPage"));
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
const TrainingProgramsPage = React.lazy(() => import("../../game/pages/TrainingProgramsPage"));
const TrainingSessionPage = React.lazy(() => import("../../game/pages/TrainingSessionPage"));
const TournamentsPage = React.lazy(() => import("../../game/pages/TournamentsPage"));
const BullOffPage = React.lazy(() => import("../../game/pages/BullOffPage"));
const PlaygroundsPage = React.lazy(() => import("../../game/pages/PlaygroundsPage"));
const PlaygroundsGamePage = React.lazy(() => import("../../game/pages/PlaygroundsGamePage"));
const OnlinePage = React.lazy(() => import("../../game/pages/OnlinePage"));
const OnlineLobbyPage = React.lazy(() => import("../../game/pages/OnlineLobbyPage"));
const OnlineConnectPage = React.lazy(() => import("../../game/pages/OnlineConnectPage"));
const OnlineX01GamePage = React.lazy(() => import("../../game/pages/OnlineX01GamePage"));
const OnlineFlowTestPage = React.lazy(() => import("../../game/pages/OnlineFlowTestPage"));
const OwnerAnalyticsPage = React.lazy(() => import("../../game/pages/OwnerAnalyticsPage"));
const ProfilePage = React.lazy(() => import("../../game/pages/ProfilePage"));
const MatchHistoryPage = React.lazy(() => import("../../game/pages/MatchHistoryPage"));
const SoundSettingsPage = React.lazy(() => import("../../game/pages/SoundSettingsPage"));
const ComingSoonPage = React.lazy(() => import("../../game/pages/ComingSoonPage"));

const CalibrationPage = React.lazy(() => import("../../pages/CalibrationPage"));
const DetectionSettingsPage = React.lazy(() => import("../../pages/DetectionSettingsPage"));
const SystemAccuracyPage = React.lazy(() => import("../../pages/SystemAccuracyPage"));
const ModelsSettingsPage = React.lazy(() => import("../../pages/ModelsSettingsPage"));
const ModelStatsPage = React.lazy(() => import("../../pages/ModelStatsPage"));
const RuntimeSettingsPage = React.lazy(() => import("../../pages/RuntimeSettingsPage"));
const PlayerBotsPage = React.lazy(() => import("../../pages/PlayerBotsPage"));
const WledSettingsPage = React.lazy(() => import("../../pages/WledSettingsPage"));

export default function HomeShell() {
  const [backendReady, setBackendReady] = useState(false);
  const ownerAnalyticsUiEnabled = isOwnerAnalyticsUiEnabled();

  React.useEffect(() => {
    if (!backendReady) return;
    const timer = window.setTimeout(() => {
      void import("../../game/services/playerBotAutoSync").then(({ syncPlayerBotsWithCloud }) => syncPlayerBotsWithCloud()).then(
        (result) => {
          if (result.sharedProfilesSynced || result.installedBotsUpdated) {
            console.info("[player-bots] background sync complete", result);
          }
        },
        (err) => {
          console.info("[player-bots] background sync skipped", err instanceof Error ? err.message : String(err));
        },
      );
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [backendReady]);

  if (!backendReady) {
    return <BackendLoadingScreen onReady={() => setBackendReady(true)} />;
  }

  return (
    <Router>
      <LobbyProvider>
        <React.Suspense
          fallback={
            <div className="min-h-screen bg-black text-white flex items-center justify-center">
              <div className="text-sm text-zinc-400">Loading...</div>
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/play" element={<Navigate to="/" replace />} />
            <Route path="/practice" element={<PracticePage />} />
            <Route path="/game" element={<GamesPage />} />
            <Route path="/games" element={<GamesPage />} />
            <Route path="/custom-games" element={<CustomGamesPage />} />
            <Route path="/lobby" element={<LobbyPage />} />
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
            <Route path="/training" element={<TrainingProgramsPage />} />
            <Route path="/training/session/:sessionId" element={<TrainingSessionPage />} />
            <Route path="/tournaments" element={<TournamentsPage />} />
            <Route path="/tournaments/create" element={<TournamentsPage />} />
            <Route path="/online" element={<OnlinePage />} />
            <Route path="/online/lobby" element={<OnlineLobbyPage />} />
            <Route path="/online/connect" element={<OnlineConnectPage />} />
            <Route path="/online/x01" element={<OnlineX01GamePage />} />
            <Route path="/online/test" element={<OnlineFlowTestPage />} />
            <Route
              path="/owner-analytics"
              element={ownerAnalyticsUiEnabled ? <OwnerAnalyticsPage /> : <Navigate to="/" replace />}
            />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/profile/history" element={<MatchHistoryPage />} />
            <Route path="/settings/sound" element={<SoundSettingsPage />} />
            <Route path="/bull-off" element={<BullOffPage />} />
            <Route path="/playgrounds" element={<PlaygroundsPage />} />
            <Route path="/playgrounds/play" element={<PlaygroundsGamePage />} />
            <Route path="/atc" element={<ComingSoonPage />} />

            <Route path="/calibrate" element={<CalibrationPage />} />
            <Route path="/calibration" element={<CalibrationPage />} />
            <Route path="/settings/detection" element={<DetectionSettingsPage />} />
            <Route path="/settings/system-accuracy" element={<SystemAccuracyPage />} />
            <Route path="/settings/models" element={<ModelsSettingsPage />} />
            <Route path="/settings/runtime" element={<RuntimeSettingsPage />} />
            <Route path="/settings/player-bots" element={<PlayerBotsPage />} />
            <Route path="/settings/wled" element={<WledSettingsPage />} />
            <Route path="/stats" element={<ModelStatsPage />} />

            <Route path="/console" element={<Navigate to="/settings/runtime" replace />} />
            <Route path="/backend-control" element={<Navigate to="/settings/runtime" replace />} />
            <Route path="/backend-calibrate" element={<Navigate to="/calibration" replace />} />
            <Route path="/backend-settings" element={<Navigate to="/settings/runtime" replace />} />
            <Route path="/backend-settings/detection" element={<Navigate to="/settings/detection" replace />} />
            <Route path="/settings/model-stats" element={<Navigate to="/stats" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </React.Suspense>
      </LobbyProvider>
    </Router>
  );
}
