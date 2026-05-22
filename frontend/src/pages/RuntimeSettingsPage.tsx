import React from "react";
import { Settings2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import BackendTopNav from "../components/BackendTopNav";
import {
  getBotSpeed,
  getDetectionSettings,
  getModelSettings,
  pickReplayFolder,
  updateBotSpeed,
  updateDetectionSettings,
  updateModelSettings,
} from "../services/api";

type OpenVinoDeviceDetail = {
  id: string;
  label?: string;
  full_name?: string;
  device_type?: string | null;
  kind?: string | null;
  is_integrated?: boolean | null;
  is_discrete?: boolean | null;
};

type RuntimePayload = {
  settings?: {
    openvino?: {
      device?: string;
      performance_hint?: string;
    };
  };
  available_openvino_device_details?: OpenVinoDeviceDetail[];
  available_openvino_devices?: string[];
  runtime?: {
    selected_device?: string;
    effective_device?: string | null;
    selected_performance_hint?: string;
    effective_performance_hint?: string | null;
  };
};

const FALLBACK_DEVICE_DETAILS: OpenVinoDeviceDetail[] = [
  { id: "AUTO", label: "AUTO - Let OpenVINO choose", kind: "auto" },
  { id: "CPU", label: "CPU", kind: "cpu" },
];

function normalizeDeviceDetails(
  details?: OpenVinoDeviceDetail[],
  deviceIds?: string[],
): OpenVinoDeviceDetail[] {
  const out: OpenVinoDeviceDetail[] = [];
  const seen = new Set<string>();
  const add = (detail: OpenVinoDeviceDetail) => {
    const id = String(detail.id || "").trim().toUpperCase();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({
      ...detail,
      id,
      label: String(detail.label || id),
    });
  };

  for (const detail of details ?? []) {
    add(detail);
  }
  for (const deviceId of deviceIds ?? []) {
    add({ id: String(deviceId || "").trim().toUpperCase(), label: String(deviceId || "").trim().toUpperCase() });
  }
  if (out.length === 0) {
    for (const detail of FALLBACK_DEVICE_DETAILS) {
      add(detail);
    }
  }
  return out;
}

export default function RuntimeSettingsPage() {
  const [selectedDevice, setSelectedDevice] = React.useState("AUTO");
  const [availableDeviceDetails, setAvailableDeviceDetails] = React.useState<OpenVinoDeviceDetail[]>(FALLBACK_DEVICE_DETAILS);
  const [effectiveDevice, setEffectiveDevice] = React.useState<string>("-");
  const [effectivePerformanceHint, setEffectivePerformanceHint] = React.useState<string>("-");
  const [botSpeed, setBotSpeed] = React.useState<"slow" | "normal" | "fast">("normal");
  const [replayEnabled, setReplayEnabled] = React.useState(true);
  const [replayShowInGame, setReplayShowInGame] = React.useState(true);
  const [replayTurnMinScore, setReplayTurnMinScore] = React.useState<number>(60);
  const [replayCheckoutMinScore, setReplayCheckoutMinScore] = React.useState<number>(100);
  const [replayAutosaveEnabled, setReplayAutosaveEnabled] = React.useState(false);
  const [replayAutosaveDir, setReplayAutosaveDir] = React.useState("");
  const [replayAutosaveSelectionInfo, setReplayAutosaveSelectionInfo] = React.useState<string>("");
  const [replayPickerBusy, setReplayPickerBusy] = React.useState(false);
  const [playerReplayEnabled, setPlayerReplayEnabled] = React.useState(false);
  const [playerReplayStatus, setPlayerReplayStatus] = React.useState<string>("");
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState("");

  const applyPayload = React.useCallback((data: RuntimePayload) => {
    const details = normalizeDeviceDetails(data.available_openvino_device_details, data.available_openvino_devices);
    setSelectedDevice(String(data.settings?.openvino?.device ?? "AUTO"));
    setAvailableDeviceDetails(details);
    setEffectiveDevice(String(data.runtime?.effective_device ?? data.runtime?.selected_device ?? "-"));
    setEffectivePerformanceHint(
      String(data.runtime?.effective_performance_hint ?? data.runtime?.selected_performance_hint ?? "-"),
    );
  }, []);

  const load = React.useCallback(async () => {
    const [data, detection, bot] = await Promise.all([
      getModelSettings(),
      getDetectionSettings().catch(() => ({ settings: {} })),
      getBotSpeed().catch(() => ({ speed: "normal" })),
    ]);
    applyPayload(data);
    setReplayEnabled(Boolean((detection as any)?.settings?.replay_enabled ?? true));
    setReplayShowInGame(Boolean((detection as any)?.settings?.replay_show_in_game ?? true));
    setReplayTurnMinScore(Number((detection as any)?.settings?.replay_turn_min_score ?? 60) || 60);
    setReplayCheckoutMinScore(Number((detection as any)?.settings?.replay_checkout_min_score ?? 100) || 100);
    setReplayAutosaveEnabled(Boolean((detection as any)?.settings?.replay_autosave_enabled ?? false));
    setReplayAutosaveDir(String((detection as any)?.settings?.replay_autosave_dir ?? ""));
    setPlayerReplayEnabled(Boolean((detection as any)?.settings?.player_replay_enabled ?? false));
    const playerReplay = (detection as any)?.player_replay;
    if (playerReplay) {
      const activeCamera = Number(playerReplay?.active_camera_index);
      const configuredCamera = Number(playerReplay?.camera_index);
      const bufferedFrames = Number(playerReplay?.buffered_frames ?? 0);
      const backend = String(playerReplay?.backend ?? "");
      const lastError = String(playerReplay?.last_error ?? "");
      if (Boolean(playerReplay?.enabled) && Number.isFinite(activeCamera) && activeCamera >= 0) {
        setPlayerReplayStatus(`Live on Player Cam device ${activeCamera} via ${backend || "AUTO"}; buffered ${bufferedFrames} frame(s)`);
      } else if (Boolean(playerReplay?.enabled) && Number.isFinite(configuredCamera) && configuredCamera >= 0) {
        setPlayerReplayStatus(
          lastError
            ? `Player Cam device ${configuredCamera} waiting for frames (${lastError}).`
            : `Player Cam device ${configuredCamera} waiting for frames...`,
        );
      } else {
        setPlayerReplayStatus("Disabled");
      }
    } else {
      setPlayerReplayStatus("");
    }
    const rawSpeed = String((bot as any)?.speed ?? "normal").toLowerCase();
    if (rawSpeed === "slow" || rawSpeed === "normal" || rawSpeed === "fast") {
      setBotSpeed(rawSpeed);
    } else {
      setBotSpeed("normal");
    }
  }, [applyPayload]);

  React.useEffect(() => {
    load().catch((e) => setMessage(String(e)));
  }, [load]);

  const save = async () => {
    setSaving(true);
    setMessage("");
    try {
      const [data, detection] = await Promise.all([
        updateModelSettings({
          openvino: {
            device: selectedDevice,
            performance_hint: "LATENCY",
          },
        }),
        updateDetectionSettings({
          process_priority_mode: "normal",
          replay_enabled: replayEnabled,
          replay_show_in_game: replayShowInGame,
          replay_turn_min_score: replayTurnMinScore,
          replay_checkout_min_score: replayCheckoutMinScore,
          replay_autosave_enabled: replayAutosaveEnabled,
          replay_autosave_dir: replayAutosaveDir,
          player_replay_enabled: playerReplayEnabled,
        }),
        updateBotSpeed(botSpeed),
      ]);
      applyPayload(data);
      const playerReplay = (detection as any)?.player_replay;
      if (playerReplay) {
        const activeCamera = Number(playerReplay?.active_camera_index);
        const configuredCamera = Number(playerReplay?.camera_index);
        const bufferedFrames = Number(playerReplay?.buffered_frames ?? 0);
        const backend = String(playerReplay?.backend ?? "");
        const lastError = String(playerReplay?.last_error ?? "");
        if (Boolean(playerReplay?.enabled) && Number.isFinite(activeCamera) && activeCamera >= 0) {
          setPlayerReplayStatus(`Live on Player Cam device ${activeCamera} via ${backend || "AUTO"}; buffered ${bufferedFrames} frame(s)`);
        } else if (Boolean(playerReplay?.enabled) && Number.isFinite(configuredCamera) && configuredCamera >= 0) {
          setPlayerReplayStatus(
            lastError
              ? `Player Cam device ${configuredCamera} waiting for frames (${lastError}).`
              : `Player Cam device ${configuredCamera} waiting for frames...`,
          );
        } else {
          setPlayerReplayStatus("Disabled");
        }
      }
      setMessage("Runtime settings saved.");
    } catch (e) {
      setMessage(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleReplayDirectoryButton = React.useCallback(async () => {
    if (replayPickerBusy) return;
    setReplayPickerBusy(true);
    setReplayAutosaveSelectionInfo("");
    try {
      setReplayAutosaveSelectionInfo("Opening folder picker...");
      const picked = await invoke<string | null>("pick_replay_folder", {
        initial_path: replayAutosaveDir || null,
      });
      if (picked && picked.trim()) {
        setReplayAutosaveDir(picked);
        setReplayAutosaveSelectionInfo(`Selected folder: ${picked}`);
      } else {
        setReplayAutosaveSelectionInfo("No folder selected.");
      }
    } catch (err) {
      try {
        setReplayAutosaveSelectionInfo("Opening backend folder picker...");
        const fallback = await pickReplayFolder(replayAutosaveDir || "");
        const path = String(fallback?.path || "").trim();
        if (path) {
          setReplayAutosaveDir(path);
          setReplayAutosaveSelectionInfo(`Selected folder: ${path}`);
          return;
        }
        setReplayAutosaveSelectionInfo("No folder selected.");
      } catch (fallbackErr) {
        const detail = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        setReplayAutosaveSelectionInfo(
          `Folder picker failed. ${detail}. If this is an installed app, restart/reinstall so backend includes /api/settings/replay/pick-folder.`,
        );
      }
    } finally {
      setReplayPickerBusy(false);
    }
  }, [replayAutosaveDir, replayPickerBusy]);

  const describeDevice = (deviceId: string) =>
    availableDeviceDetails.find((detail) => detail.id === String(deviceId || "").trim().toUpperCase())?.label ?? deviceId;

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      <div
        className="pointer-events-none fixed inset-0 [background:
        radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
        linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
      ]"
      />
      <BackendTopNav />

      <main className="relative z-10 w-full max-w-5xl mx-auto px-6 md:px-10 pb-10">
        <section className="rounded-xl border border-white/10 bg-white/5 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Settings2 className="h-5 w-5 text-cyan-400" />
            <h1 className="text-2xl font-bold">Settings</h1>
          </div>

          <div className="space-y-5">
            <div>
              <label className="block text-sm mb-2">OpenVINO Inference Device</label>
              <select
                value={selectedDevice}
                onChange={(e) => setSelectedDevice(e.target.value)}
                className="w-full rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm"
              >
                {availableDeviceDetails.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.label ?? device.id}
                  </option>
                ))}
              </select>
              <div className="text-xs text-zinc-400 mt-2">
                `AUTO` is the safest default. If the machine has multiple accelerators, the dropdown now shows the real OpenVINO device ids and names so a dGPU can be picked directly.
              </div>
            </div>

            <div className="rounded-lg border border-white/10 bg-black/30 px-4 py-3">
              <div className="text-sm font-medium">Bot throw speed</div>
              <div className="text-xs text-zinc-400 mt-1 mb-3">
                Controls how quickly bots throw in all games.
              </div>
              <div className="flex flex-wrap gap-2">
                {[
                  { key: "slow", label: "Slow" },
                  { key: "normal", label: "Normal" },
                  { key: "fast", label: "Fast" },
                ].map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setBotSpeed(option.key as "slow" | "normal" | "fast")}
                    className={`px-4 py-2 text-xs font-semibold rounded-lg border transition ${
                      botSpeed === option.key
                        ? "border-emerald-400/70 bg-emerald-500/20 text-emerald-100"
                        : "border-white/10 bg-black/30 text-zinc-200 hover:border-white/30"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-white/10 bg-black/30 px-4 py-3">
              <div className="text-sm font-medium">Replay trigger thresholds (X01)</div>
              <div className="text-xs text-zinc-400 mt-1 mb-3">
                Configure when instant replay gets queued for a turn and for successful checkout turns.
              </div>
              <div className="mb-3">
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={replayEnabled}
                    onChange={(e) => setReplayEnabled(e.target.checked)}
                    className="mt-1"
                  />
                  <div>
                    <div className="text-sm font-medium">Replay enabled</div>
                    <div className="text-xs text-zinc-400 mt-1">
                      Disable this to stop replay popups and replay queueing during X01.
                    </div>
                  </div>
                </label>
              </div>
              <div className="mb-3">
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={replayShowInGame}
                    onChange={(e) => setReplayShowInGame(e.target.checked)}
                    className="mt-1"
                  />
                  <div>
                    <div className="text-sm font-medium">Show replay popup in-game</div>
                    <div className="text-xs text-zinc-400 mt-1">
                      If off, replay still queues/captures in the background and auto-save can still store MP4s.
                    </div>
                  </div>
                </label>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-300 mb-1">Turn total trigger</label>
                  <select
                    value={replayTurnMinScore}
                    onChange={(e) => setReplayTurnMinScore(Number(e.target.value) || 60)}
                    className="w-full rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm"
                  >
                    {[40, 60, 80, 100, 120, 140, 160, 180].map((v) => (
                      <option key={v} value={v}>
                        {v === 180 ? "180" : `${v}+`}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-300 mb-1">Checkout trigger</label>
                  <select
                    value={replayCheckoutMinScore}
                    onChange={(e) => setReplayCheckoutMinScore(Number(e.target.value) || 100)}
                    className="w-full rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm"
                  >
                    {[40, 60, 80, 100, 120, 140, 160, 170].map((v) => (
                      <option key={v} value={v}>
                        {v === 170 ? "170" : `${v}+`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-3">
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={playerReplayEnabled}
                    onChange={(e) => setPlayerReplayEnabled(e.target.checked)}
                    className="mt-1"
                  />
                  <div>
                    <div className="text-sm font-medium">Include Player Cam throw replay</div>
                    <div className="text-xs text-zinc-400 mt-1">
                      Adds the optional Player Cam view beside the board replay. Uses the Player Cam slot from Calibration.
                    </div>
                    {playerReplayStatus ? (
                      <div className="mt-1 text-xs text-zinc-500">{playerReplayStatus}</div>
                    ) : null}
                  </div>
                </label>
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={replayAutosaveEnabled}
                    onChange={(e) => setReplayAutosaveEnabled(e.target.checked)}
                    className="mt-1"
                  />
                  <div>
                    <div className="text-sm font-medium">Auto-save replay MP4</div>
                    <div className="text-xs text-zinc-400 mt-1">
                      When enabled, backend saves each ready replay automatically.
                    </div>
                  </div>
                </label>
                <div>
                  <label className="block text-xs text-zinc-300 mb-1">Auto-save folder path</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={replayAutosaveDir}
                      onChange={(e) => setReplayAutosaveDir(e.target.value)}
                      placeholder="Leave blank to use default backend replays folder"
                      className="w-full rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm"
                    />
                    <button
                      type="button"
                      onClick={handleReplayDirectoryButton}
                      disabled={replayPickerBusy}
                      className="rounded-lg border border-white/20 px-3 py-2 text-xs text-zinc-200 hover:bg-white/10"
                    >
                      {replayPickerBusy ? "Opening..." : "Browse..."}
                    </button>
                  </div>
                  {replayAutosaveSelectionInfo ? (
                    <div className="mt-2 text-xs text-zinc-400">{replayAutosaveSelectionInfo}</div>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-white/10 bg-black/30 px-4 py-3 text-sm">
              <div>
                Selected Device: <span className="text-zinc-300">{describeDevice(selectedDevice)}</span>
              </div>
              <div className="mt-1">
                Effective Device: <span className="text-zinc-300">{describeDevice(effectiveDevice)}</span>
              </div>
              <div className="mt-1">
                Performance Hint: <span className="text-zinc-300">{effectivePerformanceHint}</span>
              </div>
              <div className="mt-1">
                Available Devices: <span className="text-zinc-300">{availableDeviceDetails.map((device) => device.label ?? device.id).join(", ")}</span>
              </div>
            </div>

            <button
              onClick={save}
              disabled={saving}
              className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-60"
            >
              {saving ? "Saving..." : "Save Runtime Settings"}
            </button>

            {message && <div className="text-sm text-zinc-300">{message}</div>}
          </div>
        </section>
      </main>
    </div>
  );
}
