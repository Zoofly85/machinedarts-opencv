import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

const API_URL = "http://localhost:8000";

type CustomGame = {
  id: string;
  name: string;
  entry: string;
  description?: string;
};

export default function CustomGamesPage() {
  const navigate = useNavigate();
  const [games, setGames] = useState<CustomGame[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadId, setUploadId] = useState("");
  const [uploadDescription, setUploadDescription] = useState("");
  const [uploadFiles, setUploadFiles] = useState<FileList | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const loadGames = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/custom-games`);
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const data = await response.json();
      setGames(Array.isArray(data?.games) ? data.games : []);
      setStatus(null);
    } catch (err) {
      setGames([]);
      setStatus("Failed to load custom games.");
    }
  }, []);

  useEffect(() => {
    loadGames();
  }, [loadGames]);

  const openGame = (game: CustomGame) => {
    const entry = game.entry || "index.html";
    const url = `${API_URL}/custom-games/${game.id}/${entry}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const deleteGame = async (game: CustomGame) => {
    const confirmed = window.confirm(`Delete "${game.name}"? This cannot be undone.`);
    if (!confirmed) {
      return;
    }
    try {
      const response = await fetch(`${API_URL}/api/custom-games/${game.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      loadGames();
    } catch (err) {
      setStatus("Failed to delete custom game.");
    }
  };

  const resetUpload = () => {
    setUploadName("");
    setUploadId("");
    setUploadDescription("");
    setUploadFiles(null);
    setUploadError(null);
  };

  const submitUpload = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!uploadName.trim()) {
      setUploadError("Game name is required.");
      return;
    }
    if (!uploadFiles || uploadFiles.length === 0) {
      setUploadError("Select your game files.");
      return;
    }
    const formData = new FormData();
    formData.append("name", uploadName.trim());
    if (uploadId.trim()) {
      formData.append("game_id", uploadId.trim());
    }
    if (uploadDescription.trim()) {
      formData.append("description", uploadDescription.trim());
    }
    Array.from(uploadFiles).forEach((file) => {
      formData.append("files", file);
    });
    try {
      setUploadBusy(true);
      const response = await fetch(`${API_URL}/api/custom-games/upload`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      resetUpload();
      setShowUpload(false);
      loadGames();
    } catch (err) {
      setUploadError("Upload failed. Check your files and try again.");
    } finally {
      setUploadBusy(false);
    }
  };

  const buildAiPrompt = () => {
    return `Machine Darts Custom Game Info (local-only)

Where to place games:
Windows: %APPDATA%\\DartDetector\\custom_games\\<game_id>\\
Dev: backend-detection\\custom_games\\<game_id>\\

game.json example:
{
  "id": "my-game",
  "name": "My Game",
  "entry": "index.html",
  "description": "Custom practice mode"
}

Live data:
WebSocket: ws://localhost:8000/ws/detection
REST:
  GET  /api/detection/status
  GET  /api/detection/scores
  POST /api/detection/reset
  POST /api/correction/score
  POST /api/correction/add-dart
  POST /api/correction/delete-images

WebSocket events:
  dart_detected -> new dart registered; fetch /api/detection/scores
  darts_removed -> board cleared (takeout complete)
  detection_status_update -> state/FPS update (no new dart)

Sample payloads:
WebSocket (dart_detected):
{"event":"dart_detected","dart_count":2,"detection_state":"no_movement","fps":27.5}

GET /api/detection/scores:
{"dart_count":2,"scores":[{"score":3,"multiplier":1,"segment":1,"zone":"single_inner","confidence":1.0},{"score":12,"multiplier":3,"segment":4,"zone":"triple","confidence":1.0}]}

POST /api/correction/score:
{"dartIndex":1,"multiplier":3,"segment":4,"score":12}

UI guidance:
- Show 3 dart boxes (D1, D2, D3) with score, segment, and multiplier.
- Allow tap/click on a dart box to correct the score (use POST /api/correction/score).
- If a dart is missing, allow an "Add Dart" action (POST /api/correction/add-dart).
- Use darts_removed to confirm takeout/end of turn when players remove darts.
- Advance to the next player only after takeout (darts_removed) once 1-3 darts were thrown (any count > 0).
- Optionally call POST /api/detection/reset after advancing to clear backend dart state.
- Use dart_detected to update the latest dart score UI.`;
  };

  const copyAiPrompt = async () => {
    try {
      await navigator.clipboard.writeText(buildAiPrompt());
      setCopyStatus("Copied AI prompt to clipboard.");
      setTimeout(() => setCopyStatus(null), 2000);
    } catch (err) {
      setCopyStatus("Failed to copy prompt.");
    }
  };

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
        <button
          type="button"
          onClick={() => navigate("/")}
          className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors"
        >
          Back
        </button>
        <div className="flex-1 text-center md:text-left">
          <h1 className="text-2xl font-extrabold tracking-wide">
            Custom <span className="text-red-500">Games</span>
          </h1>
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">
            Local web UIs using Machine Darts detection
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              resetUpload();
              setShowUpload(true);
            }}
            className="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-500 transition-colors"
          >
            Add Game
          </button>
          <button
            type="button"
            onClick={loadGames}
            className="px-4 py-2 rounded-lg bg-zinc-800/90 text-white hover:bg-zinc-700/90 transition-colors"
          >
            Refresh
          </button>
        </div>
      </header>

      <main className="relative z-10 flex-1 px-6 md:px-10 pb-8">
        <div className="h-full w-full max-w-5xl mx-auto">
          {showUpload && (
            <div className="mb-6 rounded-2xl border border-white/10 bg-zinc-900/70 p-5">
              <h2 className="text-sm uppercase tracking-[0.2em] text-zinc-400">Add Custom Game</h2>
              <form className="mt-4 space-y-4 text-sm" onSubmit={submitUpload}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs uppercase tracking-[0.2em] text-zinc-500">Game Name</label>
                    <input
                      type="text"
                      value={uploadName}
                      onChange={(event) => setUploadName(event.target.value)}
                      className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-white focus:border-red-500 focus:outline-none"
                      placeholder="Precision Practice"
                    />
                  </div>
                  <div>
                    <label className="text-xs uppercase tracking-[0.2em] text-zinc-500">Folder Id (optional)</label>
                    <input
                      type="text"
                      value={uploadId}
                      onChange={(event) => setUploadId(event.target.value)}
                      className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-white focus:border-red-500 focus:outline-none"
                      placeholder="precision-practice"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs uppercase tracking-[0.2em] text-zinc-500">Description (optional)</label>
                  <input
                    type="text"
                    value={uploadDescription}
                    onChange={(event) => setUploadDescription(event.target.value)}
                    className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-white focus:border-red-500 focus:outline-none"
                    placeholder="Custom target ladder game with live detection."
                  />
                </div>
                <div>
                  <label className="text-xs uppercase tracking-[0.2em] text-zinc-500">
                    Upload Files (index.html, game.json, assets) or a zip
                  </label>
                  <input
                    type="file"
                    multiple
                    accept=".zip,.html,.js,.css,.json,.png,.jpg,.jpeg,.svg,.gif"
                    onChange={(event) => setUploadFiles(event.target.files)}
                    className="mt-2 w-full text-xs text-zinc-300"
                  />
                </div>
                {uploadError && <div className="text-xs text-red-400">{uploadError}</div>}
                <div className="flex items-center gap-3">
                  <button
                    type="submit"
                    disabled={uploadBusy}
                    className="rounded-lg bg-red-600 px-4 py-2 text-white hover:bg-red-500 transition-colors disabled:opacity-60"
                  >
                    {uploadBusy ? "Uploading..." : "Upload Game"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      resetUpload();
                      setShowUpload(false);
                    }}
                    className="rounded-lg border border-white/10 px-4 py-2 text-zinc-200 hover:border-white/20 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}
          {status && <div className="text-sm text-zinc-400 mb-4">{status}</div>}
          {games.length === 0 && !status && (
            <div className="text-sm text-zinc-500">No custom games found.</div>
          )}
          <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5 mb-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm uppercase tracking-[0.2em] text-zinc-400">How Custom Games Work</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={copyAiPrompt}
                  className="px-3 py-2 rounded-lg border border-white/10 bg-black/40 text-xs uppercase tracking-[0.2em] text-zinc-200 hover:border-red-500 transition-colors"
                >
                  Copy AI Prompt
                </button>
                {copyStatus && <span className="text-xs text-zinc-400">{copyStatus}</span>}
              </div>
            </div>
            <div className="mt-3 space-y-3 text-sm text-zinc-300">
              <p>
                Custom Games are local web pages that read your live detection data from the Machine Darts backend.
                Drop a folder with a <code>game.json</code> manifest into your custom games directory and it will appear here.
              </p>
              <div className="rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-xs text-zinc-200 whitespace-pre-wrap">
{`Windows: %APPDATA%\\DartDetector\\custom_games\\<game_id>\\
Dev: backend-detection\\custom_games\\<game_id>\\`}
              </div>
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">game.json example</p>
              <div className="rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-xs text-zinc-200 whitespace-pre-wrap">
{`{
  "id": "my-game",
  "name": "My Game",
  "entry": "index.html",
  "description": "Custom practice mode"
}`}
              </div>
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Live Data (Local)</p>
              <div className="rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-xs text-zinc-200 whitespace-pre-wrap">
{`WebSocket: ws://localhost:8000/ws/detection
REST:
  GET  /api/detection/status
  GET  /api/detection/scores
  POST /api/detection/reset
  POST /api/correction/score
  POST /api/correction/add-dart
  POST /api/correction/delete-images`}
              </div>
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">WebSocket Events</p>
              <div className="rounded-lg border border-white/10 bg-black/40 p-3 text-xs text-zinc-300 space-y-2">
                <div>
                  <span className="text-zinc-200 font-mono">dart_detected</span>
                  <span className="text-zinc-500"> — new dart registered; fetch </span>
                  <code className="text-zinc-200">/api/detection/scores</code>
                </div>
                <div>
                  <span className="text-zinc-200 font-mono">darts_removed</span>
                  <span className="text-zinc-500"> — board cleared (takeout complete)</span>
                </div>
                <div>
                  <span className="text-zinc-200 font-mono">detection_status_update</span>
                  <span className="text-zinc-500"> — state/FPS update (no new dart)</span>
                </div>
              </div>
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Sample Payloads</p>
              <div className="rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-xs text-zinc-200 whitespace-pre-wrap">
{`WebSocket (dart_detected):
{"event":"dart_detected","dart_count":2,"detection_state":"no_movement","fps":27.5}

GET /api/detection/scores:
{"dart_count":2,"scores":[{"score":3,"multiplier":1,"segment":1,"zone":"single_inner","confidence":1.0},{"score":12,"multiplier":3,"segment":4,"zone":"triple","confidence":1.0}]}

POST /api/correction/score:
{"dartIndex":1,"multiplier":3,"segment":4,"score":12}`}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {games.map((game) => (
              <div
                key={game.id}
                className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5 flex flex-col gap-3"
              >
                <div>
                  <h2 className="text-lg font-semibold text-white">{game.name}</h2>
                  {game.description && (
                    <p className="text-sm text-zinc-400 mt-1">{game.description}</p>
                  )}
                  <p className="text-xs text-zinc-500 mt-2">Entry: {game.entry || "index.html"}</p>
                </div>
                <button
                  type="button"
                  onClick={() => openGame(game)}
                  className="mt-auto inline-flex items-center justify-center rounded-lg bg-red-600 text-white px-4 py-2 hover:bg-red-500 transition-colors"
                >
                  Open Game
                </button>
                <button
                  type="button"
                  onClick={() => deleteGame(game)}
                  className="inline-flex items-center justify-center rounded-lg border border-red-500/60 text-red-200 px-4 py-2 hover:bg-red-600/10 transition-colors"
                >
                  Delete Game
                </button>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
