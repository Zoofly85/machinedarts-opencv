import React from "react";
import { useLobby } from "../../context/LobbyContext";

const LIFE_OPTIONS = [3, 5, 7, 9];

export default function PacmanOptions() {
  const { state, dispatch } = useLobby();

  return (
    <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 space-y-4">
      <h3 className="text-lg font-semibold text-white">PacDarts Rules</h3>
      <div>
        <label className="block text-xs uppercase tracking-[0.25em] text-zinc-500 mb-2">Lives Per Player</label>
        <div className="grid grid-cols-4 gap-2">
          {LIFE_OPTIONS.map((lives) => {
            const active = state.pacman.livesPerPlayer === lives;
            return (
              <button
                key={lives}
                type="button"
                onClick={() => dispatch({ type: "SET_PACMAN", payload: { livesPerPlayer: lives } })}
                className={`rounded-lg border px-3 py-2 text-sm transition ${
                  active
                    ? "border-emerald-500 bg-emerald-500/20 text-emerald-200"
                    : "border-white/10 bg-black/30 text-zinc-300 hover:border-emerald-500/50"
                }`}
              >
                {lives}
              </button>
            );
          })}
        </div>
      </div>
      <p className="text-xs text-zinc-500">
        Hit a fresh pellet to score. Hit an empty segment (or miss) and lose a life.
      </p>
    </div>
  );
}
