import React from "react";

import { getKioskState, saveKioskState, type KioskGame } from "../kioskState";

const GAMES: Array<{ id: KioskGame; label: string; description: string }> = [
  { id: "x01", label: "X01", description: "301 / 501 / 701 style game" },
  { id: "cricket", label: "Cricket", description: "Standard and cutthroat format" },
  { id: "pacman", label: "PacDarts", description: "Eat pellets on S/D/T/Bull hits" },
  { id: "around_the_clock", label: "Around The Clock", description: "Hit numbers in order" },
  { id: "shanghai", label: "Shanghai", description: "Single, double, triple rounds" },
  { id: "beer_race", label: "Beer Race", description: "Race to target score" },
  { id: "bob27", label: "Bob 27", description: "Doubles ladder challenge" },
  { id: "bermuda", label: "Bermuda", description: "13 rounds, miss penalty" },
  { id: "one_two_one", label: "One Two One", description: "Checkout ladder mode" },
  { id: "target_trainer", label: "Target Trainer", description: "Repeated target practice" },
];

export default function KioskGamesPage() {
  const initial = React.useMemo(() => getKioskState(), []);
  const [game, setGame] = React.useState<KioskGame>(initial.game);

  const handleSelect = (next: KioskGame) => {
    setGame(next);
    saveKioskState({ game: next });
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
        <div className="max-w-6xl mx-auto border border-white/10 rounded-2xl bg-zinc-900/60 p-6 md:p-8">
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500 mb-3">Kiosk Setup</p>
          <h1 className="text-3xl md:text-5xl font-extrabold text-white">Choose game</h1>
          <p className="text-zinc-300 mt-3 mb-7">Pick the game for this match.</p>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {GAMES.map((item) => {
              const active = game === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelect(item.id)}
                  className={`rounded-xl border p-4 text-left transition ${
                    active
                      ? "border-red-500 bg-red-900/25"
                      : "border-white/10 bg-black/40 hover:bg-zinc-900/70"
                  }`}
                >
                  <div className="text-lg font-semibold text-white">{item.label}</div>
                  <div className="text-sm text-zinc-300 mt-1">{item.description}</div>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-3 mt-7">
            <a href="#/kiosk/names" className="rounded-lg border border-zinc-700 px-5 py-2 text-zinc-200 hover:bg-zinc-800/70">
              Back
            </a>
            <a href="#/kiosk/confirm" className="rounded-lg border border-red-600/70 bg-red-600/90 px-5 py-2 text-white hover:bg-red-500">
              Next
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
