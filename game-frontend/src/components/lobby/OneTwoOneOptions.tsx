import React, { useMemo } from "react";
import { useLobby } from "../../context/LobbyContext";

const failurePolicies = [
  { value: "stay", label: "Stay (casual)" },
  { value: "drop", label: "Drop -1" },
  { value: "reset", label: "Reset to 121" },
];

const OneTwoOneOptions = React.memo(() => {
  const { state, dispatch } = useLobby();
  const opts =
    state.oneTwoOne || {
      startingTarget: 121,
      targetLimit: 130,
      failurePolicy: "stay",
      outRule: "double" as const,
    };

  const targetLimitLabel = useMemo(() => {
    if (opts.targetLimit === null) return "No limit";
    return opts.targetLimit;
  }, [opts.targetLimit]);

  return (
    <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-wide text-white">One Two One</h2>
        <div className="text-xs text-zinc-400 uppercase tracking-[0.25em]">3 visits · 9 darts</div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="flex flex-col gap-2 text-sm text-zinc-300">
          Starting Target
          <select
            className="rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none"
            value={opts.startingTarget}
            onChange={(e) =>
              dispatch({
                type: "SET_ONE_TWO_ONE",
                payload: { startingTarget: Math.max(1, parseInt(e.target.value || "121", 10)) },
              })
            }
          >
            {[101, 121, 131, 141, 151, 170].map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-2 text-sm text-zinc-300">
          Target Limit (win on pass)
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
            <select
              className="rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none"
              value={
                opts.targetLimit === null
                  ? "none"
                  : [130, 140, 150, 160, 170, 180, 200].includes(opts.targetLimit)
                  ? String(opts.targetLimit)
                  : "custom"
              }
              onChange={(e) => {
                const val = e.target.value;
                if (val === "custom") return;
                dispatch({
                  type: "SET_ONE_TWO_ONE",
                  payload: { targetLimit: val === "none" ? null : Math.max(opts.startingTarget, parseInt(val, 10)) },
                });
              }}
            >
              <option value="none">No Limit</option>
              {[130, 140, 150, 160, 170, 180, 200].map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
              <option value="custom">Custom</option>
            </select>
            <input
              type="number"
              className="w-full sm:w-24 rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none"
              value={opts.targetLimit ?? ""}
              min={opts.startingTarget}
              placeholder=""
              onChange={(e) => {
                const val = e.target.value;
                dispatch({
                  type: "SET_ONE_TWO_ONE",
                  payload: { targetLimit: val === "" ? null : Math.max(opts.startingTarget, parseInt(val, 10)) },
                });
              }}
            />
          </div>
          <span className="text-xs text-zinc-500">Current: {targetLimitLabel}</span>
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="flex flex-col gap-2 text-sm text-zinc-300">
          Failure Policy (after 9 darts)
          <select
            value={opts.failurePolicy}
            onChange={(e) => dispatch({ type: "SET_ONE_TWO_ONE", payload: { failurePolicy: e.target.value as typeof opts.failurePolicy } })}
            className="rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none"
          >
            {failurePolicies.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-2 text-sm text-zinc-300">
          Out Rule
          <select
            value={opts.outRule}
            onChange={(e) => dispatch({ type: "SET_ONE_TWO_ONE", payload: { outRule: e.target.value as "double" | "any" } })}
            className="rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none"
          >
            <option value="double">Double/Inner Bull</option>
            <option value="any">Any Out</option>
          </select>
        </label>
      </div>
    </div>
  );
});

OneTwoOneOptions.displayName = "OneTwoOneOptions";

export default OneTwoOneOptions;
