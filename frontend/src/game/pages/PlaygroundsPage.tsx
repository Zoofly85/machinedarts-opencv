import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { LobbyState } from "../context/LobbyContext";
import { API_BASE_URL } from "../../services/api";

const API_URL = API_BASE_URL;

type PlaygroundScript = {
  id: string;
  name: string;
  updated_at: string;
};

const DEFAULT_TEMPLATE = `name: "My Playground Game"
start_score: 301
darts_per_turn: 3
wait_for_takeout: true
legs_per_set: 3
sets_to_win: 1
win_condition: score_zero
on_dart:
  - action: subtract_score
  - action: check_bust
  - action: check_finish
`;

const AI_PROMPT_TEMPLATE = `You are creating a Machine Darts Playgrounds game script.

Rules format: YAML (JSON also works). The script is LOCAL ONLY.

Required fields:
- name: string
- start_score: integer
- darts_per_turn: integer (1-9)
- legs_per_set: integer (1-20)
- sets_to_win: integer (1-10)
- win_condition: score_zero | score_at_or_below | score_at_or_above
- win_value: integer (required for score_at_or_below/above)
- wait_for_takeout: boolean (optional, default true)
- on_dart: list of actions (see below)

Each on_dart entry can be:
- action: <action_name>
- when: condition object OR list of conditions
- do: list of action objects (for conditional blocks)

Condition object fields:
- field: score | zone | segment | multiplier | player_score | darts_thrown | round | player_zones_count | zone_marked | player_has_zone | player_stat.<key> | game_stat.<key>
- op: equals | not_equals | lt | lte | gt | gte | in | not_in | exists
- value: number or list (depending on op)
- value_field: another field name to compare against (e.g. player_score)

Supported actions:
- add_score (optional: value)
- subtract_score (optional: value)
- set_score (value)
- set_player_score (player_index, value)
- check_bust
- check_finish (optional: condition/value)
- win_if (condition)
- award_leg
- award_set
- reset_leg
- reset_match
- next_player
- next_round
- reset_turn
- set_round (value)
- set_current_player (value)
- mark_zone (optional key)
- set_target_from_list (targets: list of zone keys)
- increment_stat (key, amount)
- set_stat (key, value)
- set_player_stat (player_index, key, value)
- increment_game_stat (key, amount)
- set_game_stat (key, value)

Zone keys used by mark_zone:
- single_1..single_20
- double_any
- triple_any
- outer_bull
- inner_bull

Detection zone values (from live darts):
- single_inner, single_outer
- double, triple
- outer_bull, inner_bull
- miss

Notes:
- mark_zone without a key auto-selects based on the dart (zone/segment).
- zone_marked is true only if mark_zone added a NEW zone this dart.
- player_zones_count is the number of unique zones cleared.
- add_score/subtract_score use the dart score unless value is provided.
- set_stat/set_game_stat values can be integers or strings.
- If you want to show a target to the player, set player_stat "target_hint".
- player_has_zone uses value as the zone key (e.g. "single_20") with equals/not_equals.
- set_target_from_list sets player_stat "target_hint" to the first uncleared zone in the list.
- Turns advance automatically after darts_per_turn; with wait_for_takeout=true the next player starts only after darts are removed (even if fewer than 3 were thrown).
- Corrections only apply to the current turn before takeout/next player.
- To require specific doubles/triples, use conditions like: multiplier equals 2 and segment equals 16 (D16), or multiplier equals 3 and segment equals 20 (T20).
- Bots do not wait for takeout.
- value_field is required for comparing one field to another (example: segment equals player_score).
- The engine only knows the detected dart (score/zone/segment/multiplier); it does not know board coordinates.
- mark_zone does not affect score unless you add add_score/subtract_score actions.
- Valid segment values: 1-20, plus 25 for bulls.
- Valid multipliers: 1, 2, 3 (bulls use segment 25 with multiplier 1 or 2).
- A miss is usually score=0 or zone=miss (segment may be 0).
- The target display only updates when player_stat "target_hint" is set.
- You can use when/do blocks to build custom logic.

Ask the user clarifying questions about:
1) Objective / win condition
2) Scoring rules
3) Turn/round flow
4) Bust rules
5) Legs/sets
6) Special zones or bonuses
Then output a valid YAML script.`;

export default function PlaygroundsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const lobbyState = location.state as LobbyState | undefined;
  const [scripts, setScripts] = useState<PlaygroundScript[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState<string>(DEFAULT_TEMPLATE);
  const [status, setStatus] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const loadScripts = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/playgrounds`);
      const data = await response.json();
      setScripts(Array.isArray(data?.scripts) ? data.scripts : []);
    } catch (err) {
      setScripts([]);
      setStatus("Failed to load playground scripts.");
    }
  }, []);

  const loadScript = useCallback(async (scriptId: string) => {
    try {
      const response = await fetch(`${API_URL}/api/playgrounds/${scriptId}`);
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const data = await response.json();
      setSelectedId(data.id);
      setContent(data.content || "");
      setStatus(null);
    } catch (err) {
      setStatus("Failed to load script.");
    }
  }, []);

  useEffect(() => {
    loadScripts();
  }, [loadScripts]);

  const selectedScript = useMemo(
    () => scripts.find((script) => script.id === selectedId) || null,
    [scripts, selectedId]
  );

  const handleCreate = () => {
    setSelectedId(null);
    setContent(DEFAULT_TEMPLATE);
    setStatus("New script ready. Update name and save.");
  };

  const handleSave = async () => {
    setIsSaving(true);
    setStatus(null);
    try {
      const response = await fetch(`${API_URL}/api/playgrounds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedId ?? undefined, content }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "Failed to save script.");
      }
      const data = await response.json();
      setSelectedId(data.id);
      await loadScripts();
      setStatus("Script saved.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Failed to save script.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleStart = () => {
    if (!selectedId || !lobbyState) {
      setStatus("Select a script and start from the lobby.");
      return;
    }
    navigate("/playgrounds/play", {
      state: {
        scriptId: selectedId,
        players: lobbyState.players,
      },
    });
  };

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(AI_PROMPT_TEMPLATE);
      setStatus("AI prompt copied to clipboard.");
    } catch (err) {
      setStatus("Failed to copy AI prompt.");
    }
  };

  const handleDelete = async () => {
    if (!selectedId) {
      return;
    }
    if (!window.confirm("Delete this script?")) {
      return;
    }
    try {
      const response = await fetch(`${API_URL}/api/playgrounds/${selectedId}`, { method: "DELETE" });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "Failed to delete script.");
      }
      setSelectedId(null);
      setContent(DEFAULT_TEMPLATE);
      await loadScripts();
      setStatus("Script deleted.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Failed to delete script.");
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
        <div className="flex-1 text-center md:text-left">
          <h1 className="text-2xl font-extrabold tracking-wide">
            Playgrounds <span className="text-red-500">Scripts</span>
          </h1>
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Local-only custom games</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopyPrompt}
            className="px-4 py-2 rounded-lg bg-zinc-800/90 text-white hover:bg-zinc-700/90 transition-colors"
          >
            Copy AI Prompt
          </button>
          <button
            type="button"
            onClick={handleCreate}
            className="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-500 transition-colors"
          >
            Create New
          </button>
          <button
            type="button"
            onClick={handleStart}
            className="px-4 py-2 rounded-lg bg-zinc-800/90 text-white hover:bg-zinc-700/90 transition-colors"
          >
            Start Script
          </button>
        </div>
        <button
          type="button"
          onClick={() => navigate("/lobby")}
          className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors"
        >
          Back
        </button>
      </header>

      <main className="relative z-10 flex-1 px-6 md:px-10 pb-8">
        <div className="h-full w-full max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
          <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-4 space-y-3">
            <h2 className="text-sm uppercase tracking-[0.2em] text-zinc-400">Saved Scripts</h2>
            <div className="space-y-2">
              {scripts.length === 0 && (
                <div className="text-sm text-zinc-500">No scripts yet. Create one.</div>
              )}
              {scripts.map((script) => (
                <button
                  key={script.id}
                  type="button"
                  onClick={() => loadScript(script.id)}
                  className={`w-full rounded-xl border px-4 py-3 text-left transition ${
                    script.id === selectedId
                      ? "border-red-600 bg-red-600/20"
                      : "border-white/10 hover:border-red-600/60 hover:bg-red-600/10"
                  }`}
                >
                  <div className="text-sm font-semibold text-white">{script.name}</div>
                  <div className="text-xs text-zinc-500">
                    Updated {new Date(script.updated_at).toLocaleString()}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="bg-zinc-900/60 border border-white/10 rounded-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Editor</p>
                <p className="text-sm text-white">
                  {selectedScript ? selectedScript.name : "New Script"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {selectedId && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm"
                  >
                    Delete
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaving}
                  className="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-500 text-sm disabled:opacity-60"
                >
                  {isSaving ? "Saving..." : "Save Script"}
                </button>
              </div>
            </div>

            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              className="flex-1 min-h-[420px] w-full rounded-xl bg-black/70 border border-white/10 p-4 text-sm font-mono text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-500"
              spellCheck={false}
            />

            {status && <div className="text-sm text-zinc-400">{status}</div>}
            <div className="text-xs text-zinc-500">
              Scripts are stored locally. Only the Playgrounds engine will read them.
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
