import React from "react";
import GameRecalibrateButton from "./GameRecalibrateButton";

type GameHeaderProps = {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  meta?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
};

export default function GameHeader({ title, subtitle, meta, right, className = "" }: GameHeaderProps) {
  return (
    <header
      className={`relative z-10 w-full px-6 md:px-10 py-6 flex flex-wrap items-center gap-4 justify-between border-b border-white/10 ${className}`}
    >
      <div className="min-w-0">
        <h1 className="text-xl sm:text-2xl font-extrabold tracking-wide text-white truncate">{title}</h1>
        {subtitle ? (
          <div className="mt-1 text-xs uppercase tracking-[0.3em] text-zinc-500">{subtitle}</div>
        ) : null}
        {meta ? <div className="mt-1 text-xs uppercase tracking-[0.3em] text-emerald-400">{meta}</div> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <GameRecalibrateButton />
        {right}
      </div>
    </header>
  );
}

