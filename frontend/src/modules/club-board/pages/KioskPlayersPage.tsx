import React from "react";

import { getKioskState, saveKioskState } from "../kioskState";

export default function KioskPlayersPage() {
  const initial = React.useMemo(() => getKioskState(), []);
  const [count, setCount] = React.useState(initial.playerCount);

  const canDecrease = count > 1;
  const canIncrease = count < 8;

  const updateCount = (next: number) => {
    setCount(next);
    saveKioskState({ playerCount: next });
  };

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      <div
        className="pointer-events-none fixed inset-0 [background:
          radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
          radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
          radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
          radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
          linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
        ]"
      />
      <div className="relative z-10 p-8 md:p-10">
        <div className="max-w-4xl mx-auto border border-white/10 rounded-2xl bg-zinc-900/60 p-6 md:p-8">
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500 mb-3">Kiosk Setup</p>
          <h1 className="text-3xl md:text-5xl font-extrabold text-white">How many players?</h1>
          <p className="text-zinc-300 mt-3 mb-8">Choose between 1 and 8 players for this match.</p>

          <div className="flex items-center justify-center gap-5 mb-10">
            <button
              type="button"
              disabled={!canDecrease}
              onClick={() => updateCount(count - 1)}
              className="h-16 w-16 rounded-xl border border-zinc-700 bg-zinc-900 text-3xl disabled:opacity-40 hover:bg-zinc-800"
            >
              -
            </button>
            <div className="min-w-[140px] text-center">
              <div className="text-7xl font-black text-white">{count}</div>
              <div className="text-sm text-zinc-400 mt-1">{count === 1 ? "Player" : "Players"}</div>
            </div>
            <button
              type="button"
              disabled={!canIncrease}
              onClick={() => updateCount(count + 1)}
              className="h-16 w-16 rounded-xl border border-zinc-700 bg-zinc-900 text-3xl disabled:opacity-40 hover:bg-zinc-800"
            >
              +
            </button>
          </div>

          <div className="flex flex-wrap gap-3">
            <a href="#/kiosk" className="rounded-lg border border-zinc-700 px-5 py-2 text-zinc-200 hover:bg-zinc-800/70">
              Back
            </a>
            <a href="#/kiosk/names" className="rounded-lg border border-red-600/70 bg-red-600/90 px-5 py-2 text-white hover:bg-red-500">
              Next
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
