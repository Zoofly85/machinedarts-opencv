import React from "react";
import { useLobby } from "../../context/LobbyContext";

const AroundTheClockOptions: React.FC = () => {
  const { state, dispatch } = useLobby();
  const mode = state.aroundTheClock?.mode || "full";
  const order = state.aroundTheClock?.order || "1-20-bull";
  const hitsRequired = state.aroundTheClock?.hitsRequired || 1;

  const modes = [
    {
      value: "full",
      label: "Full",
      description: "Hit any segment of the target number (single, double, or triple)",
      difficulty: "Easy",
    },
    {
      value: "single",
      label: "Single",
      description: "Must hit only the single segment of the target number",
      difficulty: "Medium",
    },
    {
      value: "double",
      label: "Double",
      description: "Must hit only the double ring of the target number",
      difficulty: "Hard",
    },
    {
      value: "triple",
      label: "Triple",
      description: "Must hit only the triple ring of the target number",
      difficulty: "Expert",
    },
  ];

  return (
    <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6">
      <h2 className="text-lg font-semibold mb-4 tracking-wide text-white">
        Around the Clock Options
      </h2>

      {/* Game Mode Selection */}
      <section className="mb-6">
        <h3 className="text-sm uppercase tracking-widest text-zinc-400 mb-3">Game Mode</h3>
        <select
          value={mode}
          onChange={(e) =>
            dispatch({
              type: "SET_AROUND_THE_CLOCK",
              payload: { mode: e.target.value as any },
            })
          }
          className="w-full rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none"
        >
          {modes.map((modeOption) => (
            <option key={modeOption.value} value={modeOption.value}>{modeOption.label}</option>
          ))}
        </select>
        <p className="text-xs text-zinc-400 mt-2">
          {modes.find((m) => m.value === mode)?.description} · {modes.find((m) => m.value === mode)?.difficulty}
        </p>
      </section>

      {/* Order Selection */}
      <section className="mb-6 pb-6 border-b border-white/10">
        <h3 className="text-sm uppercase tracking-widest text-zinc-400 mb-3">Target Order</h3>
        <select
          value={order}
          onChange={(e) =>
            dispatch({
              type: "SET_AROUND_THE_CLOCK",
              payload: { order: e.target.value as any },
            })
          }
          className="w-full rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none"
        >
          <option value="1-20-bull">1-20-Bull</option>
          <option value="20-1-bull">20-1-Bull</option>
          <option value="random-bull">Random-Bull</option>
        </select>
      </section>

      {/* Hits Required Selection */}
      <section className="mb-6 pb-6 border-b border-white/10">
        <h3 className="text-sm uppercase tracking-widest text-zinc-400 mb-3">Hits Required Per Target</h3>
        <select
          value={hitsRequired}
          onChange={(e) =>
            dispatch({
              type: "SET_AROUND_THE_CLOCK",
              payload: { hitsRequired: Number(e.target.value) as 1 | 2 | 3 },
            })
          }
          className="w-full rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none"
        >
          <option value={1}>1 hit</option>
          <option value={2}>2 hits</option>
          <option value={3}>3 hits</option>
        </select>
        <p className="text-xs text-zinc-400 mt-3">Number of times you must hit each target to advance</p>
      </section>

      {/* Game Rules */}
      <section className="mb-6 pb-6 border-b border-white/10">
        <h3 className="text-sm uppercase tracking-widest text-zinc-400 mb-3">
          How to Play
        </h3>
        <div className="space-y-2 text-sm text-zinc-300">
          <p>• Progress through targets in the selected order</p>
          <p>• Hit your current target {hitsRequired > 1 ? `${hitsRequired} times` : "once"} to advance</p>
          <p>• Accuracy is calculated as: (1 / darts taken) × 100%</p>
          <p>• First player to complete all targets wins the leg</p>
        </div>
      </section>

      {/* Mode-Specific Tips */}
      <section>
        <h3 className="text-sm uppercase tracking-widest text-zinc-400 mb-3">
          Selected Mode Tips
        </h3>
        <div className="bg-black/40 rounded-xl p-4 border border-white/5">
          {mode === "full" && (
            <div className="space-y-2 text-sm text-zinc-300">
              <p className="font-semibold text-emerald-400">Full Mode</p>
              <p>
                • Any segment counts (single, double, or triple)
              </p>
              <p>• Largest target area - best for beginners</p>
              <p>• For bull: outer or inner bull both count</p>
            </div>
          )}
          {mode === "single" && (
            <div className="space-y-2 text-sm text-zinc-300">
              <p className="font-semibold text-blue-400">Single Mode</p>
              <p>• Only single segments count</p>
              <p>• Doubles and triples don't advance you</p>
              <p>• For bull: only outer bull counts</p>
            </div>
          )}
          {mode === "double" && (
            <div className="space-y-2 text-sm text-zinc-300">
              <p className="font-semibold text-orange-400">Double Mode</p>
              <p>• Only double ring counts</p>
              <p>• Singles and triples don't advance you</p>
              <p>• For bull: only inner bull (double bull) counts</p>
            </div>
          )}
          {mode === "triple" && (
            <div className="space-y-2 text-sm text-zinc-300">
              <p className="font-semibold text-red-400">Triple Mode</p>
              <p>• Only triple ring counts</p>
              <p>• Singles and doubles don't advance you</p>
              <p>• Most challenging - narrowest target area</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

export default AroundTheClockOptions;