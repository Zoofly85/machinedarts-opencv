import React, { useMemo } from "react";
import { useLobby } from "../../context/LobbyContext";

const targetTypes = [
  { value: "single", label: "Single", hint: "Any single of chosen number" },
  { value: "double", label: "Double", hint: "Exact double ring" },
  { value: "treble", label: "Treble", hint: "Exact treble ring" },
  { value: "outer_bull", label: "Outer Bull (25)", hint: "Green ring" },
  { value: "inner_bull", label: "Inner Bull (50)", hint: "Red bullseye" },
] as const;

const numberChoices = Array.from({ length: 20 }, (_, i) => i + 1);

const TargetTrainerOptions: React.FC = () => {
  const { state, dispatch } = useLobby();
  const config = state.targetTrainer;

  const isBullType = config.targetType === "outer_bull" || config.targetType === "inner_bull";

  const activeNumbers = useMemo(() => {
    if (isBullType) {
      return [25];
    }
    return numberChoices;
  }, [isBullType]);

  return (
    <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6">
      <h2 className="text-lg font-semibold mb-4 tracking-wide text-white">Target Trainer Options</h2>

      <section className="mb-6 pb-6 border-b border-white/10">
        <h3 className="text-sm uppercase tracking-widest text-zinc-400 mb-3">Target Type</h3>
        <select
          value={config.targetType}
          onChange={(e) => {
            const value = e.target.value as typeof config.targetType;
            dispatch({
              type: "SET_TARGET_TRAINER",
              payload: {
                targetType: value,
                targetNumber: value === "outer_bull" || value === "inner_bull" ? 25 : config.targetNumber,
              },
            });
          }}
          className="w-full rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none"
        >
          {targetTypes.map((type) => (
            <option key={type.value} value={type.value}>{type.label}</option>
          ))}
        </select>
        <p className="text-xs text-zinc-400 mt-2">
          {targetTypes.find((type) => type.value === config.targetType)?.hint}
        </p>
      </section>

      <section className="mb-6 pb-6 border-b border-white/10">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm uppercase tracking-widest text-zinc-400">Target Number</h3>
          {isBullType && <span className="text-xs text-emerald-400">Bull only for this ring</span>}
        </div>
        <select
          value={config.targetNumber}
          onChange={(e) => dispatch({ type: "SET_TARGET_TRAINER", payload: { targetNumber: Number(e.target.value) } })}
          className="w-full rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none"
        >
          {activeNumbers.map((num) => (
            <option key={num} value={num}>{num === 25 ? "Bull (25)" : num}</option>
          ))}
        </select>
      </section>

      <section className="mb-6 pb-6 border-b border-white/10">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm uppercase tracking-widest text-zinc-400">Required Hits</h3>
          <span className="text-xs text-zinc-400">How many times to land the target</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
          <select
            value={[5, 10, 15, 20].includes(config.requiredHits) ? config.requiredHits : "custom"}
            onChange={(e) => {
              if (e.target.value === "custom") return;
              dispatch({ type: "SET_TARGET_TRAINER", payload: { requiredHits: Number(e.target.value) } });
            }}
            className="w-full rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none"
          >
            {[5, 10, 15, 20].map((hits) => (
              <option key={hits} value={hits}>{hits} hits</option>
            ))}
            <option value="custom">Custom</option>
          </select>
          <input
            type="number"
            min={1}
            max={99}
            value={config.requiredHits}
            onChange={(event) =>
              dispatch({
                type: "SET_TARGET_TRAINER",
                payload: { requiredHits: Math.max(1, Math.min(99, Number(event.target.value) || 1)) },
              })
            }
            className="w-full sm:w-24 rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none"
          />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-3 py-2.5">
          <div>
            <div className="text-sm text-white font-semibold">Shared target for all players</div>
            <div className="text-xs text-zinc-400">When off, each player can use their own target/number settings (future enhancement).</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={config.sharedTarget}
            onClick={() => dispatch({ type: "SET_TARGET_TRAINER", payload: { sharedTarget: !config.sharedTarget } })}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${config.sharedTarget ? "bg-red-600" : "bg-zinc-700"}`}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${config.sharedTarget ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>

        <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-3 py-2.5">
          <div>
            <div className="text-sm text-white font-semibold">Close-enough mode (0.5 credit)</div>
            <div className="text-xs text-zinc-400">Same number different ring counts as partial credit. Bulls mirror X01 handling.</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={config.allowClose}
            onClick={() => dispatch({ type: "SET_TARGET_TRAINER", payload: { allowClose: !config.allowClose } })}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${config.allowClose ? "bg-red-600" : "bg-zinc-700"}`}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${config.allowClose ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>
      </section>
    </div>
  );
};

export default TargetTrainerOptions;
