import React from "react";
import { useNavigate } from "react-router-dom";

import { useLobby, type GameType } from "../../../game/context/LobbyContext";
import { getClubControlConfig } from "../../shared-domain/clubControlConfig";
import { API_BASE_URL } from "../../../services/api";
import { getBoardNextMatch, type BoardNextMatch } from "../services/boardQueue";
import { resetKioskState } from "../kioskState";
import { endClubKioskSession, getClubKioskSession, isClubKioskSessionExpired, startClubKioskSession } from "../kioskSession";

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

export default function KioskHomePage() {
  const navigate = useNavigate();
  const { dispatch } = useLobby();
  const cfg = React.useMemo(() => getClubControlConfig(), []);
  const clubName = React.useMemo(() => getClubControlConfig().clubName, []);
  const activeSession = React.useMemo(() => {
    const session = getClubKioskSession();
    if (!session) return null;
    if (isClubKioskSessionExpired(session)) {
      endClubKioskSession();
      return null;
    }
    return session;
  }, []);
  const [nextMatch, setNextMatch] = React.useState<BoardNextMatch | null>(null);
  const [loadingMatch, setLoadingMatch] = React.useState(true);
  const [matchError, setMatchError] = React.useState("");
  const [readyBusy, setReadyBusy] = React.useState(false);

  React.useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        setMatchError("");
        const match = await getBoardNextMatch(cfg.boardId);
        if (stopped) return;
        setNextMatch(match);
      } catch (err) {
        if (stopped) return;
        setNextMatch(null);
        setMatchError(err instanceof Error ? err.message : "Failed to load board queue.");
      } finally {
        if (!stopped) setLoadingMatch(false);
      }
    };
    void load();
    const id = window.setInterval(() => {
      void load();
    }, 5000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [cfg.boardId]);

  React.useEffect(() => {
    let cancelled = false;

    const maybeUploadTrainingData = async () => {
      try {
        const countResp = await fetch(`${API_BASE_URL}/api/training-data/count`);
        if (!countResp.ok || cancelled) return;
        const countData = await countResp.json();
        const total = Number(countData?.counts?.total ?? 0);
        if (!Number.isFinite(total) || total < 10) return;
        await fetch(`${API_BASE_URL}/api/training-data/upload`, { method: "POST" });
      } catch {
        // Best-effort only on kiosk home page.
      }
    };

    void maybeUploadTrainingData();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleStart = () => {
    if (!activeSession) {
      resetKioskState();
    }
  };

  const handleEndSession = () => {
    endClubKioskSession();
    resetKioskState();
    window.location.hash = "#/kiosk";
  };

  const handleReadyForNextMatch = async () => {
    if (!nextMatch) return;
    setReadyBusy(true);
    try {
      const game = String(nextMatch.game_mode || "x01").toLowerCase() as GameType;
      const players = [
        { name: nextMatch.a.name, isBot: false, profileId: nextMatch.a.id },
        { name: nextMatch.b.name, isBot: false, profileId: nextMatch.b.id },
      ];
      dispatch({ type: "SET_MATCH", sets: 1, legs: 1 });
      dispatch({ type: "SET_FREE_PLAY", freePlay: false });
      dispatch({ type: "SET_BULL_OFF", bullOff: false });
      dispatch({ type: "SET_PLAYERS", players });
      dispatch({ type: "SET_GAME", game });
      if (game === "x01") {
        dispatch({ type: "SET_X01", payload: { gameVariant: "standard", handicapEnabled: true } });
        dispatch({
          type: "SET_PLAYER_X01_SETTINGS",
          playerIndex: 0,
          settings: { startScore: Number(nextMatch.a.start_score || 501), inMode: "straight", outMode: "double" },
        });
        dispatch({
          type: "SET_PLAYER_X01_SETTINGS",
          playerIndex: 1,
          settings: { startScore: Number(nextMatch.b.start_score || 501), inMode: "straight", outMode: "double" },
        });
      }
      startClubKioskSession(
        game,
        players.map((p) => p.name),
        {
          socialNightId: nextMatch.social_night_id,
          matchId: nextMatch.match_id,
          boardId: nextMatch.board_id,
          aName: nextMatch.a.name,
          bName: nextMatch.b.name,
          resultPosted: false,
        },
      );
      navigate(gameRoute(game));
    } finally {
      setReadyBusy(false);
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
        <div className="max-w-6xl mx-auto">
          <div className="text-sm font-bold uppercase tracking-[0.25em] text-cyan-300 mb-6">Machine Darts</div>
          <h1 className="text-4xl md:text-6xl font-extrabold leading-tight mb-3">Welcome to {clubName}</h1>
          <p className="text-zinc-300 text-lg md:text-xl mb-10">Tap start to set up players and launch a game.</p>

          {!activeSession && (
            <div className="mb-6 rounded-xl border border-cyan-700/40 bg-cyan-950/20 px-4 py-3">
              <div className="text-xs uppercase tracking-[0.22em] text-cyan-300 mb-2">Board Queue</div>
              {loadingMatch ? (
                <div className="text-zinc-300 text-sm">Loading next match...</div>
              ) : nextMatch ? (
                <div className="text-sm text-zinc-200">
                  <div className="font-semibold text-white mb-1">
                    {nextMatch.group_name} - Round {nextMatch.round} - Match {nextMatch.slot}
                  </div>
                  <div className="text-zinc-300">
                    {nextMatch.a.name} ({nextMatch.a.start_score}) vs {nextMatch.b.name} ({nextMatch.b.start_score})
                  </div>
                </div>
              ) : (
                <div className="text-zinc-400 text-sm">No queued match for this board yet.</div>
              )}
              {!!matchError && <div className="text-red-300 text-xs mt-2">{matchError}</div>}
            </div>
          )}

          {activeSession && (
            <div className="mb-6 rounded-xl border border-emerald-700/60 bg-emerald-900/20 px-4 py-3 text-emerald-200 text-sm">
              Active Session: {activeSession.playerNames.length} players | {activeSession.game.replace(/_/g, " ")}
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            {!activeSession && !!nextMatch && (
              <button
                type="button"
                onClick={() => void handleReadyForNextMatch()}
                disabled={readyBusy}
                className="inline-flex items-center justify-center rounded-xl border border-emerald-500/70 bg-emerald-600/90 px-8 py-4 text-xl font-semibold text-white shadow-lg shadow-emerald-900/30 hover:bg-emerald-500 disabled:opacity-50"
              >
                {readyBusy ? "Starting..." : "Ready: Start Next Match"}
              </button>
            )}
            <a
              href="#/kiosk/players"
              onClick={handleStart}
              className="inline-flex items-center justify-center rounded-xl border border-red-600/70 bg-red-600/90 px-8 py-4 text-xl font-semibold text-white shadow-lg shadow-red-900/40 hover:bg-red-500"
            >
              {activeSession ? "Continue Session" : "Start Game"}
            </a>
            {activeSession && (
              <button
                type="button"
                onClick={handleEndSession}
                className="inline-flex items-center justify-center rounded-xl border border-red-800 bg-red-950/30 px-8 py-4 text-xl font-semibold text-red-200 hover:bg-red-900/40"
              >
                End Session
              </button>
            )}
            <a
              href="#/setup"
              className="inline-flex items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900/70 px-8 py-4 text-xl font-semibold text-zinc-200 hover:bg-zinc-800/80"
            >
              Board Setup
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
