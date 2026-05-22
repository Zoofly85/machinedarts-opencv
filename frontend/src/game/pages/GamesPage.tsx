import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { PlayCircle, Target, Grid, Beer, Code, BookOpen, Trophy } from "lucide-react";

function PacDartsIcon() {
  return (
    <svg viewBox="0 0 48 48" className="h-12 w-12" aria-hidden="true">
      <defs>
        <radialGradient id="pacdartsCardBody" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#ff4d4d" />
          <stop offset="45%" stopColor="#d00000" />
          <stop offset="100%" stopColor="#0a0a0a" />
        </radialGradient>
      </defs>
      <circle cx="24" cy="24" r="21" fill="url(#pacdartsCardBody)" stroke="#ff2a2a" strokeWidth="1.6" />
      <path d="M24 24 L42 13 A21 21 0 0 1 42 35 Z" fill="#050505" />
      <circle cx="17" cy="18" r="4.1" fill="#0a0a0a" stroke="#ff3333" strokeWidth="1" />
      <circle cx="17" cy="18" r="1.3" fill="#ff3b3b" />
    </svg>
  );
}

type GameCard = {
  name: string;
  description: string;
  icon: React.ReactNode;
  game?: string;
  path?: string;
  customIconBadge?: boolean;
};

const games: GameCard[] = [
  { name: "X01", description: "301 / 501 / 701 / 901", game: "x01", icon: <PlayCircle className="h-6 w-6" /> },
  { name: "Target Trainer", description: "Pick a target, hit it X times", game: "target_trainer", icon: <Target className="h-6 w-6" /> },
  { name: "Cricket", description: "Standard & Cutthroat", game: "cricket", icon: <Target className="h-6 w-6" /> },
  { name: "Around the Clock", description: "Hit 1 through 20 in order", game: "around_the_clock", icon: <Grid className="h-6 w-6" /> },
  { name: "Beer Race", description: "Race to target score | Power scoring", game: "beer_race", icon: <Beer className="h-6 w-6" /> },
  { name: "Shanghai", description: "Hit number, double, triple each round", game: "shanghai", icon: <Grid className="h-6 w-6" /> },
  { name: "Bermuda Triangle", description: "13 rounds; zero round halves score", game: "bermuda", icon: <Grid className="h-6 w-6" /> },
  { name: "Bob's 27", description: "Doubles ladder training with penalties", game: "bob27", icon: <Grid className="h-6 w-6" /> },
  { name: "One Two One", description: "Checkout 121+ in 9 darts, climb ladder", game: "one_two_one", icon: <Grid className="h-6 w-6" /> },
  { name: "PacDarts", description: "Eat pellets by hitting S/D/T/Bull targets", game: "pacman", icon: <PacDartsIcon />, customIconBadge: true },
  { name: "Playgrounds", description: "Custom games built from scripts", game: "playgrounds", icon: <Code className="h-6 w-6" /> },
  {
    name: "Custom Frontend Games",
    description: "AI brief and socket/API contract for user-built games",
    path: "/custom-games",
    icon: <Code className="h-6 w-6" />,
  },
  {
    name: "Training Programs",
    description: "Build and run custom doubles/scoring training blocks",
    path: "/training",
    icon: <BookOpen className="h-6 w-6" />,
  },
  {
    name: "Tournaments",
    description: "Local knockout brackets for players and bots",
    path: "/tournaments",
    icon: <Trophy className="h-6 w-6" />,
  },
];

export default function GamesPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden flex flex-col">
      <div
        className="pointer-events-none fixed inset-0 [background:
          radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
          radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
          radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
          radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
          linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
        ]"
      />

      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between">
        <h1 className="text-xl sm:text-2xl font-extrabold tracking-wide">
          Select <span className="text-red-500">Game</span>
        </h1>
        <button
          onClick={() => navigate("/")}
          className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors"
        >
          Home
        </button>
      </header>

      <main className="relative z-10 w-full px-6 md:px-10 pb-10 flex-1 flex">
        <div className="flex-1 max-w-6xl mx-auto flex items-center justify-center">
          <div className="w-full grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {games.map((game) => (
              <Link
                key={game.name}
                to={game.path ?? `/lobby?game=${game.game}`}
                className="group flex flex-col rounded-2xl border border-white/10 bg-zinc-900/60 hover:bg-zinc-900/80 transition p-6 shadow-lg relative overflow-hidden"
              >
                <div
                  className="absolute -inset-8 rounded-3xl bg-[radial-gradient(80%_80%_at_50%_0%,rgba(220,38,38,0.35),transparent_60%)] opacity-0 group-hover:opacity-100 transition"
                  aria-hidden
                />
                <div className="flex items-center gap-4 mb-4 relative z-10">
                  <div className={game.customIconBadge ? "h-12 w-12 flex items-center justify-center" : "p-3 rounded-full bg-red-600/80 text-white"}>
                    {game.icon}
                  </div>
                  <h2 className="text-xl font-bold group-hover:text-red-400 transition">{game.name}</h2>
                </div>
                <p className="text-zinc-400 relative z-10 text-sm sm:text-base">{game.description}</p>
              </Link>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
