import React, { useMemo } from "react";
import { useLobby } from "../../context/LobbyContext";

const presetScores = [301, 401, 501, 601, 701, 1001];

const BeerRaceOptions = React.memo(() => {
  const { state, dispatch } = useLobby();
  const { beerRace } = state;

  const activePreset = useMemo(() => {
    return presetScores.includes(beerRace.targetScore) ? beerRace.targetScore : null;
  }, [beerRace.targetScore]);

  const handlePresetClick = (score: number) => {
    dispatch({ type: "SET_BEER_RACE", payload: { targetScore: score } });
  };

  const handleCustomChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = Math.max(101, Number(event.target.value) || 101);
    dispatch({ type: "SET_BEER_RACE", payload: { targetScore: value } });
  };

  return (
    <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 h-full">
      <h2 className="text-lg font-semibold mb-4 tracking-wide text-white">Beer Race Options</h2>
      
      <div className="mb-4 p-4 bg-amber-900/20 border border-amber-600/30 rounded-lg">
        <p className="text-sm text-amber-200">
          🍺 <strong>Beer Race</strong> is a power-scoring game where players race to reach or exceed the target score as quickly as possible. 
          All scores count - no bust rules! Watch your beer mug fill up as you score!
        </p>
      </div>

      <section>
        <h3 className="text-sm uppercase tracking-widest text-zinc-400 mb-3">Target Score</h3>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
          <select
            value={activePreset ?? "custom"}
            onChange={(e) => {
              if (e.target.value === "custom") return;
              handlePresetClick(Number(e.target.value));
            }}
            className="w-full rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none"
          >
            {presetScores.map((score) => (
              <option key={score} value={score}>{score}</option>
            ))}
            <option value="custom">Custom</option>
          </select>
          <input
            type="number"
            min={101}
            value={beerRace.targetScore}
            onChange={handleCustomChange}
            className="w-full sm:w-28 rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none"
          />
        </div>
        <p className="mt-3 text-xs text-zinc-500">First player to reach or exceed this score wins the leg!</p>
      </section>

      <div className="mt-6 p-4 bg-zinc-800/50 border border-zinc-700 rounded-lg">
        <h4 className="text-sm font-semibold text-white mb-2">Game Rules:</h4>
        <ul className="text-xs text-zinc-400 space-y-1 list-disc list-inside">
          <li>Race to accumulate points and reach the target score</li>
          <li>All dart scores count - no bust rules</li>
          <li>First player to reach or exceed the target wins</li>
          <li>Track your PPR (Points Per Round) and high-scoring visits</li>
          <li>Watch your beer mug fill as you score!</li>
        </ul>
      </div>
    </div>
  );
});

BeerRaceOptions.displayName = 'BeerRaceOptions';

export default BeerRaceOptions;