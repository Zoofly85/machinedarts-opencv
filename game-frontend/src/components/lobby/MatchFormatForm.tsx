import React from "react";
import { useLobby } from "../../context/LobbyContext";

const MatchFormatForm = React.memo(() => {
  const { state, dispatch } = useLobby();
  const { match } = state;

  const handleSetsChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const sets = Number(event.target.value) || 1;
    dispatch({ type: "SET_MATCH", sets, legs: match.legs });
  };

  const handleLegsChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const legs = Number(event.target.value) || 1;
    dispatch({ type: "SET_MATCH", sets: match.sets, legs });
  };

  const handleFreePlayToggle = () => {
    dispatch({ type: "SET_FREE_PLAY", freePlay: !Boolean(match.freePlay) });
  };

  const handleBullOffToggle = () => {
    dispatch({ type: "SET_BULL_OFF", bullOff: !Boolean(match.bullOff) });
  };

  return (
    <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 h-full">
      <h2 className="text-lg font-semibold mb-4 tracking-wide text-white">Match Format</h2>
      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-3 py-2.5">
          <span className="text-sm text-zinc-300">Free play (manual finish)</span>
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(match.freePlay)}
            onClick={handleFreePlayToggle}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${
              match.freePlay ? "bg-red-600" : "bg-zinc-700"
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                match.freePlay ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-3 py-2.5">
          <span className="text-sm text-zinc-300">Bull-off to decide who starts</span>
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(match.bullOff)}
            onClick={handleBullOffToggle}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${
              match.bullOff ? "bg-red-600" : "bg-zinc-700"
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                match.bullOff ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>
        <label className="block">
          <span className="text-sm text-zinc-400">Sets (best of)</span>
          <select
            value={match.sets}
            onChange={handleSetsChange}
            disabled={match.freePlay}
            className={`mt-1 w-full rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none ${match.freePlay ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            {Array.from({ length: 9 }, (_, i) => i + 1).map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-sm text-zinc-400">Legs per set</span>
          <select
            value={match.legs}
            onChange={handleLegsChange}
            disabled={match.freePlay}
            className={`mt-1 w-full rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none ${match.freePlay ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            {Array.from({ length: 9 }, (_, i) => i + 1).map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
});

MatchFormatForm.displayName = 'MatchFormatForm';

export default MatchFormatForm;
