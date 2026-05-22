import React from "react";

export type GamePlayerCardVariant = "default" | "active" | "winner";

export type GamePlayerCardStat = {
  label: string;
  value: React.ReactNode;
  align?: "left" | "right";
  valueClassName?: string;
};

export type GamePlayerCardProps = {
  variant: GamePlayerCardVariant;
  statusLabel: string;
  headerRight?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  main: React.ReactNode;
  mainRight?: React.ReactNode;
  stats?: GamePlayerCardStat[];
};

const variantClassName: Record<GamePlayerCardVariant, string> = {
  winner: "border-emerald-500 bg-emerald-600/15",
  active: "border-red-500 bg-red-600/10",
  default: "border-white/10 bg-black/40",
};

const GamePlayerCard = React.memo(
  ({
    variant,
    statusLabel,
    headerRight,
    title,
    subtitle,
    main,
    mainRight,
    stats = [],
  }: GamePlayerCardProps) => {
    return (
      <div
        className={`rounded-2xl border px-6 py-5 transition shadow-[0_12px_50px_rgba(0,0,0,0.35)] ${variantClassName[variant]}`}
      >
        <div className="flex items-center justify-between">
          <div className="text-sm uppercase tracking-[0.3em] text-zinc-400">{statusLabel}</div>
          {headerRight ? <div className="text-sm text-zinc-500">{headerRight}</div> : null}
        </div>

        <div className="mt-1 text-2xl font-semibold text-white">{title}</div>

        {subtitle ? <div className="mt-2 text-xs text-zinc-500">{subtitle}</div> : null}

        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="min-w-0">{main}</div>
          {mainRight ? <div className="shrink-0">{mainRight}</div> : null}
        </div>

        {stats.length ? (
          <div className="mt-4 grid grid-cols-2 gap-4 text-sm text-zinc-400">
            {stats.map((stat) => (
              <div key={stat.label} className={`flex flex-col ${stat.align === "right" ? "text-right" : ""}`}>
                <span>{stat.label}</span>
                <span className={stat.valueClassName ?? "text-xl text-white font-semibold tabular-nums"}>
                  {stat.value}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  },
);

GamePlayerCard.displayName = "GamePlayerCard";

export default GamePlayerCard;

