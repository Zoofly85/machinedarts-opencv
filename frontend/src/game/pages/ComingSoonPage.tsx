import React from "react";
import { useLocation, useNavigate } from "react-router-dom";

export default function ComingSoonPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const label = location.pathname.replace("/", "").toUpperCase() || "GAME";

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden flex flex-col items-center justify-center px-6">
      <div
        className="pointer-events-none fixed inset-0 [background:
          radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
          radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
          radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
          radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
          linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
        ]"
      />
      <div className="relative z-10 text-center space-y-6">
        <h1 className="text-4xl font-extrabold tracking-tight">{label} MODE</h1>
        <p className="text-zinc-400 max-w-xl">
          This game screen is on the roadmap. Your lobby configuration is preserved, so once the mode is available you'll jump right into a match.
        </p>
        <button
          onClick={() => navigate("/lobby")}
          className="rounded-xl bg-red-600 px-6 py-3 text-base font-semibold text-white transition hover:bg-red-500"
        >
          Lobby
        </button>
      </div>
    </div>
  );
}
