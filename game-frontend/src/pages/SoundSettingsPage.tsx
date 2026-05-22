import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, RefreshCw, Save, Volume2, VolumeX, CheckCircle2, XCircle, FlaskConical } from "lucide-react";

interface VoiceSettings {
  enabled: boolean;
  voicePackPath: string;
  callEveryDart: boolean;
  callTurnSummary: boolean;
  callRequiredScore: boolean;
  callLegWin: boolean;
  callSetWin: boolean;
  callMatchWin: boolean;
  queueDelayMs: number;
}

type VoiceToggleKey =
  | "callEveryDart"
  | "callTurnSummary"
  | "callRequiredScore"
  | "callLegWin"
  | "callSetWin"
  | "callMatchWin";

interface ToggleConfig {
  key: VoiceToggleKey;
  label: string;
  description: string;
}

const DEFAULT_SETTINGS: VoiceSettings = {
  enabled: false,
  voicePackPath: "",
  callEveryDart: false,
  callTurnSummary: true,
  callRequiredScore: true,
  callLegWin: true,
  callSetWin: true,
  callMatchWin: true,
  queueDelayMs: 150,
};

const API_BASE = "http://localhost:8000";

const toggleClasses = (active: boolean) =>
  [
    "flex",
    "items-center",
    "gap-2",
    "px-3",
    "py-2.5",
    "rounded-lg",
    "text-sm",
    "font-medium",
    "transition-colors",
    active ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40" : "bg-zinc-900/60 text-zinc-400 border border-white/10 hover:border-emerald-500/30",
  ].join(" ");

const sectionClasses = "bg-black/40 border border-white/10 rounded-2xl p-6";

const SoundSettingsPage: React.FC = () => {
  const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_SETTINGS);
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
      const response = await fetch(`${API_BASE}/api/sound/settings`);
      if (!response.ok) {
        throw new Error(`Failed to load settings (${response.status})`);
      }
      const data = await response.json();
      if (data?.settings) {
        setSettings({
          ...DEFAULT_SETTINGS,
          ...data.settings,
        });
      } else {
        setSettings(DEFAULT_SETTINGS);
      }
      setDefaultVoicePackPath(data?.defaultVoicePackPath ?? "");
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

  const handleInputChange = (field: keyof VoiceSettings, value: string | number | boolean) => {
    setSettings((prev) => ({
      ...prev,
      [field]: value,
    }));
    if (field === "voicePackPath") {
      setSelectionInfo(null);
    }
  };

  const saveSettings = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/sound/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.detail || `Failed to save settings (${response.status})`);
      }
      const data = await response.json();
      if (data?.settings) {
        setSettings((prev) => ({ ...prev, ...data.settings }));
      }
      if (data?.defaultVoicePackPath !== undefined) {
        setDefaultVoicePackPath(data.defaultVoicePackPath ?? "");
      }
      setMessage("Sound settings updated successfully.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save sound settings.");
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const triggerTestClip = useCallback(async () => {
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/sound/test`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Failed to trigger test clip (${response.status})`);
      }
      setMessage("Test clip triggered.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to play test clip.");
    }
  }, []);

  const handleDirectoryButton = useCallback(() => {
    setSelectionInfo(null);
    directoryInputRef.current?.click();
  }, []);

  const handleDirectorySelected = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const { files } = event.target;
      if (!files || files.length === 0) {
        return;
      }
      const firstFile = files[0] as File & { path?: string; webkitRelativePath?: string };
      const candidatePath = firstFile.path || firstFile.webkitRelativePath;
      if (candidatePath) {
        let folderPath: string | null = null;
        if (firstFile.path) {
          const normalized = firstFile.path.replace(/\//g, "\\");
          const lastSep = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
          folderPath = lastSep > 0 ? normalized.slice(0, lastSep) : normalized;
        } else if (firstFile.webkitRelativePath) {
          const relative = firstFile.webkitRelativePath;
          const slashIndex = relative.indexOf("/");
          if (slashIndex > 0) {
            folderPath = relative.slice(0, slashIndex);
          }
          setSelectionInfo("Browser provided only relative path. Adjust manually if needed.");
        }
        if (folderPath) {
          let sanitized = folderPath.replace(/\//g, "\\");
          const hasDrive = /^[A-Za-z]:\\/.test(sanitized) || sanitized.startsWith("\\\\");
          if (!hasDrive) {
            const previous = settings.voicePackPath;
            if (previous) {
              const idx = previous.lastIndexOf("\\");
              if (idx >= 0) {
                const base = previous.slice(0, idx + 1);
                sanitized = `${base}${sanitized.replace(/^\\+/, "")}`;
                setSelectionInfo(`Selected folder (relative to previous path): ${sanitized}`);
              } else {
                setSelectionInfo(
                  "Unable to determine full path from selection. Please adjust the path manually."
                );
              }
            } else {
              setSelectionInfo(
                "Only a relative folder name was provided. Please edit the path manually."
              );
            }
          } else {
            setSelectionInfo(`Selected folder: ${sanitized}`);
          }
          handleInputChange("voicePackPath", sanitized);
        } else {
          setSelectionInfo("Unable to detect folder path from selection. Please enter it manually.");
        }
      } else {
        setSelectionInfo("Unable to detect folder path from selection. Please enter it manually.");
      }
      event.target.value = "";
    },
    [handleInputChange, settings.voicePackPath]
  );

  const handleUseDefaultPack = useCallback(() => {
    if (!defaultVoicePackPath) {
      return;
    }
    handleInputChange("voicePackPath", defaultVoicePackPath);
    setSelectionInfo(`Using bundled sound pack: ${defaultVoicePackPath}`);
  }, [defaultVoicePackPath, handleInputChange]);

  const toggles = useMemo<ToggleConfig[]>(
    () => [
      { key: "callEveryDart", label: "Call every dart", description: "Announce each detected dart immediately." },
      { key: "callTurnSummary", label: "Turn summary", description: "Summarize the score after each player turn." },
      { key: "callRequiredScore", label: "Checkout prompts", description: "Call the required score for the next player." },
      { key: "callLegWin", label: "Leg wins", description: "Announce leg winners." },
      { key: "callSetWin", label: "Set wins", description: "Announce set winners." },
      { key: "callMatchWin", label: "Match wins", description: "Announce match winners." },
    ],
    []
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-black via-zinc-950 to-black text-white">
      <div className="px-6 py-10 max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Settings</p>
            <h1 className="text-3xl font-bold mt-1">Sound & Voice Announcements</h1>
            <p className="text-zinc-400 mt-2">
              Configure where audio clips are loaded from and which in-game events are announced.
            </p>
          </div>
          <Link
            to="/"
            className="text-sm text-zinc-400 hover:text-white transition-colors underline underline-offset-4"
          >
            Home
          </Link>
        </div>

        <div className="space-y-8">
          <div className={sectionClasses}>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold flex items-center gap-3">
                  <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-emerald-500/20 text-emerald-300">
                    <Volume2 className="h-5 w-5" />
                  </span>
                  Voice Pack
                </h2>
                <p className="text-sm text-zinc-400 mt-2">
                  Point to the folder that contains the MP3 announcements (e.g. D:\voicepack\en-GB-ballad-MALE).
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleInputChange("enabled", !settings.enabled)}
                className={toggleClasses(settings.enabled)}
              >
                {settings.enabled ? (
                  <>
                    <Volume2 className="h-4 w-4" />
                    Enabled
                  </>
                ) : (
                  <>
                    <VolumeX className="h-4 w-4" />
                    Disabled
                  </>
                )}
              </button>
            </div>

            <div className="mt-6">
              <label className="text-sm uppercase tracking-[0.3em] text-zinc-500 block mb-2">
                Voice Pack Path
              </label>
              <input
                type="text"
                value={settings.voicePackPath}
                onChange={(event) => handleInputChange("voicePackPath", event.target.value)}
                placeholder="D:\voicepack\en-GB-ballad-MALE"
                className="w-full rounded-xl bg-black/50 border border-white/10 px-4 py-3 text-sm focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
              />
              <div className="flex items-center gap-3 mt-3">
                <button
                  type="button"
                  onClick={handleDirectoryButton}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-900/60 border border-white/10 text-sm text-zinc-300 hover:bg-zinc-800/80 transition-colors"
                >
                  Select Folder…
                </button>
                {defaultVoicePackPath && (
                  <button
                    type="button"
                    onClick={handleUseDefaultPack}
                    disabled={settings.voicePackPath === defaultVoicePackPath}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-sm text-emerald-200 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                  >
                    Use Bundled Pack
                  </button>
                )}
                {selectionInfo && <span className="text-xs text-zinc-400">{selectionInfo}</span>}
              </div>
              <p className="text-xs text-zinc-500 mt-2">
                The directory must exist on this machine and contain the voice clips (MP3 or WAV).
              </p>
              <input
                type="file"
                ref={directoryInputRef}
                onChange={handleDirectorySelected}
                style={{ display: "none" }}
              />
            </div>

            <div className="mt-6">
              <label className="text-sm uppercase tracking-[0.3em] text-zinc-500 block mb-2">
                Queue Delay (ms)
              </label>
              <input
                type="number"
                min={0}
                max={2000}
                value={settings.queueDelayMs}
                onChange={(event) => handleInputChange("queueDelayMs", Number(event.target.value))}
                className="w-32 rounded-xl bg-black/50 border border-white/10 px-3 py-2 text-sm focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
              />
              <p className="text-xs text-zinc-500 mt-2">
                Adds a brief pause between clips to keep announcements intelligible.
              </p>
            </div>
          </div>

          <div className={sectionClasses}>
            <h2 className="text-xl font-semibold mb-4">Announcement Triggers</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {toggles.map((toggle) => (
                <button
                  type="button"
                  key={toggle.key}
                  onClick={() => handleInputChange(toggle.key, !settings[toggle.key])}
                  className={toggleClasses(settings[toggle.key])}
                >
                  <div className="flex flex-col items-start">
                    <span>{toggle.label}</span>
                    <span className="text-xs text-zinc-500 mt-0.5 text-left">{toggle.description}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className={`${sectionClasses} flex flex-col md:flex-row items-center md:items-start gap-4`}>
            <div className="flex-1 w-full">
              <h2 className="text-xl font-semibold mb-2">Actions</h2>
              <p className="text-sm text-zinc-400">
                Save your changes or trigger a short test clip to confirm audio output. Make sure your speakers are on!
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={saveSettings}
                disabled={saving || loading}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30 transition-colors disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save Settings
              </button>
              <button
                type="button"
                onClick={triggerTestClip}
                disabled={loading || saving || !settings.enabled}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-500/10 border border-blue-500/40 text-blue-300 hover:bg-blue-500/20 transition-colors disabled:opacity-50"
              >
                <FlaskConical className="h-4 w-4" />
                Play Test Clip
              </button>
              <button
                type="button"
                onClick={fetchSettings}
                disabled={loading}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-900/60 border border-white/10 text-zinc-300 hover:bg-zinc-800/80 transition-colors disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Reload
              </button>
            </div>
          </div>

          {(message || error) && (
            <div
              className={[
                "rounded-xl border px-4 py-3 text-sm flex items-center gap-3",
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
      </div>
    </div>
  );
};

export default SoundSettingsPage;
