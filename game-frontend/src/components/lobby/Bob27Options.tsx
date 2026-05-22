import React from "react";
import { useLobby } from "../../context/LobbyContext";

const Bob27Options = React.memo(() => {
  const { state, dispatch } = useLobby();
  const { bob27 } = state;

  return (
    <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 h-full">
      <h2 className="text-lg font-semibold mb-4 tracking-wide text-white">Bob&apos;s 27 Options</h2>

      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-3 py-2.5">
          <span className="text-sm font-medium text-zinc-300">Include Double Bull as final target</span>
          <button
            type="button"
            role="switch"
            aria-checked={bob27.includeBull}
            onClick={() => dispatch({ type: "SET_BOB27", payload: { includeBull: !bob27.includeBull } })}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${bob27.includeBull ? "bg-red-600" : "bg-zinc-700"}`}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${bob27.includeBull ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>

        <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-3 py-2.5">
          <span className="text-sm font-medium text-zinc-300">Allow negative scores (training mode)</span>
          <button
            type="button"
            role="switch"
            aria-checked={bob27.allowNegative}
            onClick={() => dispatch({ type: "SET_BOB27", payload: { allowNegative: !bob27.allowNegative } })}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${bob27.allowNegative ? "bg-red-600" : "bg-zinc-700"}`}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${bob27.allowNegative ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>

        <p className="text-xs text-zinc-500">
          Rules: Start at 27. Three darts per double. Each hit scores double value; miss all three subtracts that double. Game ends when targets finish or (if negatives off) score drops below zero.
        </p>
      </div>
    </div>
  );
});

Bob27Options.displayName = "Bob27Options";

export default Bob27Options;
