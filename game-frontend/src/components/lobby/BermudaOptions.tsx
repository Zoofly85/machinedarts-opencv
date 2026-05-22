import React from "react";

const BermudaOptions = React.memo(() => {
  return (
    <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 h-full">
      <h2 className="text-lg font-semibold mb-3 tracking-wide text-white">Bermuda Triangle</h2>
      <p className="text-sm text-zinc-400">
        13 rounds: 12,13,14, Double(any),15,16,17, Triple(any),18,19,20, Bull, 50. Three darts each. If a round scores 0, total score is halved. Highest total wins.
      </p>
    </div>
  );
});

BermudaOptions.displayName = "BermudaOptions";

export default BermudaOptions;
