import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  FlaskConical,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  XCircle,
} from "lucide-react";
import BackendTopNav from "../../components/BackendTopNav";
import { API_BASE_URL } from "../../services/api";

interface CallerSettings {
  enabled: boolean;
  voice_pack_path: string;
  queue_delay_ms: number;
  call_dart_score: boolean;
  call_turn_change: boolean;
  call_game_events: boolean;
  call_corrections: boolean;
  call_required_score: boolean;
  call_leg_win: boolean;
  call_set_win: boolean;
  call_match_win: boolean;
  score_call_mode: "per_dart" | "turn_total";
  browser_playback_enabled: boolean;
  local_playback_enabled: boolean;
}

interface SoundFxSettings {
  enabled: boolean;
  volume: number;
  custom_sounds: Record<string, string>;
  play_triple: boolean;
  play_double: boolean;
  play_bull: boolean;
  play_miss: boolean;
  play_bust: boolean;
  play_checkout: boolean;
  play_cricket_valid: boolean;
  play_cricket_invalid: boolean;
}

type GifMatchType = "exact_score" | "min_score" | "any_checkout" | "exact_checkout" | "min_checkout";

interface GifReactionRule {
  id: string;
  label: string;
  match_type: GifMatchType;
  score: number | null;
  gifs: string[];
}

interface GifReactionSettings {
  enabled: boolean;
  duration_ms: number;
  score_rules: GifReactionRule[];
  checkout_rules: GifReactionRule[];
  set_won_gifs: string[];
  match_won_gifs: string[];
}

type CallerToggleKey =
  | "call_dart_score"
  | "call_turn_change"
  | "call_game_events"
  | "call_corrections"
  | "call_required_score"
  | "call_leg_win"
  | "call_set_win"
  | "call_match_win";

type SoundFxToggleKey =
  | "play_triple"
  | "play_double"
  | "play_bull"
  | "play_miss"
  | "play_bust"
  | "play_checkout"
  | "play_cricket_valid"
  | "play_cricket_invalid";

type SoundFxKey =
  | "triple"
  | "double"
  | "bull"
  | "miss"
  | "bust"
  | "checkout"
  | "cricket_valid"
  | "cricket_invalid";

const DEFAULT_CALLER_SETTINGS: CallerSettings = {
  enabled: true,
  voice_pack_path: "",
  queue_delay_ms: 150,
  call_dart_score: true,
  call_turn_change: true,
  call_game_events: true,
  call_corrections: true,
  call_required_score: true,
  call_leg_win: true,
  call_set_win: true,
  call_match_win: true,
  score_call_mode: "turn_total",
  browser_playback_enabled: true,
  local_playback_enabled: true,
};

const DEFAULT_SOUND_FX_SETTINGS: SoundFxSettings = {
  enabled: true,
  volume: 0.75,
  custom_sounds: {},
  play_triple: true,
  play_double: true,
  play_bull: true,
  play_miss: true,
  play_bust: true,
  play_checkout: true,
  play_cricket_valid: true,
  play_cricket_invalid: true,
};

const DEFAULT_GIF_REACTION_SETTINGS: GifReactionSettings = {
  enabled: true,
  duration_ms: 1800,
  score_rules: [
    { id: "score-180", label: "180", match_type: "exact_score", score: 180, gifs: [] },
    { id: "score-140-plus", label: "140+", match_type: "min_score", score: 140, gifs: [] },
    { id: "score-ton-plus", label: "100+", match_type: "min_score", score: 100, gifs: [] },
  ],
  checkout_rules: [
    { id: "checkout-any", label: "Any checkout", match_type: "any_checkout", score: null, gifs: [] },
    { id: "checkout-100-plus", label: "100+ checkout", match_type: "min_checkout", score: 100, gifs: [] },
    { id: "checkout-150-plus", label: "150+ checkout", match_type: "min_checkout", score: 150, gifs: [] },
    { id: "checkout-170", label: "170 checkout", match_type: "exact_checkout", score: 170, gifs: [] },
  ],
  set_won_gifs: [],
  match_won_gifs: [],
};

const API_BASE = API_BASE_URL;
const sectionClasses = "rounded-xl border border-white/10 bg-white/5 p-5";

const stateButtonClasses = (active: boolean) =>
  [
    "inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors",
    active
      ? "border-cyan-400/50 bg-cyan-500/20 text-cyan-100"
      : "border-white/10 bg-black/30 text-zinc-400 hover:border-white/25 hover:text-white",
  ].join(" ");

const ruleButtonClasses = (active: boolean) =>
  [
    "flex min-h-[72px] w-full flex-col items-start justify-center rounded-lg border px-4 py-3 text-left transition-colors",
    active
      ? "border-emerald-400/45 bg-emerald-500/15 text-emerald-100"
      : "border-white/10 bg-black/30 text-zinc-400 hover:border-white/25 hover:text-white",
  ].join(" ");

const ruleCardClasses = (active: boolean) =>
  [
    "flex min-h-[138px] w-full flex-col justify-between rounded-lg border px-4 py-3 text-left transition-colors",
    active ? "border-emerald-400/45 bg-emerald-500/15" : "border-white/10 bg-black/30",
  ].join(" ");

const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || "");
      resolve(raw.includes(",") ? raw.split(",").pop() || "" : raw);
    };
    reader.onerror = () => reject(reader.error || new Error("Unable to read audio file."));
    reader.readAsDataURL(file);
  });

const filenameFromPath = (path: string | undefined) => {
  const raw = String(path || "");
  if (!raw) return "";
  const normalized = raw.replace(/\//g, "\\");
  return normalized.split("\\").filter(Boolean).pop() || raw;
};

export default function SoundSettingsPage() {
  const [caller, setCaller] = useState<CallerSettings>(DEFAULT_CALLER_SETTINGS);
  const [soundFx, setSoundFx] = useState<SoundFxSettings>(DEFAULT_SOUND_FX_SETTINGS);
  const [gifReactions, setGifReactions] = useState<GifReactionSettings>(DEFAULT_GIF_REACTION_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectionInfo, setSelectionInfo] = useState<string | null>(null);
  const [defaultVoicePackPath, setDefaultVoicePackPath] = useState<string>("");
  const directoryInputRef = useRef<HTMLInputElement | null>(null);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [callerResponse, soundFxResponse, gifResponse] = await Promise.all([
        fetch(`${API_BASE}/api/caller/settings`),
        fetch(`${API_BASE}/api/sound-fx/settings`),
        fetch(`${API_BASE}/api/gif-reactions/settings`),
      ]);
      if (!callerResponse.ok) {
        throw new Error(`Failed to load caller settings (${callerResponse.status})`);
      }
      if (!soundFxResponse.ok) {
        throw new Error(`Failed to load sound FX settings (${soundFxResponse.status})`);
      }
      if (!gifResponse.ok) {
        throw new Error(`Failed to load GIF reaction settings (${gifResponse.status})`);
      }
      const callerPayload = await callerResponse.json();
      const soundFxPayload = await soundFxResponse.json();
      const gifPayload = await gifResponse.json();
      setCaller({ ...DEFAULT_CALLER_SETTINGS, ...(callerPayload?.settings ?? {}) });
      setSoundFx({ ...DEFAULT_SOUND_FX_SETTINGS, ...(soundFxPayload?.settings ?? {}) });
      setGifReactions({ ...DEFAULT_GIF_REACTION_SETTINGS, ...(gifPayload?.settings ?? {}) });
      setDefaultVoicePackPath(callerPayload?.defaultVoicePackPath ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load sound settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const input = directoryInputRef.current;
    if (input) {
      input.setAttribute("webkitdirectory", "");
      input.setAttribute("directory", "");
      input.setAttribute("multiple", "");
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const updateCaller = (field: keyof CallerSettings, value: string | number | boolean) => {
    setCaller((prev) => ({ ...prev, [field]: value }));
    if (field === "voice_pack_path") {
      setSelectionInfo(null);
    }
  };

  const updateSoundFx = (field: keyof SoundFxSettings, value: string | number | boolean) => {
    setSoundFx((prev) => ({ ...prev, [field]: value }));
  };

  const updateGifReactions = (field: keyof GifReactionSettings, value: number | boolean | GifReactionRule[] | string[]) => {
    setGifReactions((prev) => ({ ...prev, [field]: value }));
  };

  const saveSettings = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const [callerResponse, soundFxResponse, gifResponse] = await Promise.all([
        fetch(`${API_BASE}/api/caller/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(caller),
        }),
        fetch(`${API_BASE}/api/sound-fx/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(soundFx),
        }),
        fetch(`${API_BASE}/api/gif-reactions/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(gifReactions),
        }),
      ]);
      if (!callerResponse.ok) {
        const payload = await callerResponse.json().catch(() => ({}));
        throw new Error(payload?.detail || `Failed to save caller settings (${callerResponse.status})`);
      }
      if (!soundFxResponse.ok) {
        const payload = await soundFxResponse.json().catch(() => ({}));
        throw new Error(payload?.detail || `Failed to save sound FX settings (${soundFxResponse.status})`);
      }
      if (!gifResponse.ok) {
        const payload = await gifResponse.json().catch(() => ({}));
        throw new Error(payload?.detail || `Failed to save GIF reaction settings (${gifResponse.status})`);
      }
      const callerPayload = await callerResponse.json();
      const soundFxPayload = await soundFxResponse.json();
      const gifPayload = await gifResponse.json();
      setCaller((prev) => ({ ...prev, ...(callerPayload?.settings ?? {}) }));
      setSoundFx((prev) => ({ ...prev, ...(soundFxPayload?.settings ?? {}) }));
      setGifReactions((prev) => ({ ...prev, ...(gifPayload?.settings ?? {}) }));
      setDefaultVoicePackPath(callerPayload?.defaultVoicePackPath ?? "");
      setMessage("Sound settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save sound settings.");
    } finally {
      setSaving(false);
    }
  }, [caller, soundFx, gifReactions]);

  const triggerTestClip = useCallback(async () => {
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/caller/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        throw new Error(`Failed to trigger test clip (${response.status})`);
      }
      setMessage("Test clip triggered.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to play test clip.");
    }
  }, []);

  const resetSoundFx = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/sound-fx/reset`, { method: "POST" });
      if (!response.ok) {
        throw new Error(`Failed to reset sound FX (${response.status})`);
      }
      const payload = await response.json();
      setSoundFx({ ...DEFAULT_SOUND_FX_SETTINGS, ...(payload?.settings ?? {}) });
      setMessage("Sound FX rules reset.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reset sound FX rules.");
    } finally {
      setSaving(false);
    }
  }, []);

  const uploadSoundFx = useCallback(async (soundKey: SoundFxKey, file: File) => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const contentBase64 = await fileToBase64(file);
      const response = await fetch(`${API_BASE}/api/sound-fx/sounds/${soundKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, content_base64: contentBase64 }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.detail || `Failed to upload sound (${response.status})`);
      }
      const payload = await response.json();
      setSoundFx({ ...DEFAULT_SOUND_FX_SETTINGS, ...(payload?.settings ?? {}) });
      setMessage(`${file.name} added.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to upload sound.");
    } finally {
      setSaving(false);
    }
  }, []);

  const uploadGifReaction = useCallback(async (targetType: "score" | "checkout" | "set_won" | "match_won", file: File, ruleId?: string) => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const contentBase64 = await fileToBase64(file);
      const response = await fetch(`${API_BASE}/api/gif-reactions/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_type: targetType, rule_id: ruleId ?? null, filename: file.name, content_base64: contentBase64 }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.detail || `Failed to upload GIF reaction (${response.status})`);
      }
      const payload = await response.json();
      setGifReactions({ ...DEFAULT_GIF_REACTION_SETTINGS, ...(payload?.settings ?? {}) });
      setMessage(`${file.name} added.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to upload GIF reaction.");
    } finally {
      setSaving(false);
    }
  }, []);

  const deleteGifReaction = useCallback(async (targetType: "score" | "checkout" | "set_won" | "match_won", filePath: string, ruleId?: string) => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/gif-reactions/files/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_type: targetType, rule_id: ruleId ?? null, file_path: filePath }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.detail || `Failed to remove GIF reaction (${response.status})`);
      }
      const payload = await response.json();
      setGifReactions({ ...DEFAULT_GIF_REACTION_SETTINGS, ...(payload?.settings ?? {}) });
      setMessage("GIF reaction removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove GIF reaction.");
    } finally {
      setSaving(false);
    }
  }, []);

  const addGifRule = (kind: "score" | "checkout") => {
    const id = `${kind}-${Date.now()}`;
    const nextRule: GifReactionRule =
      kind === "score"
        ? { id, label: "New score", match_type: "min_score", score: 100, gifs: [] }
        : { id, label: "New checkout", match_type: "min_checkout", score: 100, gifs: [] };
    if (kind === "score") {
      updateGifReactions("score_rules", [...gifReactions.score_rules, nextRule]);
    } else {
      updateGifReactions("checkout_rules", [...gifReactions.checkout_rules, nextRule]);
    }
  };

  const updateGifRule = (kind: "score" | "checkout", ruleId: string, patch: Partial<GifReactionRule>) => {
    const key = kind === "score" ? "score_rules" : "checkout_rules";
    updateGifReactions(
      key,
      gifReactions[key].map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)),
    );
  };

  const removeGifRule = (kind: "score" | "checkout", ruleId: string) => {
    const key = kind === "score" ? "score_rules" : "checkout_rules";
    updateGifReactions(
      key,
      gifReactions[key].filter((rule) => rule.id !== ruleId),
    );
  };

  const clearSoundFx = useCallback(async (soundKey: SoundFxKey) => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/sound-fx/sounds/${soundKey}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.detail || `Failed to remove sound (${response.status})`);
      }
      const payload = await response.json();
      setSoundFx({ ...DEFAULT_SOUND_FX_SETTINGS, ...(payload?.settings ?? {}) });
      setMessage("Custom sound removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove custom sound.");
    } finally {
      setSaving(false);
    }
  }, []);

  const handleUseDefaultPack = useCallback(async () => {
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/caller/reset-voice-pack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Failed to reset voice pack (${response.status})`);
      }
      const data = await response.json();
      setCaller((prev) => ({ ...prev, ...(data?.settings ?? {}) }));
      setDefaultVoicePackPath(data?.defaultVoicePackPath ?? "");
      setSelectionInfo(data?.settings?.voice_pack_path ? `Using installed pack: ${data.settings.voice_pack_path}` : null);
      setMessage("Voice pack path reset.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reset voice pack path.");
    }
  }, []);

  const handleDirectorySelected = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const { files } = event.target;
      if (!files || files.length === 0) return;

      const firstFile = files[0] as File & { path?: string; webkitRelativePath?: string };
      const candidatePath = firstFile.path || firstFile.webkitRelativePath;
      if (!candidatePath) {
        setSelectionInfo("Unable to detect folder path. Please enter it manually.");
        event.target.value = "";
        return;
      }

      let folderPath: string | null = null;
      if (firstFile.path) {
        const normalized = firstFile.path.replace(/\//g, "\\");
        const lastSep = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
        folderPath = lastSep > 0 ? normalized.slice(0, lastSep) : normalized;
      } else if (firstFile.webkitRelativePath) {
        const slashIndex = firstFile.webkitRelativePath.indexOf("/");
        folderPath = slashIndex > 0 ? firstFile.webkitRelativePath.slice(0, slashIndex) : null;
      }

      if (!folderPath) {
        setSelectionInfo("Unable to detect folder path. Please enter it manually.");
        event.target.value = "";
        return;
      }

      let sanitized = folderPath.replace(/\//g, "\\");
      const hasDrive = /^[A-Za-z]:\\/.test(sanitized) || sanitized.startsWith("\\\\");
      if (!hasDrive && caller.voice_pack_path) {
        const idx = caller.voice_pack_path.lastIndexOf("\\");
        if (idx >= 0) {
          sanitized = `${caller.voice_pack_path.slice(0, idx + 1)}${sanitized.replace(/^\\+/, "")}`;
        }
      }
      setSelectionInfo(hasDrive ? `Selected folder: ${sanitized}` : "Browser gave a relative path. Adjust manually if needed.");
      updateCaller("voice_pack_path", sanitized);
      event.target.value = "";
    },
    [caller.voice_pack_path],
  );

  const callerToggles = useMemo<{ key: CallerToggleKey; label: string }[]>(
    () => [
      { key: "call_dart_score", label: "Score" },
      { key: "call_required_score", label: "Required" },
      { key: "call_turn_change", label: "Turn" },
      { key: "call_game_events", label: "Game" },
      { key: "call_corrections", label: "Correction" },
      { key: "call_leg_win", label: "Leg" },
      { key: "call_set_win", label: "Set" },
      { key: "call_match_win", label: "Match" },
    ],
    [],
  );

  const soundFxRules = useMemo<{ key: SoundFxToggleKey; soundKey: SoundFxKey; label: string; value: string }[]>(
    () => [
      { key: "play_triple", soundKey: "triple", label: "Triple", value: "T20, T19, T18" },
      { key: "play_double", soundKey: "double", label: "Double", value: "D20, D16, D8" },
      { key: "play_bull", soundKey: "bull", label: "Bull", value: "25 and 50" },
      { key: "play_miss", soundKey: "miss", label: "Miss", value: "No score" },
      { key: "play_bust", soundKey: "bust", label: "Bust", value: "X01 bust" },
      { key: "play_checkout", soundKey: "checkout", label: "Checkout", value: "Leg-winning dart" },
      { key: "play_cricket_valid", soundKey: "cricket_valid", label: "Cricket hit", value: "Open number" },
      { key: "play_cricket_invalid", soundKey: "cricket_invalid", label: "Cricket miss", value: "Closed number" },
    ],
    [],
  );

  const renderGifFiles = (
    targetType: "score" | "checkout" | "set_won" | "match_won",
    files: string[],
    ruleId?: string,
  ) => (
    <div className="mt-3 space-y-2">
      {files.length === 0 ? (
        <div className="rounded-md border border-white/10 bg-black/20 px-3 py-2 text-xs text-zinc-500">No GIFs uploaded</div>
      ) : (
        files.map((filePath) => (
          <div key={filePath} className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-white/10 bg-black/25 px-3 py-2">
            <span className="min-w-0 truncate text-xs text-zinc-300">{filenameFromPath(filePath)}</span>
            <button
              type="button"
              onClick={() => void deleteGifReaction(targetType, filePath, ruleId)}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-red-400/30 bg-red-500/10 px-2 py-1 text-xs font-semibold text-red-100 hover:bg-red-500/20"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove
            </button>
          </div>
        ))
      )}
    </div>
  );

  const renderGifUpload = (targetType: "score" | "checkout" | "set_won" | "match_won", ruleId?: string) => (
    <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-cyan-400/35 bg-cyan-500/15 px-3 py-2 text-sm font-semibold text-cyan-100 transition-colors hover:bg-cyan-500/25">
      <Upload className="h-4 w-4" />
      Add GIF
      <input
        type="file"
        accept=".gif,.webp,.png,.jpg,.jpeg,.mp4,.webm,image/*,video/mp4,video/webm"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void uploadGifReaction(targetType, file, ruleId);
        }}
      />
    </label>
  );

  const renderGifRules = (kind: "score" | "checkout", rules: GifReactionRule[]) => (
    <div className="grid gap-3">
      {rules.map((rule) => (
        <div key={rule.id} className="rounded-lg border border-white/10 bg-black/25 p-4">
          <div className="grid gap-3 md:grid-cols-[1fr_160px_120px_auto]">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Name</span>
              <input
                value={rule.label}
                onChange={(event) => updateGifRule(kind, rule.id, { label: event.target.value })}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/50"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Match</span>
              <select
                value={rule.match_type}
                onChange={(event) =>
                  updateGifRule(kind, rule.id, {
                    match_type: event.target.value as GifMatchType,
                    score: event.target.value === "any_checkout" ? null : rule.score ?? 100,
                  })
                }
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/50"
              >
                {kind === "score" ? (
                  <>
                    <option value="exact_score">Exact score</option>
                    <option value="min_score">Score at least</option>
                  </>
                ) : (
                  <>
                    <option value="any_checkout">Any checkout</option>
                    <option value="exact_checkout">Exact checkout</option>
                    <option value="min_checkout">Checkout at least</option>
                  </>
                )}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Score</span>
              <input
                type="number"
                min={0}
                max={180}
                disabled={rule.match_type === "any_checkout"}
                value={rule.score ?? 0}
                onChange={(event) => updateGifRule(kind, rule.id, { score: Number(event.target.value) })}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/50 disabled:opacity-40"
              />
            </label>
            <div className="flex items-end gap-2">
              {renderGifUpload(kind, rule.id)}
              <button
                type="button"
                onClick={() => removeGifRule(kind, rule.id)}
                className="inline-flex items-center gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm font-semibold text-red-100 hover:bg-red-500/20"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
          {renderGifFiles(kind, rule.gifs, rule.id)}
        </div>
      ))}
    </div>
  );

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-black text-white">
      <div
        className="pointer-events-none fixed inset-0 [background:
        radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
        linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
      ]"
      />
      <BackendTopNav />

      <main className="relative z-10 mx-auto w-full max-w-5xl px-6 pb-10 md:px-10">
        <section className={sectionClasses}>
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Volume2 className="h-5 w-5 text-cyan-400" />
                <h1 className="text-2xl font-bold">Sound</h1>
              </div>
              <p className="max-w-2xl text-sm text-zinc-400">
                Sound FX, caller clips, and announcement timing for the local board.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={saveSettings}
                disabled={saving || loading}
                className="inline-flex items-center gap-2 rounded-lg border border-cyan-400/40 bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-cyan-100 transition-colors hover:bg-cyan-500/30 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save
              </button>
              <button
                type="button"
                onClick={fetchSettings}
                disabled={loading}
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-4 py-2 text-sm font-semibold text-zinc-300 transition-colors hover:border-white/25 hover:text-white disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Reload
              </button>
            </div>
          </div>
        </section>

        <div className="mt-6 grid gap-6">
          <section className={sectionClasses}>
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-emerald-300" />
                  <h2 className="text-xl font-semibold">Sound FX</h2>
                </div>
                <p className="mt-2 text-sm text-zinc-400">Event sounds for hits, misses, cricket, busts, and checkouts.</p>
              </div>
              <button type="button" onClick={() => updateSoundFx("enabled", !soundFx.enabled)} className={stateButtonClasses(soundFx.enabled)}>
                {soundFx.enabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                {soundFx.enabled ? "Enabled" : "Disabled"}
              </button>
            </div>

            <div className="mt-6 max-w-sm">
              <label className="block">
                <span className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-[0.26em] text-zinc-500">
                  Volume <span className="tracking-normal text-zinc-300">{Math.round(soundFx.volume * 100)}%</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={soundFx.volume}
                  onChange={(event) => updateSoundFx("volume", Number(event.target.value))}
                  className="w-full accent-cyan-400"
                />
              </label>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {soundFxRules.map((rule) => {
                const customSound = soundFx.custom_sounds?.[rule.soundKey];
                return (
                  <div key={rule.key} className={ruleCardClasses(soundFx[rule.key])}>
                    <button
                      type="button"
                      onClick={() => updateSoundFx(rule.key, !soundFx[rule.key])}
                      className="flex w-full flex-col items-start text-left"
                    >
                      <span className={soundFx[rule.key] ? "text-sm font-semibold text-emerald-100" : "text-sm font-semibold text-zinc-400"}>
                        {rule.label}
                      </span>
                      <span className="mt-1 text-xs text-zinc-400">{rule.value}</span>
                    </button>
                    <div className="mt-3 min-w-0">
                      <div className="truncate text-xs text-zinc-500">{customSound ? filenameFromPath(customSound) : "Default sound"}</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs font-semibold text-zinc-300 transition-colors hover:border-white/25 hover:text-white">
                          <Upload className="h-3.5 w-3.5" />
                          Upload
                          <input
                            type="file"
                            accept="audio/*,.mp3,.wav,.ogg,.m4a"
                            className="hidden"
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              event.target.value = "";
                              if (file) void uploadSoundFx(rule.soundKey, file);
                            }}
                          />
                        </label>
                        {customSound && (
                          <button
                            type="button"
                            onClick={() => void clearSoundFx(rule.soundKey)}
                            className="inline-flex items-center gap-1.5 rounded-md border border-red-400/30 bg-red-500/10 px-2 py-1.5 text-xs font-semibold text-red-100 transition-colors hover:bg-red-500/20"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Default
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={resetSoundFx}
                disabled={saving || loading}
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm font-semibold text-zinc-300 transition-colors hover:border-white/25 hover:text-white disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4" />
                Reset FX
              </button>
            </div>
          </section>

          <section className={sectionClasses}>
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 className="text-xl font-semibold">GIF Reactions</h2>
                <p className="mt-2 text-sm text-zinc-400">Random visual reactions for big scores, checkouts, sets, and matches.</p>
              </div>
              <button
                type="button"
                onClick={() => updateGifReactions("enabled", !gifReactions.enabled)}
                className={stateButtonClasses(gifReactions.enabled)}
              >
                {gifReactions.enabled ? "Enabled" : "Disabled"}
              </button>
            </div>

            <div className="mt-6 max-w-sm">
              <label className="block">
                <span className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-[0.26em] text-zinc-500">
                  Duration <span className="tracking-normal text-zinc-300">{gifReactions.duration_ms} ms</span>
                </span>
                <input
                  type="range"
                  min={500}
                  max={10000}
                  step={100}
                  value={gifReactions.duration_ms}
                  onChange={(event) => updateGifReactions("duration_ms", Number(event.target.value))}
                  className="w-full accent-cyan-400"
                />
              </label>
            </div>

            <div className="mt-6 grid gap-6">
              <div>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.24em] text-zinc-400">Scores</h3>
                  <button
                    type="button"
                    onClick={() => addGifRule("score")}
                    className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm font-semibold text-zinc-300 hover:border-white/25 hover:text-white"
                  >
                    Add Rule
                  </button>
                </div>
                {renderGifRules("score", gifReactions.score_rules)}
              </div>

              <div>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.24em] text-zinc-400">Checkout / Leg Won</h3>
                  <button
                    type="button"
                    onClick={() => addGifRule("checkout")}
                    className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm font-semibold text-zinc-300 hover:border-white/25 hover:text-white"
                  >
                    Add Rule
                  </button>
                </div>
                {renderGifRules("checkout", gifReactions.checkout_rules)}
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-lg border border-white/10 bg-black/25 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">Set Won</h3>
                      <p className="mt-1 text-xs text-zinc-400">Overrides checkout reactions when a set ends.</p>
                    </div>
                    {renderGifUpload("set_won")}
                  </div>
                  {renderGifFiles("set_won", gifReactions.set_won_gifs)}
                </div>
                <div className="rounded-lg border border-white/10 bg-black/25 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">Match Won</h3>
                      <p className="mt-1 text-xs text-zinc-400">Highest priority reaction for the final dart.</p>
                    </div>
                    {renderGifUpload("match_won")}
                  </div>
                  {renderGifFiles("match_won", gifReactions.match_won_gifs)}
                </div>
              </div>
            </div>
          </section>

          <section className={sectionClasses}>
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 className="text-xl font-semibold">Voice Caller</h2>
                <p className="mt-2 text-sm text-zinc-400">Spoken score and game announcements from the installed voice pack.</p>
              </div>
              <button type="button" onClick={() => updateCaller("enabled", !caller.enabled)} className={stateButtonClasses(caller.enabled)}>
                {caller.enabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                {caller.enabled ? "Enabled" : "Disabled"}
              </button>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
              {callerToggles.map((toggle) => (
                <button
                  type="button"
                  key={toggle.key}
                  onClick={() => updateCaller(toggle.key, !caller[toggle.key])}
                  className={stateButtonClasses(caller[toggle.key])}
                >
                  {toggle.label}
                </button>
              ))}
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <button
                type="button"
                onClick={() => updateCaller("score_call_mode", "per_dart")}
                className={ruleButtonClasses(caller.score_call_mode === "per_dart")}
              >
                <span className="text-sm font-semibold">Per Dart</span>
                <span className="mt-1 text-xs text-zinc-400">Caller speaks each detected dart.</span>
              </button>
              <button
                type="button"
                onClick={() => updateCaller("score_call_mode", "turn_total")}
                className={ruleButtonClasses(caller.score_call_mode === "turn_total")}
              >
                <span className="text-sm font-semibold">Turn Total</span>
                <span className="mt-1 text-xs text-zinc-400">Caller speaks after the visit is complete.</span>
              </button>
            </div>
          </section>

          <section className={sectionClasses}>
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 className="text-xl font-semibold">Voice Pack</h2>
                <p className="mt-2 text-sm text-zinc-400">Folder and queue timing for spoken caller clips.</p>
              </div>
              <button
                type="button"
                onClick={triggerTestClip}
                disabled={loading || saving || !caller.enabled}
                className="inline-flex items-center gap-2 rounded-lg border border-blue-400/40 bg-blue-500/15 px-3 py-2 text-sm font-semibold text-blue-100 transition-colors hover:bg-blue-500/25 disabled:opacity-50"
              >
                <FlaskConical className="h-4 w-4" />
                Test
              </button>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-[1fr_160px]">
              <label className="block">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.26em] text-zinc-500">Path</span>
                <input
                  type="text"
                  value={caller.voice_pack_path}
                  onChange={(event) => updateCaller("voice_pack_path", event.target.value)}
                  placeholder={defaultVoicePackPath || "C:\\voice_packs\\sound_english"}
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/50"
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.26em] text-zinc-500">Delay MS</span>
                <input
                  type="number"
                  min={0}
                  max={5000}
                  value={caller.queue_delay_ms}
                  onChange={(event) => updateCaller("queue_delay_ms", Number(event.target.value))}
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/50"
                />
              </label>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => directoryInputRef.current?.click()}
                className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm font-semibold text-zinc-300 transition-colors hover:border-white/25 hover:text-white"
              >
                Select Folder
              </button>
              <button
                type="button"
                onClick={handleUseDefaultPack}
                disabled={saving || loading}
                className="rounded-lg border border-emerald-400/35 bg-emerald-500/15 px-3 py-2 text-sm font-semibold text-emerald-100 transition-colors hover:bg-emerald-500/25 disabled:opacity-50"
              >
                Installed Pack
              </button>
              {selectionInfo && <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">{selectionInfo}</span>}
              <input type="file" ref={directoryInputRef} onChange={handleDirectorySelected} className="hidden" />
            </div>
          </section>

          {(message || error) && (
            <div
              className={[
                "flex items-center gap-3 rounded-xl border px-4 py-3 text-sm",
                message ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-red-500/40 bg-red-500/10 text-red-200",
              ].join(" ")}
            >
              {message ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              <span>{message ?? error}</span>
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center gap-3 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading sound settings...
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
