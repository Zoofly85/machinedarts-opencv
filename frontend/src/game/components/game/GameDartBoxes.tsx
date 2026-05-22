import React from "react";

export type GameDartBox = {
  key: string;
  title: string;
  main: React.ReactNode;
  sub?: React.ReactNode;
  filled?: boolean;
  onClick?: () => void;
  danger?: boolean;
};

export default function GameDartBoxes({ boxes }: { boxes: GameDartBox[] }) {
  return (
    <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-4">
      {boxes.map((box) => (
        <button
          key={box.key}
          type="button"
          onClick={box.onClick}
          className={`rounded-xl border px-6 py-6 text-left transition ${
            box.danger
              ? "border-red-500 bg-red-600/20 animate-pulse"
              : box.filled
              ? "border-red-500/50 bg-red-600/10"
              : "border-white/10 bg-zinc-900/40 hover:border-red-600/50"
          }`}
        >
          <div className="text-xs uppercase tracking-[0.25em] text-zinc-400 mb-2">{box.title}</div>
          <div className="text-3xl font-semibold text-white">{box.main}</div>
          {box.sub ? <div className="text-sm text-zinc-400 mt-2">{box.sub}</div> : null}
        </button>
      ))}
    </div>
  );
}
