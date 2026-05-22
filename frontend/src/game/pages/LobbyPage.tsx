import React, { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useLobby, GameType } from "../context/LobbyContext";
import MatchFormatForm from "../components/lobby/MatchFormatForm";
import X01Options from "../components/lobby/X01Options";
import CricketOptions from "../components/lobby/CricketOptions";
import TargetTrainerOptions from "../components/lobby/TargetTrainerOptions";
import AroundTheClockOptions from "../components/lobby/AroundTheClockOptions";
import BeerRaceOptions from "../components/lobby/BeerRaceOptions";
import ShanghaiOptions from "../components/lobby/ShanghaiOptions";
import Bob27Options from "../components/lobby/Bob27Options";
import BermudaOptions from "../components/lobby/BermudaOptions";
import OneTwoOneOptions from "../components/lobby/OneTwoOneOptions";
import PacmanOptions from "../components/lobby/PacmanOptions";
import PlayersManager from "../components/lobby/PlayersManager";
import LobbySummary from "../components/lobby/LobbySummary";

const GAME_DISPLAY_NAMES: Record<GameType, string> = {
  x01: "X01",
  target_trainer: "Target Trainer",
  cricket: "Cricket",
  around_the_clock: "Around the Clock",
  beer_race: "Beer Race",
  shanghai: "Shanghai",
  bermuda: "Bermuda Triangle",
  bob27: "Bob's 27",
  one_two_one: "One Two One",
  pacman: "PacDarts",
  playgrounds: "Playgrounds",
};

export default function LobbyPage() {
  const { state, dispatch } = useLobby();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    // Respect URL param on entry, but don't keep overriding manual selections
    const gameParam = searchParams.get("game") as GameType | null;
    if (gameParam && gameParam !== state.selectedGame) {
      dispatch({ type: "SET_GAME", game: gameParam });
    }
  }, [dispatch, searchParams]);

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

      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between gap-4">
        <div className="flex-1 text-center md:text-left">
          <h1 className="text-2xl font-extrabold tracking-wide">
            Match <span className="text-red-500">Lobby</span>
          </h1>
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Configure · Invite · Launch</p>
        </div>
        <button
          type="button"
          onClick={() => navigate("/game")}
          className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors"
        >
          Back
        </button>
      </header>

      <main className="relative z-10 flex-1 px-6 md:px-10 pb-8">
        {state.selectedGame === "x01" ? (
          <div className="h-full w-full max-w-7xl mx-auto flex flex-col gap-6">
            <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-4 md:p-5 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Selected game</p>
                <h2 className="text-xl font-semibold text-white">X01 Setup</h2>
              </div>
              <button
                type="button"
                onClick={() => navigate("/game")}
                className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors text-sm"
              >
                Change Game
              </button>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[1.05fr_0.95fr] gap-6 xl:gap-8">
              <div className="flex flex-col gap-6">
                <div>
                  <p className="text-xs uppercase tracking-[0.25em] text-zinc-500 mb-2">1 · Players</p>
                  <PlayersManager />
                </div>
              </div>

              <div className="flex flex-col gap-6">
                <div>
                  <p className="text-xs uppercase tracking-[0.25em] text-zinc-500 mb-2">2 · Core Rules</p>
                  <MatchFormatForm />
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.25em] text-zinc-500 mb-2">3 · Game Modes</p>
                  <X01Options />
                </div>
                <LobbySummary />
              </div>
            </div>
          </div>
        ) : (
          <div className="h-full w-full max-w-7xl mx-auto flex flex-col gap-6">
            <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-4 md:p-5 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Selected game</p>
                <h2 className="text-xl font-semibold text-white">{GAME_DISPLAY_NAMES[state.selectedGame]} Setup</h2>
              </div>
              <button
                type="button"
                onClick={() => navigate("/game")}
                className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors text-sm"
              >
                Change Game
              </button>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-6 xl:gap-8">
              <div className="flex flex-col gap-6 overflow-hidden">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <MatchFormatForm />
                  <PlayersManager />
                </div>
              </div>
              <div className="flex flex-col gap-6">
                {state.selectedGame === "target_trainer" && <TargetTrainerOptions />}
                {state.selectedGame === "cricket" && <CricketOptions />}
                {state.selectedGame === "around_the_clock" && <AroundTheClockOptions />}
                {state.selectedGame === "beer_race" && <BeerRaceOptions />}
                {state.selectedGame === "shanghai" && <ShanghaiOptions />}
                {state.selectedGame === "bob27" && <Bob27Options />}
                {state.selectedGame === "bermuda" && <BermudaOptions />}
                {state.selectedGame === "one_two_one" && <OneTwoOneOptions />}
                {state.selectedGame === "pacman" && <PacmanOptions />}
                <LobbySummary />
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
