import React from "react";
import { useLobby } from "../../context/LobbyContext";

const modeOptions = [
  {
    id: "legs_sets" as const,
    label: "Legs & Sets",
    description: "Standard match format. Use the Match Format card to pick legs and sets.",
  },
  {
    id: "free_play" as const,
    label: "Free Play",
    description: "Keep playing legs until you tap Finish. We’ll total stats across all completed legs.",
  },
];

const roundRanges = [
  { id: "1-10" as const, label: "Rounds 1–10" },
  { id: "1-20" as const, label: "Rounds 1–20" },
];

const ShanghaiOptions = React.memo(() => {
  const { state, dispatch } = useLobby();
  const { shanghai } = state;

  return (
    <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 h-full">
      <h2 className="text-lg font-semibold mb-4 tracking-wide text-white">Shanghai Options</h2>

      {/* Mode */}
      <div className="mb-6 pb-6 border-b border-white/10">
        <h3 className="text-sm uppercase tracking-widest text-zinc-400 mb-3">Mode</h3>
        <select
          value={shanghai.mode}
          onChange={(e) => dispatch({ type: "SET_SHANGHAI", payload: { mode: e.target.value as "legs_sets" | "free_play" } })}
          className="w-full rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none"
        >
          {modeOptions.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
        <p className="text-xs text-zinc-400 mt-2">
          {modeOptions.find((option) => option.id === shanghai.mode)?.description}
        </p>
      </div>

      {/* Round range */}
      <div>
        <h3 className="text-sm uppercase tracking-widest text-zinc-400 mb-3">Rounds</h3>
        <select
          value={shanghai.roundRange}
          onChange={(e) => dispatch({ type: "SET_SHANGHAI", payload: { roundRange: e.target.value as "1-10" | "1-20" } })}
          className="w-full rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none"
        >
          {roundRanges.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
        <p className="text-xs text-zinc-500 mt-2">
          Each round targets its number. Hitting single+double+triple in the same round wins the leg instantly.
        </p>
      </div>
    </div>
  );
});

ShanghaiOptions.displayName = "ShanghaiOptions";

export default ShanghaiOptions;
