import React, { useState } from "react";
import { HashRouter as Router, Navigate, Route, Routes } from "react-router-dom";

import BackendLoadingScreen from "../../game/components/BackendLoadingScreen";
import MasterDashboardPage from "./pages/MasterDashboardPage";
import MasterPlayerProfilePage from "./pages/MasterPlayerProfilePage";
import MasterPlayersPage from "./pages/MasterPlayersPage";
import MasterSocialNightPage from "./pages/MasterSocialNightPage";
import MasterSetupPage from "./pages/MasterSetupPage";

export default function ClubMasterShell() {
  const [backendReady, setBackendReady] = useState(false);

  if (!backendReady) {
    return <BackendLoadingScreen onReady={() => setBackendReady(true)} />;
  }

  return (
    <Router>
      <React.Suspense
        fallback={
          <div className="min-h-screen bg-black text-white flex items-center justify-center">
            <div className="text-sm text-zinc-400">Loading...</div>
          </div>
        }
      >
        <Routes>
          <Route path="/" element={<Navigate to="/club/master" replace />} />
          <Route path="/club/master" element={<MasterDashboardPage />} />
          <Route path="/club/master/social-night" element={<MasterSocialNightPage />} />
          <Route path="/club/master/players" element={<MasterPlayersPage />} />
          <Route path="/club/master/players/:playerId" element={<MasterPlayerProfilePage />} />
          <Route path="/club/master/setup" element={<MasterSetupPage />} />
          <Route path="*" element={<Navigate to="/club/master" replace />} />
        </Routes>
      </React.Suspense>
    </Router>
  );
}
