import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  archiveTrainingProgram,
  createTrainingProgram,
  deleteTrainingProgram,
  getTrainingProgramReport,
  getTrainingReportOverview,
  listTrainingPrograms,
  startTrainingSession,
  type TrainingBlock,
  type TrainingBlockType,
  type TrainingProgram,
} from "../services/trainingApi";
import { getPlayersCached, type PlayerProfile } from "../services/playersApi";

type EditableBlock = {
  localId: string;
  type: TrainingBlockType;
  targets: string;
  hitsRequired: number;
  dartsPerTarget: number;
  orderMode: "sequential" | "any_order";
  visitSize: 1 | 3;
};

const makeDefaultBlock = (type: TrainingBlockType): EditableBlock => ({
  localId:
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
  type,
  targets: type === "doubles" ? "D20,D16,D8" : "T20,T19,T18",
  hitsRequired: 10,
  dartsPerTarget: 60,
  orderMode: "sequential",
  visitSize: 3,
});

function blockToPayload(block: EditableBlock, order: number): TrainingBlock {
  if (block.type === "doubles") {
    return {
      order,
      type: "doubles",
      config: {
        targets: block.targets.split(",").map((t) => t.trim()).filter(Boolean),
        hitsRequiredPerTarget: Math.max(1, Number(block.hitsRequired || 1)),
        orderMode: block.orderMode,
      },
    };
  }
  return {
    order,
    type: "power_scoring",
    config: {
      targets: block.targets.split(",").map((t) => t.trim()).filter(Boolean),
      dartsPerTarget: Math.max(1, Number(block.dartsPerTarget || 1)),
      orderMode: block.orderMode,
      visitSize: block.visitSize,
    },
  };
}

export default function TrainingProgramsPage() {
  const navigate = useNavigate();
  const [programs, setPrograms] = useState<TrainingProgram[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [playerName, setPlayerName] = useState("");
  const [profiles, setProfiles] = useState<PlayerProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [overviewReport, setOverviewReport] = useState<Record<string, unknown> | null>(null);
  const [programReport, setProgramReport] = useState<Record<string, unknown> | null>(null);
  const [programReportId, setProgramReportId] = useState<string>("");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [createdBy, setCreatedBy] = useState("");
  const [blocks, setBlocks] = useState<EditableBlock[]>([makeDefaultBlock("doubles")]);

  const loadPrograms = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listTrainingPrograms(true);
      setPrograms(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load training programs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPrograms();
  }, [loadPrograms]);

  const loadProfiles = useCallback(async () => {
    setProfilesLoading(true);
    try {
      const data = await getPlayersCached();
      const next = data.filter((p) => !p.name.toLowerCase().startsWith("bot level "));
      setProfiles(next);
    } catch {
      setProfiles([]);
    } finally {
      setProfilesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    if (!profiles.length) return;
    const defaultProfileId = localStorage.getItem("defaultProfileId") || "";
    if (defaultProfileId && profiles.some((p) => p.id === defaultProfileId)) {
      setSelectedProfileId(defaultProfileId);
      return;
    }
    if (!selectedProfileId || !profiles.some((p) => p.id === selectedProfileId)) {
      setSelectedProfileId(profiles[0].id);
    }
  }, [profiles, selectedProfileId]);

  const loadOverview = useCallback(async () => {
    try {
      const report = await getTrainingReportOverview("");
      setOverviewReport(report);
    } catch {
      // Keep page usable if reports endpoint is not available.
    }
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  const canSave = useMemo(() => name.trim().length > 0 && blocks.length > 0, [name, blocks.length]);

  const updateBlock = (localId: string, updater: (prev: EditableBlock) => EditableBlock) => {
    setBlocks((prev) => prev.map((block) => (block.localId === localId ? updater(block) : block)));
  };

  const addBlock = (type: TrainingBlockType) => {
    setBlocks((prev) => [...prev, makeDefaultBlock(type)]);
  };

  const removeBlock = (localId: string) => {
    setBlocks((prev) => prev.filter((block) => block.localId !== localId));
  };

  const handleCreateProgram = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await createTrainingProgram({
        name: name.trim(),
        description: description.trim(),
        created_by: createdBy.trim(),
        blocks: blocks.map((block, idx) => blockToPayload(block, idx)),
      });
      setName("");
      setDescription("");
      setBlocks([makeDefaultBlock("doubles")]);
      setMessage("Training program saved.");
      await loadPrograms();
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save training program");
    } finally {
      setSaving(false);
    }
  };

  const handleStartSession = async (programId: string) => {
    setError(null);
    setMessage(null);
    try {
      const selectedProfile = profiles.find((p) => p.id === selectedProfileId) ?? null;
      const session = await startTrainingSession({
        program_id: programId,
        player_id: selectedProfile?.id || undefined,
        player_name: selectedProfile?.name || playerName.trim(),
      });
      navigate(`/training/session/${session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start training session");
    }
  };

  const handleArchive = async (programId: string, archived: boolean) => {
    setError(null);
    try {
      await archiveTrainingProgram(programId, archived);
      await loadPrograms();
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update archive status");
    }
  };

  const handleDelete = async (programId: string) => {
    setError(null);
    try {
      await deleteTrainingProgram(programId);
      await loadPrograms();
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete program");
    }
  };

  const handleViewProgramReport = async (programId: string) => {
    setProgramReportId(programId);
    try {
      const report = await getTrainingProgramReport(programId, "");
      setProgramReport(report);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load program report");
    }
  };

  const windows = (overviewReport?.windows ?? {}) as Record<string, Record<string, number>>;
  const day = windows.day ?? {};
  const week = windows.week ?? {};
  const month = windows.month ?? {};
  const timelineByDay = (overviewReport?.timelineByDay ?? []) as Array<Record<string, unknown>>;
  const reportAnalytics = (programReport?.analytics ?? {}) as Record<string, unknown>;
  const perTarget = (reportAnalytics?.perTarget ?? []) as Array<Record<string, unknown>>;
  const overall = (reportAnalytics?.overall ?? {}) as Record<string, unknown>;

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden flex flex-col">
      <div className="pointer-events-none fixed inset-0 [background:
        radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
        radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
        radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
        radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
        linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
      ]" />

      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between">
        <h1 className="text-2xl font-extrabold tracking-wide">
          Training <span className="text-red-500">Programs</span>
        </h1>
        <Link to="/games" className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors">
          Back
        </Link>
      </header>

      <main className="relative z-10 w-full px-6 md:px-10 pb-10">
        <div className="max-w-7xl mx-auto grid grid-cols-1 xl:grid-cols-[1.2fr_1fr] gap-6">
          <section className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
            <h2 className="text-xl font-bold mb-4">Create Program</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Program name"
                className="rounded-lg bg-black/50 border border-white/15 px-3 py-2 outline-none focus:border-cyan-500"
              />
              <input
                value={createdBy}
                onChange={(e) => setCreatedBy(e.target.value)}
                placeholder="Created by (optional)"
                className="rounded-lg bg-black/50 border border-white/15 px-3 py-2 outline-none focus:border-cyan-500"
              />
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description"
                className="rounded-lg bg-black/50 border border-white/15 px-3 py-2 outline-none focus:border-cyan-500 md:col-span-2"
              />
            </div>

            <div className="flex flex-wrap gap-2 mb-4">
              <button
                onClick={() => addBlock("doubles")}
                className="px-3 py-1.5 rounded-lg bg-red-600/80 hover:bg-red-500 text-sm font-semibold"
              >
                Add Doubles Block
              </button>
              <button
                onClick={() => addBlock("power_scoring")}
                className="px-3 py-1.5 rounded-lg bg-cyan-700/80 hover:bg-cyan-600 text-sm font-semibold"
              >
                Add Power Scoring Block
              </button>
            </div>

            <div className="space-y-3">
              {blocks.map((block, idx) => (
                <div key={block.localId} className="rounded-xl border border-white/10 bg-black/35 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm uppercase tracking-[0.2em] text-zinc-400">
                      Block {idx + 1}: {block.type === "doubles" ? "Doubles" : "Power Scoring"}
                    </div>
                    <button
                      onClick={() => removeBlock(block.localId)}
                      className="text-xs text-red-300 hover:text-red-200"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <input
                      value={block.targets}
                      onChange={(e) => updateBlock(block.localId, (prev) => ({ ...prev, targets: e.target.value }))}
                      placeholder={block.type === "doubles" ? "D20,D16,D8" : "T20,T19,T18"}
                      className="rounded bg-black/50 border border-white/15 px-3 py-2 text-sm outline-none focus:border-cyan-500"
                    />
                    <select
                      value={block.orderMode}
                      onChange={(e) =>
                        updateBlock(block.localId, (prev) => ({ ...prev, orderMode: e.target.value as "sequential" | "any_order" }))
                      }
                      className="rounded bg-black/50 border border-white/15 px-3 py-2 text-sm outline-none focus:border-cyan-500"
                    >
                      <option value="sequential">Sequential</option>
                      <option value="any_order">Any Order</option>
                    </select>
                    {block.type === "doubles" ? (
                      <input
                        type="number"
                        min={1}
                        value={block.hitsRequired}
                        onChange={(e) =>
                          updateBlock(block.localId, (prev) => ({ ...prev, hitsRequired: Number(e.target.value || 1) }))
                        }
                        className="rounded bg-black/50 border border-white/15 px-3 py-2 text-sm outline-none focus:border-cyan-500"
                        placeholder="Hits required per target"
                      />
                    ) : (
                      <>
                        <input
                          type="number"
                          min={1}
                          value={block.dartsPerTarget}
                          onChange={(e) =>
                            updateBlock(block.localId, (prev) => ({ ...prev, dartsPerTarget: Number(e.target.value || 1) }))
                          }
                          className="rounded bg-black/50 border border-white/15 px-3 py-2 text-sm outline-none focus:border-cyan-500"
                          placeholder="Darts per target"
                        />
                        <select
                          value={block.visitSize}
                          onChange={(e) =>
                            updateBlock(block.localId, (prev) => ({ ...prev, visitSize: Number(e.target.value) as 1 | 3 }))
                          }
                          className="rounded bg-black/50 border border-white/15 px-3 py-2 text-sm outline-none focus:border-cyan-500"
                        >
                          <option value={1}>Visit size: 1 dart</option>
                          <option value={3}>Visit size: 3 darts</option>
                        </select>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4">
              <button
                onClick={handleCreateProgram}
                disabled={!canSave || saving}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 font-semibold"
              >
                {saving ? "Saving..." : "Save Program"}
              </button>
            </div>
          </section>

          <section className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
            <h2 className="text-xl font-bold mb-3">Saved Programs</h2>
            <div className="mb-2">
              <label className="block text-xs uppercase tracking-[0.25em] text-zinc-500 mb-1">Profile Player</label>
              <select
                value={selectedProfileId}
                onChange={(e) => setSelectedProfileId(e.target.value)}
                className="w-full rounded bg-black/50 border border-white/15 px-3 py-2 text-sm outline-none focus:border-cyan-500"
              >
                <option value="">
                  {profilesLoading ? "Loading profiles..." : profiles.length ? "No Profile (manual name)" : "No profiles available"}
                </option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </div>
            {!selectedProfileId && (
              <div className="mb-3">
                <input
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  placeholder="Session player name"
                  className="w-full rounded bg-black/50 border border-white/15 px-3 py-2 text-sm outline-none focus:border-cyan-500"
                />
              </div>
            )}
            {selectedProfileId && (
              <div className="mb-3 text-xs text-cyan-300">
                Training session will save under selected profile.
              </div>
            )}
            {loading ? (
              <div className="text-zinc-400 text-sm">Loading programs...</div>
            ) : programs.length === 0 ? (
              <div className="text-zinc-400 text-sm">No programs yet.</div>
            ) : (
              <div className="space-y-3 max-h-[70vh] overflow-auto pr-1">
                {programs.map((program) => (
                  <div key={program.id} className="rounded-xl border border-white/10 bg-black/35 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-base font-semibold">{program.name}</div>
                        <div className="text-xs text-zinc-400">{program.description || "No description"}</div>
                        <div className="text-xs text-zinc-500 mt-1">
                          Blocks: {program.blocks.length} | Updated: {new Date(program.updatedAt).toLocaleString()}
                        </div>
                      </div>
                      {program.isArchived && <span className="text-[10px] px-2 py-1 rounded bg-zinc-700 text-zinc-200">Archived</span>}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        onClick={() => handleStartSession(program.id)}
                        disabled={program.isArchived}
                        className="px-3 py-1.5 rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-sm"
                      >
                        Start Session
                      </button>
                      <button
                        onClick={() => handleViewProgramReport(program.id)}
                        className="px-3 py-1.5 rounded bg-indigo-700 hover:bg-indigo-600 text-sm"
                      >
                        Report
                      </button>
                      <button
                        onClick={() => handleArchive(program.id, !program.isArchived)}
                        className="px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-sm"
                      >
                        {program.isArchived ? "Unarchive" : "Archive"}
                      </button>
                      <button
                        onClick={() => handleDelete(program.id)}
                        className="px-3 py-1.5 rounded bg-red-700 hover:bg-red-600 text-sm"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="max-w-7xl mx-auto mt-6 grid grid-cols-1 xl:grid-cols-[1fr_1fr] gap-6">
          <section className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
            <h3 className="text-lg font-bold mb-3">Progress Overview</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
              <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">24h</div>
                <div className="text-2xl font-bold">{Number(day.sessions ?? 0)}</div>
                <div className="text-xs text-zinc-400">Sessions | Darts {Number(day.darts ?? 0)}</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">7d</div>
                <div className="text-2xl font-bold">{Number(week.sessions ?? 0)}</div>
                <div className="text-xs text-zinc-400">Sessions | Darts {Number(week.darts ?? 0)}</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">30d</div>
                <div className="text-2xl font-bold">{Number(month.sessions ?? 0)}</div>
                <div className="text-xs text-zinc-400">Sessions | Darts {Number(month.darts ?? 0)}</div>
              </div>
            </div>
            <div className="rounded-lg border border-white/10 bg-black/30 p-3">
              <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Last 60 days</div>
              {timelineByDay.length === 0 ? (
                <div className="text-sm text-zinc-500">No history yet.</div>
              ) : (
                <div className="space-y-1 max-h-56 overflow-auto pr-1">
                  {timelineByDay.map((row) => (
                    <div key={String(row.date)} className="grid grid-cols-[1fr_80px_80px] text-sm gap-2">
                      <span className="text-zinc-300">{String(row.date)}</span>
                      <span className="text-cyan-300 text-right">{Number(row.sessions ?? 0)} s</span>
                      <span className="text-zinc-400 text-right">{Number(row.darts ?? 0)} d</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
            <h3 className="text-lg font-bold mb-3">Program Analytics</h3>
            {!programReportId ? (
              <div className="text-sm text-zinc-500">Select a program and click Report.</div>
            ) : (
              <>
                <div className="text-xs text-zinc-400 mb-3">Program ID: {programReportId}</div>
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Total Darts</div>
                    <div className="text-2xl font-bold">{Number(overall.totalDarts ?? 0)}</div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Hit Rate</div>
                    <div className="text-2xl font-bold">{(Number(overall.hitRate ?? 0) * 100).toFixed(1)}%</div>
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                  <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Per Target</div>
                  {perTarget.length === 0 ? (
                    <div className="text-sm text-zinc-500">No completed-session data yet.</div>
                  ) : (
                    <div className="space-y-1 max-h-64 overflow-auto pr-1">
                      {perTarget.map((row) => (
                        <div
                          key={String(row.target)}
                          className="grid grid-cols-[80px_1fr_1fr_1fr] gap-2 text-sm"
                        >
                          <span className="text-zinc-200">{String(row.target)}</span>
                          <span className="text-zinc-400">D:{Number(row.darts ?? 0)}</span>
                          <span className="text-cyan-300">H:{(Number(row.hitRate ?? 0) * 100).toFixed(1)}%</span>
                          <span className="text-emerald-300">A:{Number(row.avgScorePerDart ?? 0).toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        </div>

        {error && <div className="max-w-7xl mx-auto mt-4 text-sm text-red-300">{error}</div>}
        {message && <div className="max-w-7xl mx-auto mt-2 text-sm text-emerald-300">{message}</div>}
      </main>
    </div>
  );
}
