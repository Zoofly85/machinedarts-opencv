import React from "react";
import { useNavigate } from "react-router-dom";
import { useLobby } from "../../context/LobbyContext";

const LobbySummary = React.memo(() => {
  const { state } = useLobby();
  const navigate = useNavigate();

  const handleStart = () => {
    if (state.match.bullOff) {
      navigate("/bull-off", { state });
      return;
    }
    switch (state.selectedGame) {
      case "x01":
        navigate("/x01", { state });
        break;
      case "target_trainer":
        navigate("/target-trainer", { state });
        break;
      case "cricket":
        navigate("/cricket", { state });
        break;
      case "around_the_clock":
        navigate("/around-the-clock", { state });
        break;
      case "beer_race":
        navigate("/beer-race", { state });
        break;
      case "shanghai":
        navigate("/shanghai", { state });
        break;
      case "bob27":
        navigate("/bob27", { state });
        break;
      case "bermuda":
        navigate("/bermuda", { state });
        break;
      case "one_two_one":
        navigate("/one-two-one", { state });
        break;
      case "playgrounds":
        navigate("/playgrounds", { state });
        break;
      default:
        break;
    }
  };

  return (
    <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 flex flex-col gap-4">
      <h2 className="text-lg font-semibold tracking-wide text-white">Summary</h2>
      <div className="space-y-2 text-sm text-zinc-300">
        <p><span className="text-zinc-500">Game:</span> {state.selectedGame.toUpperCase()}</p>
        <p>
          <span className="text-zinc-500">Match:</span> Best of {state.match.sets} sets Aú {state.match.legs} legs
        </p>
        <p>
          <span className="text-zinc-500">Players:</span>{" "}
          {state.players
            .map((player) =>
              player.isBot
                ? `${player.name || "Bot"} (Bot${player.botLevel ? ` L${player.botLevel}` : ""})`
                : player.name || "Player"
            )
            .join(", ")}
        </p>
        {state.match.bullOff && (
          <p>
            <span className="text-zinc-500">Bull-off:</span> Enabled
          </p>
        )}
        {state.selectedGame === "x01" && (
          <p>
            <span className="text-zinc-500">X01:</span> {state.x01.startScore} Aú In: {state.x01.inMode} Aú Out: {state.x01.outMode}
          </p>
        )}
        {state.selectedGame === "target_trainer" && (
          <p>
            <span className="text-zinc-500">Target Trainer:</span>{" "}
            {state.targetTrainer.targetType.toUpperCase()}{" "}
            {state.targetTrainer.targetType.includes("bull") ? "BULL" : state.targetTrainer.targetNumber} Aú{" "}
            {state.targetTrainer.requiredHits} hits
          </p>
        )}
        {state.selectedGame === "cricket" && (
          <p>
            <span className="text-zinc-500">Cricket:</span> {state.cricket.variant}
          </p>
        )}
        {state.selectedGame === "beer_race" && (
          <p>
            <span className="text-zinc-500">Beer Race:</span> Target {state.beerRace.targetScore}
          </p>
        )}
        {state.selectedGame === "shanghai" && (
          <p>
            <span className="text-zinc-500">Shanghai:</span> {state.shanghai.roundRange}  ?  Mode:{" "}
            {state.shanghai.mode === "free_play" ? "Free Play" : "Legs & Sets"}
          </p>
        )}
        {state.selectedGame === "bob27" && (
          <p>
            <span className="text-zinc-500">Bob&apos;s 27:</span> {state.bob27.includeBull ? "D1-D20 + DB" : "D1-D20"}  ?{" "}
            {state.bob27.allowNegative ? "Negatives allowed" : "Ends if score < 0"}
          </p>
        )}
        {state.selectedGame === "bermuda" && (
          <p>
            <span className="text-zinc-500">Bermuda Triangle:</span> 13-round ladder, zero-round halves your score
          </p>
        )}
        {state.selectedGame === "one_two_one" && (
          <p>
            <span className="text-zinc-500">One Two One:</span> Start {state.oneTwoOne?.startingTarget ?? 121} ➜ Target limit{" "}
            {state.oneTwoOne?.targetLimit ?? "None"} | Failure: {state.oneTwoOne?.failurePolicy ?? "stay"} | Out: {state.oneTwoOne?.outRule ?? "double"}
          </p>
        )}
        {state.selectedGame === "playgrounds" && (
          <p>
            <span className="text-zinc-500">Playgrounds:</span> Select or create a custom script
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={handleStart}
        className="mt-auto rounded-xl bg-red-600 px-5 py-3 text-base font-semibold text-white transition hover:bg-red-500"
      >
        Start Match
      </button>
    </div>
  );
});

LobbySummary.displayName = "LobbySummary";

export default LobbySummary;
