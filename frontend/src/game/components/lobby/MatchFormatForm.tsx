import React from "react";
import { Minus, Plus } from "lucide-react";
import { useLobby } from "../../context/LobbyContext";

type MatchValueStepperProps = {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
};

function MatchValueStepper({ label, value, disabled = false, onChange }: MatchValueStepperProps) {
  const normalized = Math.max(1, Math.min(9, Number(value) || 1));
  const setValue = (next: number) => onChange(Math.max(1, Math.min(9, next)));

  return (
    <div className={`block ${disabled ? "opacity-50" : ""}`}>
      <span className="text-sm text-zinc-400">{label}</span>
      <div className="mt-1 grid grid-cols-[44px_1fr_44px] items-center overflow-hidden rounded-lg border border-red-600/60 bg-red-700/70">
        <button
          type="button"
          onClick={() => setValue(normalized - 1)}
          disabled={disabled || normalized <= 1}
          className="flex h-11 items-center justify-center border-r border-red-500/40 text-white transition hover:bg-red-600/60 disabled:cursor-not-allowed disabled:opacity-35"
          aria-label={`Decrease ${label}`}
        >
          <Minus className="h-4 w-4" />
        </button>
        <div className="flex h-11 items-center justify-center text-lg font-semibold tabular-nums text-white">
          {normalized}
        </div>
        <button
          type="button"
          onClick={() => setValue(normalized + 1)}
          disabled={disabled || normalized >= 9}
          className="flex h-11 items-center justify-center border-l border-red-500/40 text-white transition hover:bg-red-600/60 disabled:cursor-not-allowed disabled:opacity-35"
          aria-label={`Increase ${label}`}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

const MatchFormatForm = React.memo(() => {
  const { state, dispatch } = useLobby();
  const { match } = state;
  const hasPlayerBot = state.players.some((player) => Boolean(player.isPlayerBot || player.sourcePlayerId));

  React.useEffect(() => {
    if (hasPlayerBot && match.bullOff) {
      dispatch({ type: "SET_BULL_OFF", bullOff: false });
    }
  }, [dispatch, hasPlayerBot, match.bullOff]);

  const handleSetsChange = (sets: number) => {
    dispatch({ type: "SET_MATCH", sets, legs: match.legs });
  };

  const handleLegsChange = (legs: number) => {
    dispatch({ type: "SET_MATCH", sets: match.sets, legs });
  };

  const handleFreePlayToggle = () => {
    dispatch({ type: "SET_FREE_PLAY", freePlay: !Boolean(match.freePlay) });
  };

  const handleBullOffToggle = () => {
    dispatch({ type: "SET_BULL_OFF", bullOff: !Boolean(match.bullOff) });
  };

  return (
    <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 h-full">
      <h2 className="text-lg font-semibold mb-4 tracking-wide text-white">Match Format</h2>
      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-3 py-2.5">
          <span className="text-sm text-zinc-300">Free play (manual finish)</span>
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(match.freePlay)}
            onClick={handleFreePlayToggle}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${
              match.freePlay ? "bg-red-600" : "bg-zinc-700"
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                match.freePlay ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {hasPlayerBot ? (
          <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 py-2.5">
            <div className="text-sm font-semibold text-cyan-100">Randomly select who starts</div>
            <div className="mt-1 text-xs text-cyan-200/80">
              Bull-off is disabled when a PlayerBot is in the match.
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-3 py-2.5">
            <span className="text-sm text-zinc-300">Bull-off to decide who starts</span>
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(match.bullOff)}
              onClick={handleBullOffToggle}
              className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${
                match.bullOff ? "bg-red-600" : "bg-zinc-700"
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                  match.bullOff ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
        )}
        <MatchValueStepper
          label="Sets (best of)"
          value={match.sets}
          disabled={match.freePlay}
          onChange={handleSetsChange}
        />
        <MatchValueStepper
          label="Legs per set"
          value={match.legs}
          disabled={match.freePlay}
          onChange={handleLegsChange}
        />
      </div>
    </div>
  );
});

MatchFormatForm.displayName = 'MatchFormatForm';

export default MatchFormatForm;
