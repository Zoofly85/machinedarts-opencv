import React from "react";

function Logo() {
  return (
    <div className="flex items-center gap-3 select-none">
      <div className="leading-tight">
        <span className="block text-white text-2xl font-bold tracking-wide">
          MACHINE <span className="text-red-500">DARTS</span>
        </span>
        <span className="block text-sm text-zinc-400 tracking-[0.2em]">
          AUTO SCORING
        </span>
      </div>
    </div>
  );
}

export default Logo;