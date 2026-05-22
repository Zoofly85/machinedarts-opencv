import React from "react";
import { useLobby, GameType } from "../../context/LobbyContext";
import { PlayCircle, Target, Clock, Trophy, Beer, Code } from "lucide-react";

const gameOptions: Array<{
  id: GameType;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    id: "x01",
    label: "X01",
    description: "301  ?  501  ?  701  ?  901",
    icon: <PlayCircle className="h-5 w-5" />,
  },
  {
    id: "target_trainer",
    label: "Target Trainer",
    description: "Pick a target and hit it X times",
    icon: <Target className="h-5 w-5" />,
  },
  {
    id: "cricket",
    label: "Cricket",
    description: "Standard  ?  Cutthroat  ?  No Score",
    icon: <Target className="h-5 w-5" />,
  },
  {
    id: "around_the_clock",
    label: "Around the Clock",
    description: "Hit 1 through 20 in order",
    icon: <Clock className="h-5 w-5" />,
  },
  {
    id: "beer_race",
    label: "Beer Race",
    description: "Race to target score  ?  Power scoring",
    icon: <Beer className="h-5 w-5" />,
  },
  {
    id: "shanghai",
    label: "Shanghai",
    description: "Number  ?  Double  ?  Triple each round",
    icon: <Trophy className="h-5 w-5" />,
  },
  {
    id: "bob27",
    label: "Bob's 27",
    description: "Doubles ladder training with penalties",
    icon: <Target className="h-5 w-5" />,
  },
  {
    id: "bermuda",
    label: "Bermuda Triangle",
    description: "13 rounds, punish zero rounds by halving score",
    icon: <Target className="h-5 w-5" />,
  },
  {
    id: "one_two_one",
    label: "One Two One",
    description: "Checkout 121+ in 9 darts, advance each clear",
    icon: <Target className="h-5 w-5" />,
  },
  {
    id: "pacman",
    label: "PacDarts",
    description: "Eat pellets on S/D/T/Bull, lose life on empty hit",
    icon: <Target className="h-5 w-5" />,
  },
  {
    id: "playgrounds",
    label: "Playgrounds",
    description: "Custom games built from scripts",
    icon: <Code className="h-5 w-5" />,
  },
];

const GameSelector = React.memo(() => {
  const { state, dispatch } = useLobby();

  return (
    <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6">
      <h2 className="text-lg font-semibold mb-4 tracking-wide text-white">Game</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {gameOptions.map((option) => {
          const isActive = state.selectedGame === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => dispatch({ type: "SET_GAME", game: option.id })}
              className={`group flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition ${
                isActive
                  ? "border-red-600 bg-red-600/20 shadow-lg shadow-red-900/40"
                  : "border-white/10 hover:border-red-600/60 hover:bg-red-600/10"
              }`}
            >
              <span
                className={`mt-1 flex h-9 w-9 items-center justify-center rounded-full transition ${
                  isActive ? "bg-red-600 text-white" : "bg-zinc-800 text-zinc-300 group-hover:text-white"
                }`}
                aria-hidden
              >
                {option.icon}
              </span>
              <span>
                <span className="block text-base font-semibold text-white">{option.label}</span>
                <span className="block text-sm text-zinc-400">{option.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
});

GameSelector.displayName = "GameSelector";

export default GameSelector;
