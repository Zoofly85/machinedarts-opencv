import React from "react";
import { useLobby, CricketVariant } from "../../context/LobbyContext";

const variants: Array<{ value: CricketVariant; label: string; description: string }> = [
  { value: "standard", label: "Standard", description: "Close 15-20 & Bull, high score wins" },
  { value: "cutthroat", label: "Cutthroat", description: "Opponents take the points" },
  { value: "no_score", label: "No Score", description: "Just close the numbers" },
  { value: "triples_only", label: "Triples Only", description: "Only triple hits count toward marks" },
  { value: "doubles_only", label: "Doubles Only", description: "Only double hits count toward marks" },
];

const CricketOptions = React.memo(() => {
  const { state, dispatch } = useLobby();
  const { cricket } = state;

  const handleSelect = (variant: CricketVariant) => {
    dispatch({ type: "SET_CRICKET", payload: { variant } });
  };

  const selected = variants.find((v) => v.value === cricket.variant) || variants[0];

  return (
    <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 h-full">
      <h2 className="text-lg font-semibold mb-4 tracking-wide text-white">Cricket Options</h2>

      <label className="block mb-4">
        <span className="text-sm uppercase tracking-widest text-zinc-400">Variant</span>
        <select
          value={cricket.variant}
          onChange={(e) => handleSelect(e.target.value as CricketVariant)}
          className="mt-2 w-full rounded-lg border border-red-600/60 bg-red-700/70 px-3 py-2 text-white focus:border-red-400 focus:outline-none"
        >
          {variants.map((variant) => (
            <option key={variant.value} value={variant.value}>{variant.label}</option>
          ))}
        </select>
      </label>

      <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3">
        <p className="text-sm text-white font-semibold">{selected.label}</p>
        <p className="text-xs text-zinc-400 mt-1">{selected.description}</p>
      </div>
    </div>
  );
});

CricketOptions.displayName = 'CricketOptions';

export default CricketOptions;
