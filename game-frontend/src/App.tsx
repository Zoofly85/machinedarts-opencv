import React, { useEffect, useRef, useState } from 'react';
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import HomePage from './pages/HomePage';
import PracticePage from './pages/PracticePage';
import GamesPage from './pages/GamesPage';
import LobbyPage from './pages/LobbyPage';
import { LobbyProvider } from './context/LobbyContext';
import ComingSoonPage from './pages/ComingSoonPage';
import CricketGamePage from './pages/CricketGamePage';
import CricketStatsPage from './pages/CricketStatsPage';
import X01GamePage from './pages/X01GamePage';
import X01StatsPage from './pages/X01StatsPage';
import X01AdvancedStatsPage from './pages/X01AdvancedStatsPage';
import AroundTheClockGamePage from './pages/AroundTheClockGamePage';
import AroundTheClockStatsPage from './pages/AroundTheClockStatsPage';
import BeerRaceGamePage from './pages/BeerRaceGamePage';
import BeerRaceStatsPage from './pages/BeerRaceStatsPage';
import ShanghaiGamePage from './pages/ShanghaiGamePage';
import ShanghaiStatsPage from './pages/ShanghaiStatsPage';
import Bob27GamePage from './pages/Bob27GamePage';
import Bob27StatsPage from './pages/Bob27StatsPage';
import BermudaGamePage from './pages/BermudaGamePage';
import BermudaStatsPage from './pages/BermudaStatsPage';
import OneTwoOneGamePage from './pages/OneTwoOneGamePage';
import OneTwoOneStatsPage from './pages/OneTwoOneStatsPage';
import ProfilePage from './pages/ProfilePage';
import MatchHistoryPage from './pages/MatchHistoryPage';
import SoundSettingsPage from './pages/SoundSettingsPage';
import BackendLoadingScreen from './components/BackendLoadingScreen';
import TargetTrainerGamePage from './pages/TargetTrainerGamePage';
import TargetTrainerStatsPage from './pages/TargetTrainerStatsPage';
import BullOffPage from './pages/BullOffPage';
import PlaygroundsPage from './pages/PlaygroundsPage';
import PlaygroundsGamePage from './pages/PlaygroundsGamePage';
import CustomGamesPage from './pages/CustomGamesPage';

const API_BASE = 'http://localhost:8000';
const FRONTEND_ACTIVITY_THROTTLE_MS = 15000;

function App() {
  const [backendReady, setBackendReady] = useState(false);
  const lastActivitySentRef = useRef(0);

  useEffect(() => {
    if (!backendReady) {
      return;
    }

    const sendActivity = () => {
      const now = Date.now();
      if (now - lastActivitySentRef.current < FRONTEND_ACTIVITY_THROTTLE_MS) {
        return;
      }
      lastActivitySentRef.current = now;
      fetch(`${API_BASE}/api/system/activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'frontend' }),
      }).catch(() => undefined);
    };

    const handleActivity = () => sendActivity();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        sendActivity();
      }
    };

    window.addEventListener('mousemove', handleActivity, { passive: true });
    window.addEventListener('keydown', handleActivity, { passive: true });
    window.addEventListener('click', handleActivity, { passive: true });
    window.addEventListener('touchstart', handleActivity, { passive: true });
    window.addEventListener('focus', handleVisibility);
    document.addEventListener('visibilitychange', handleVisibility);

    sendActivity();

    return () => {
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('click', handleActivity);
      window.removeEventListener('touchstart', handleActivity);
      window.removeEventListener('focus', handleVisibility);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [backendReady]);

  // Direct browser load with no hash -> go to gameplay home.
  if (!window.location.hash) {
    const base = `${window.location.origin}${window.location.pathname}${window.location.search}`;
    window.location.replace(`${base}#/`);
    return null;
  }

  if (!backendReady) {
    return <BackendLoadingScreen onReady={() => setBackendReady(true)} />;
  }

  return (
    <Router>
      <LobbyProvider>
        <div className="App">
          <Routes>
            <Route path="/practice" element={<PracticePage />} />
            <Route path="/game" element={<GamesPage />} />
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
            <Route path="/target-trainer" element={<TargetTrainerGamePage />} />
            <Route path="/target-trainer/stats" element={<TargetTrainerStatsPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/profile/history" element={<MatchHistoryPage />} />
            <Route path="/settings/sound" element={<SoundSettingsPage />} />
            <Route path="/bull-off" element={<BullOffPage />} />
            <Route path="/playgrounds" element={<PlaygroundsPage />} />
            <Route path="/playgrounds/play" element={<PlaygroundsGamePage />} />
            <Route path="/custom-games" element={<CustomGamesPage />} />
            <Route path="/atc" element={<ComingSoonPage />} />
            <Route path="/" element={<HomePage />} />
            <Route path="/calibrate" element={<Navigate to="/" replace />} />
            <Route path="/console" element={<Navigate to="/" replace />} />
            <Route path="/backend-control" element={<Navigate to="/" replace />} />
            <Route path="/backend-calibrate" element={<Navigate to="/" replace />} />
            <Route path="/backend-settings" element={<Navigate to="/" replace />} />
            <Route path="/backend-settings/detection" element={<Navigate to="/" replace />} />
            <Route path="/settings/models" element={<Navigate to="/" replace />} />
            <Route path="/settings/model-stats" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </LobbyProvider>
    </Router>
  );
}

export default App;
