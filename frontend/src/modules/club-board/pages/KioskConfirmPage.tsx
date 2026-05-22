import React from "react";
import { useNavigate } from "react-router-dom";

import { useLobby, type GameType, type PlayerConfig } from "../../../game/context/LobbyContext";
import { getKioskState, formatPlayerDisplayName } from "../kioskState";
import { startClubKioskSession } from "../kioskSession";
import { getPlayersCached, invalidatePlayersCache, type PlayerProfile } from "../../../game/services/playersApi";
import { API_BASE_URL } from "../../../services/api";

const API_URL = API_BASE_URL;

function gameRoute(game: GameType): string {
  switch (game) {
    case "x01":
      return "/x01";
    case "cricket":
      return "/cricket";
    case "around_the_clock":
      return "/around-the-clock";
    case "target_trainer":
      return "/target-trainer";
    case "shanghai":
      return "/shanghai";
    case "beer_race":
      return "/beer-race";
    case "bob27":
      return "/bob27";
    case "bermuda":
      return "/bermuda";
    case "one_two_one":
      return "/one-two-one";
    case "pacman":
      return "/pacman";
    default:
      return "/x01";
  }
}

async function getProfiles(): Promise<PlayerProfile[]> {
  return getPlayersCached();
}

async function createProfile(name: string): Promise<PlayerProfile | null> {
  const res = await fetch(`${API_URL}/api/players`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  invalidatePlayersCache();
  return data?.player ?? null;
}

export default function KioskConfirmPage() {
  const { dispatch, state: lobbyState } = useLobby();
  const navigate = useNavigate();
  const kiosk = React.useMemo(() => getKioskState(), []);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>("");

  const handleGoToGameSetup = async () => {
    setBusy(true);
    setError("");
    try {
      const existingProfiles = await getProfiles();
      const byName = new Map(existingProfiles.map((p) => [String(p.name || "").trim().toLowerCase(), p]));
      const players: PlayerConfig[] = [];

      for (let i = 0; i < kiosk.players.length; i += 1) {
        const draft = kiosk.players[i];
        const displayName = formatPlayerDisplayName(draft, i);
        let profileId: string | undefined;

        if (draft.saveProfile) {
          const key = displayName.trim().toLowerCase();
          let profile = byName.get(key);
          if (!profile) {
            profile = await createProfile(displayName) ?? undefined;
            if (profile) byName.set(key, profile);
          }
          profileId = profile?.id;
        }

        players.push({
          name: displayName,
          isBot: false,
          profileId,
        });
      }

      dispatch({ type: "SET_PLAYERS", players });
      dispatch({ type: "SET_GAME", game: kiosk.game });
      startClubKioskSession(
        kiosk.game,
        players.map((p) => p.name),
      );

      navigate(`/lobby?game=${encodeURIComponent(kiosk.game)}`, {
        state: { ...lobbyState, players, selectedGame: kiosk.game },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start match.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      <div
        className="pointer-events-none fixed inset-0 [background:
          radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
          radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
          radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
          radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
          linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
        ]"
      />
      <div className="relative z-10 p-8 md:p-10">
        <div className="max-w-4xl mx-auto border border-white/10 rounded-2xl bg-zinc-900/60 p-6 md:p-8">
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500 mb-3">Kiosk Setup</p>
          <h1 className="text-3xl md:text-5xl font-extrabold text-white">Confirm match</h1>
          <p className="text-zinc-300 mt-3 mb-1">
            Next step opens full game setup (legs, sets, handicap, and game options).
          </p>

          <div className="mt-6 space-y-3 text-zinc-200">
            <div className="rounded-xl border border-white/10 bg-black/40 p-4">
              <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-1">Game</div>
              <div className="text-xl font-bold">{String(kiosk.game).replace(/_/g, " ")}</div>
            </div>

            <div className="rounded-xl border border-white/10 bg-black/40 p-4">
              <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Players ({kiosk.players.length})</div>
              <ul className="space-y-1">
                {kiosk.players.map((p, i) => (
                  <li key={`confirm-player-${i}`} className="flex items-center justify-between">
                    <span>{formatPlayerDisplayName(p, i)}</span>
                    {p.saveProfile && <span className="text-xs text-cyan-300">save profile</span>}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {error && <p className="mt-4 text-sm text-red-300">{error}</p>}

          <div className="flex flex-wrap gap-3 mt-7">
            <a href="#/kiosk/games" className="rounded-lg border border-zinc-700 px-5 py-2 text-zinc-200 hover:bg-zinc-800/70">
              Back
            </a>
            <button
              type="button"
              onClick={() => void handleGoToGameSetup()}
              disabled={busy}
              className="rounded-lg border border-red-600/70 bg-red-600/90 px-5 py-2 text-white hover:bg-red-500 disabled:opacity-50"
            >
              {busy ? "Opening..." : "Game Setup"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
