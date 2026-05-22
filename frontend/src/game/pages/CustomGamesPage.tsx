import React from "react";
import { ArrowLeft, Check, Clipboard, Code2, Download, Play, PlugZap, Radio, ShieldCheck, Trash2, Upload } from "lucide-react";
import { Link } from "react-router-dom";
import { API_BASE_URL } from "../../services/api";

const AI_BRIEF = `Build a custom frontend game for Machine Darts.

Use the Machine Darts backend at http://127.0.0.1:8000.
The finished game must be a built static frontend that can be imported into Machine Darts as a ZIP package.

Hard requirements:
- Use WebSocket detection events. Do not poll for live dart state.
- Open one persistent WebSocket to ws://127.0.0.1:8000/ws/detection/events when possible.
- Keep game state in a local reducer/state machine and apply incoming dart events exactly once by sequence number.
- Use HTTP only for user actions such as reset, correction, adding a missed dart, saving training/session data, and reports.
- Keep UI efficient for a kiosk/tablet: no animation loops unless needed, no frequent fetch loops, no blocking work in render.
- Show a visible connection state, current detection state, darts on board, current turn darts, score correction controls, and a reset button.
- Handle takeout/removal events so the game can wait until the board is clear before accepting the next visit.
- Use absolute Machine Darts API URLs: http://127.0.0.1:8000 and ws://127.0.0.1:8000.
- Do not require a dev server, backend build step, Node server, database, or environment variables at runtime.
- Keep assets relative to index.html so the imported game works from /custom-games-content/{gameId}/index.html.
- The game may run embedded in an iframe, so do not rely on controlling the parent page.
- Use localStorage only for optional local preferences, not as the source of truth for live scoring.
- Avoid external network dependencies unless they are optional; the game should work offline with Machine Darts running locally.

Detection WebSocket:
- Preferred: ws://127.0.0.1:8000/ws/detection/events
- Legacy fallback: ws://127.0.0.1:8000/ws/detection

Important event types from /ws/detection/events:
- state_changed: includes seq, from_state, to_state, darts_on_board.
- dart_detected: physical dart was seen; includes seq, darts_on_board, and detection_counter. Do not expect a score here.
- dart_score: async scoring completed; includes seq, dart_index when available, score_value, score, votes, active_model_id, and timings.
- dart_score_unavailable: scoring ran but no reliable score was available.
- takeout_complete: board was cleared; reset local visit locks.
- dart_score_corrected: manual score correction was applied.

Recommended event handling:
- Store latestSeq and ignore any message with seq <= latestSeq.
- Treat darts_on_board as the board count, not as a total match dart count.
- A visit is normally up to 3 darts. Stop accepting new detected darts for the visit once 3 darts are recorded until takeout_complete or reset.
- On dart_detected, mark the corresponding dart slot as "scoring..." or pending. Do not fill a score box from dart_detected.
- On dart_score, fill/update the dart slot using event.dart_index when present. If dart_index is missing, apply it to the earliest pending dart slot.
- Normalize dart_score into this shape: { score: event.score_value ?? event.score?.score, multiplier: event.score?.multiplier, segment: event.score?.segment, zone: event.score?.zone, confidence: event.score?.confidence }.
- If the UI needs a full visit snapshot, call GET /api/detection/scores?raw=true once after dart_score, or with short bounded retries after dart_detected such as 250ms, 600ms, 1000ms. This is not polling; it is a bounded score-read fallback.
- When state_changed.to_state is "partial_takeout" or "removing_darts", show a waiting/removal state.
- When takeout_complete arrives, clear the visit board lock and prepare the next player/turn.
- GET /api/detection/round-dart/{dartIndex} is optional diagnostics/detail. It may return 404 if scoring has not been stored yet, so do not depend on it for normal score boxes.
- If a score is not ready yet, keep the slot as pending instead of reverting to empty/waiting.

Useful HTTP endpoints:
- POST /api/detection/reset
- GET /api/detection/scores?raw=true
- GET /api/detection/round-dart/{1|2|3}
- POST /api/correction/score with { dartIndex, multiplier, segment, score, zone?, bouncer? }
- POST /api/correction/add-dart with { dartIndex, multiplier, segment, score, zone?, bouncer? }
- POST /api/benchmark-dataset/save-turn with { dataset_name, scores }
- Training sessions:
  - GET /api/training/programs
  - POST /api/training/sessions/start
  - POST /api/training/sessions/{sessionId}/events
  - PUT /api/training/sessions/{sessionId}/events/{eventId}
  - POST /api/training/sessions/{sessionId}/complete

Score payload shape:
{
  score: number,
  multiplier: 0 | 1 | 2 | 3,
  segment: string,
  zone: "miss" | "single" | "single_inner" | "single_outer" | "double" | "triple" | "outer_bull" | "inner_bull",
  confidence?: number
}

Package the finished game as a ZIP with this structure:
- custom-game.json
- index.html
- assets/...

The ZIP root may contain those files directly, or one top-level folder containing them.
Maximum ZIP size should stay below 25 MB.

custom-game.json:
{
  "id": "my-custom-game",
  "name": "My Custom Game",
  "description": "Short description",
  "version": "1.0.0",
  "author": "Your name"
}

Build output requirements:
- Produce final static files, not source-only files.
- For Vite, use a relative asset base such as base: "./".
- index.html must be the game entrypoint.
- Do not include node_modules in the ZIP.

Build the app as a React + TypeScript single page. Include a small API client, a WebSocket client with reconnect/backoff, and a pure game reducer. The reducer should ignore duplicate events using the latest seq. Include clear user controls for reset, correction, adding a missed/bouncer dart, and exporting/downloading any game data the custom game owns.`;

type CopyState = "idle" | "copied" | "failed";

type CustomGame = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  importedAt?: number;
  packageBytes?: number;
  launchUrl: string;
  downloadUrl: string;
};

function formatPackageSize(bytes?: number): string {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => {
      const result = String(reader.result || "");
      const [, encoded = ""] = result.split(",", 2);
      if (!encoded) {
        reject(new Error("Failed to encode file"));
        return;
      }
      resolve(encoded);
    };
    reader.readAsDataURL(file);
  });
}

function ContractCard({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-white/10 bg-zinc-950/80 p-5">
      <div className="mb-3 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-600/20 text-red-300">
          {icon}
        </div>
        <h2 className="text-base font-bold text-white">{title}</h2>
      </div>
      <div className="text-sm leading-6 text-zinc-300">{children}</div>
    </section>
  );
}

export default function CustomGamesPage() {
  const [copyState, setCopyState] = React.useState<CopyState>("idle");
  const [games, setGames] = React.useState<CustomGame[]>([]);
  const [selectedGameId, setSelectedGameId] = React.useState<string>("");
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string>("");
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const contractRef = React.useRef<HTMLElement | null>(null);

  const selectedGame = React.useMemo(
    () => games.find((game) => game.id === selectedGameId) ?? games[0] ?? null,
    [games, selectedGameId],
  );

  const loadGames = React.useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/custom-games`);
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      const items = Array.isArray(data?.games) ? data.games : [];
      setGames(items);
      setSelectedGameId((current) => {
        if (current && items.some((game: CustomGame) => game.id === current)) return current;
        return items[0]?.id ?? "";
      });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to load custom games");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadGames();
  }, [loadGames]);

  const copyBrief = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(AI_BRIEF);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 2200);
    }
  }, []);

  const handleImportFile = React.useCallback(
    async (file: File) => {
      setBusy(true);
      setMessage("");
      try {
        const contentBase64 = await fileToBase64(file);
        const response = await fetch(`${API_BASE_URL}/api/custom-games/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, content_base64: contentBase64 }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (response.status === 405) {
            throw new Error(
              "Import endpoint returned Method Not Allowed. Restart the Machine Darts backend so the new custom-games API routes are active.",
            );
          }
          throw new Error(String(data?.detail || `Import failed with ${response.status}`));
        }
        const imported = data?.game as CustomGame | undefined;
        setMessage(imported?.name ? `Imported ${imported.name}` : "Custom game imported");
        await loadGames();
        if (imported?.id) setSelectedGameId(imported.id);
      } catch (err) {
        setMessage(err instanceof Error ? err.message : "Failed to import custom game");
      } finally {
        setBusy(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [loadGames],
  );

  const handleDelete = React.useCallback(
    async (game: CustomGame) => {
      const confirmed = window.confirm(`Delete "${game.name}" from this Machine Darts install?`);
      if (!confirmed) return;
      setBusy(true);
      setMessage("");
      try {
        const response = await fetch(`${API_BASE_URL}/api/custom-games/${encodeURIComponent(game.id)}`, {
          method: "DELETE",
        });
        if (!response.ok) throw new Error(await response.text());
        setMessage(`Deleted ${game.name}`);
        await loadGames();
      } catch (err) {
        setMessage(err instanceof Error ? err.message : "Failed to delete custom game");
      } finally {
        setBusy(false);
      }
    },
    [loadGames],
  );

  return (
    <div className="min-h-screen bg-black text-white">
      <div
        className="pointer-events-none fixed inset-0 [background:
          radial-gradient(ellipse_at_top_left,rgba(220,38,38,0.18),transparent_55%),
          radial-gradient(ellipse_at_bottom_right,rgba(14,165,233,0.12),transparent_60%),
          linear-gradient(135deg,rgba(15,23,42,0.58),rgba(0,0,0,0.96)_42%,rgba(24,24,27,1)_100%)
        ]"
      />

      <header className="relative z-10 flex items-center justify-between px-6 py-6 md:px-10">
        <Link
          to="/game"
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-zinc-900/80 px-4 py-2 text-sm font-semibold text-zinc-200 transition hover:bg-zinc-800"
        >
          <ArrowLeft className="h-4 w-4" />
          Games
        </Link>
        <div className="text-xs uppercase text-zinc-500">Machine Darts Extension Contract</div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-6xl px-6 pb-12 md:px-10">
        <section className="grid gap-8 py-6 lg:grid-cols-[1fr_0.88fr] lg:items-start">
          <div>
            <div className="mb-4 inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-1 text-xs font-semibold uppercase text-red-200">
              <Code2 className="h-4 w-4" />
              Custom Frontend Games
            </div>
            <h1 className="max-w-3xl text-4xl font-extrabold leading-tight text-white sm:text-5xl">
              Give builders the detection contract, then let them create.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-300">
              Custom games should subscribe to live detection events, keep their own game state locally, and call the backend only when a player takes an explicit action.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleImportFile(file);
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-400 disabled:opacity-60"
              >
                <Upload className="h-4 w-4" />
                Import Game ZIP
              </button>
              <button
                type="button"
                onClick={copyBrief}
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-zinc-900/80 px-5 py-3 text-sm font-bold text-zinc-100 transition hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-red-400"
              >
                {copyState === "copied" ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
                {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy Failed" : "Copy AI Brief"}
              </button>
              <button
                type="button"
                onClick={() => contractRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-zinc-900/80 px-5 py-3 text-sm font-bold text-zinc-100 transition hover:bg-zinc-800"
              >
                <PlugZap className="h-4 w-4" />
                View Contract
              </button>
            </div>
            {message && (
              <div className="mt-4 rounded-lg border border-white/10 bg-zinc-950/90 px-4 py-3 text-sm text-zinc-200">
                {message}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-white/10 bg-zinc-950/90 p-4 shadow-2xl shadow-black/40">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-bold text-zinc-100">Copy-ready AI brief</div>
              <div className="text-xs text-zinc-500">{AI_BRIEF.length} chars</div>
            </div>
            <textarea
              value={AI_BRIEF}
              readOnly
              className="h-[420px] w-full resize-none rounded-lg border border-white/10 bg-black/70 p-4 font-mono text-xs leading-5 text-zinc-200 outline-none"
            />
          </div>
        </section>

        <section className="mb-6 grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
          <div className="rounded-lg border border-white/10 bg-zinc-950/90 p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-white">Installed Custom Games</h2>
                <p className="mt-1 text-sm text-zinc-400">Import ZIP packages, choose one to play, or download the package to share.</p>
              </div>
              <button
                type="button"
                onClick={() => void loadGames()}
                disabled={loading || busy}
                className="rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-xs font-bold text-zinc-200 transition hover:bg-zinc-800 disabled:opacity-60"
              >
                Refresh
              </button>
            </div>
            {loading ? (
              <div className="rounded-lg border border-white/10 bg-black/50 p-4 text-sm text-zinc-400">Loading custom games...</div>
            ) : games.length === 0 ? (
              <div className="rounded-lg border border-dashed border-white/15 bg-black/50 p-5 text-sm leading-6 text-zinc-400">
                No custom games imported yet. Import a ZIP that contains <span className="font-mono text-zinc-200">custom-game.json</span> and{" "}
                <span className="font-mono text-zinc-200">index.html</span>.
              </div>
            ) : (
              <div className="space-y-3">
                {games.map((game) => {
                  const active = selectedGame?.id === game.id;
                  return (
                    <button
                      key={game.id}
                      type="button"
                      onClick={() => setSelectedGameId(game.id)}
                      className={`w-full rounded-lg border p-4 text-left transition ${
                        active
                          ? "border-red-500/60 bg-red-950/30"
                          : "border-white/10 bg-black/45 hover:bg-zinc-900"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-bold text-white">{game.name}</div>
                          <div className="mt-1 text-sm text-zinc-400">{game.description || "No description provided."}</div>
                        </div>
                        <div className="text-xs text-zinc-500">{game.version || ""}</div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-500">
                        {game.author && <span>{game.author}</span>}
                        {formatPackageSize(game.packageBytes) && <span>{formatPackageSize(game.packageBytes)}</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-white/10 bg-zinc-950/90 p-5">
            {selectedGame ? (
              <>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-bold text-white">{selectedGame.name}</h2>
                    <p className="mt-1 text-sm text-zinc-400">{selectedGame.description || "Ready to launch."}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a
                      href={`${API_BASE_URL}${selectedGame.launchUrl}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-red-500"
                    >
                      <Play className="h-4 w-4" />
                      Open
                    </a>
                    <a
                      href={`${API_BASE_URL}${selectedGame.downloadUrl}`}
                      className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-xs font-bold text-zinc-100 transition hover:bg-zinc-800"
                    >
                      <Download className="h-4 w-4" />
                      Share ZIP
                    </a>
                    <button
                      type="button"
                      onClick={() => void handleDelete(selectedGame)}
                      disabled={busy}
                      className="inline-flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-950/30 px-3 py-2 text-xs font-bold text-red-100 transition hover:bg-red-900/40 disabled:opacity-60"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </button>
                  </div>
                </div>
                <div className="overflow-hidden rounded-lg border border-white/10 bg-black">
                  <iframe
                    key={selectedGame.id}
                    title={selectedGame.name}
                    src={`${API_BASE_URL}${selectedGame.launchUrl}`}
                    sandbox="allow-scripts allow-forms allow-popups"
                    className="h-[560px] w-full bg-black"
                  />
                </div>
              </>
            ) : (
              <div className="flex min-h-[360px] items-center justify-center rounded-lg border border-dashed border-white/15 bg-black/50 p-6 text-center text-sm text-zinc-400">
                Select or import a custom game to preview it here.
              </div>
            )}
          </div>
        </section>

        <section ref={contractRef} className="scroll-mt-6 grid gap-4 md:grid-cols-3">
          <ContractCard icon={<Radio className="h-5 w-5" />} title="Live Detection">
            Use one WebSocket connection for live board state. Prefer <span className="font-mono text-red-200">/ws/detection/events</span>; fall back to{" "}
            <span className="font-mono text-red-200">/ws/detection</span> only for legacy clients.
          </ContractCard>
          <ContractCard icon={<ShieldCheck className="h-5 w-5" />} title="Mutations">
            Use HTTP for reset, score correction, adding missed darts, and training/session writes. These actions should happen from explicit player controls.
          </ContractCard>
          <ContractCard icon={<PlugZap className="h-5 w-5" />} title="Performance">
            Keep the frontend event-driven. Avoid score polling loops, debounce expensive UI updates, and ignore duplicate socket events by sequence number.
          </ContractCard>
        </section>

      </main>
    </div>
  );
}
