import React from "react";
import { ExternalLink, Lightbulb, Play, Save, Wifi } from "lucide-react";
import BackendTopNav from "../components/BackendTopNav";
import { getWledSettings, testWledEvent, updateWledSettings, type WledEventConfig, type WledSettings } from "../game/services/wledApi";

const DEFAULT_EVENTS = [
  { key: "idle", label: "Ideal State", description: "Always-on color or effect when no event is active.", idle: true },
  { key: "game_start", label: "Game Start", description: "Fires when an X01 game starts." },
  { key: "dart_detected", label: "Dart Detected", description: "Quick feedback when a dart is detected." },
  { key: "takeout", label: "Takeout", description: "Darts are being removed from the board." },
  { key: "score_60_plus", label: "60+", description: "Turn total from 60 to 79." },
  { key: "score_80_plus", label: "80+", description: "Turn total from 80 to 99." },
  { key: "score_100_plus", label: "100+", description: "Turn total from 100 to 119." },
  { key: "score_120_plus", label: "120+", description: "Turn total from 120 to 139." },
  { key: "score_140_plus", label: "140+", description: "Turn total from 140 to 159." },
  { key: "score_160_plus", label: "160+", description: "Turn total from 160 to 179." },
  { key: "score_180", label: "180", description: "Maximum turn." },
  { key: "checkout", label: "Checkout", description: "Player is on a finish." },
  { key: "game_shot", label: "Game Shot", description: "Leg or match winning moment." },
  { key: "bust", label: "Bust", description: "Red warning for bust visits." },
] as const;

const FALLBACK_SETTINGS: WledSettings = {
  enabled: false,
  host: "192.168.1.36",
  brightness: 160,
  timeout_ms: 1200,
  events: {
    idle: { mode: "color", color: [40, 120, 255], effect: 0, preset: 0, duration_ms: 0 },
  },
};

const WLED_EFFECTS = [
  { id: 0, name: "Solid" },
  { id: 1, name: "Blink" },
  { id: 2, name: "Breathe" },
  { id: 9, name: "Colorloop" },
  { id: 11, name: "Rainbow" },
  { id: 12, name: "Scan" },
  { id: 13, name: "Dual Scan" },
  { id: 15, name: "Chase" },
  { id: 16, name: "Chase Rainbow" },
  { id: 24, name: "Running" },
  { id: 36, name: "Meteor" },
  { id: 37, name: "Meteor Smooth" },
  { id: 47, name: "Fireworks" },
  { id: 63, name: "Heartbeat" },
  { id: 68, name: "Lightning" },
  { id: 74, name: "Ripple" },
  { id: 88, name: "Fire 2012" },
  { id: 98, name: "Juggle" },
] as const;

function colorToHex(color?: number[]) {
  const parts = [0, 1, 2].map((index) => Math.max(0, Math.min(255, Number(color?.[index] ?? 255))));
  return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function hexToColor(hex: string) {
  const normalized = hex.replace("#", "").trim();
  if (normalized.length !== 6) return [255, 255, 255];
  return [0, 2, 4].map((start) => parseInt(normalized.slice(start, start + 2), 16));
}

function normalizeEventConfig(event?: WledEventConfig): WledEventConfig {
  return {
    mode: event?.mode ?? "color",
    color: event?.color ?? [255, 255, 255],
    effect: Number(event?.effect ?? 0),
    preset: Number(event?.preset ?? 0),
    duration_ms: Number(event?.duration_ms ?? 0),
  };
}

function buildWledUiUrl(host: string) {
  const normalized = host.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return normalized ? `http://${normalized}` : "";
}

export default function WledSettingsPage() {
  const [settings, setSettings] = React.useState<WledSettings>(FALLBACK_SETTINGS);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const payload = await getWledSettings();
      setSettings({ ...FALLBACK_SETTINGS, ...payload.settings });
      setMessage("");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to load WLED settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const updateEvent = (key: string, patch: Partial<WledEventConfig>) => {
    setSettings((previous) => {
      const current = normalizeEventConfig(previous.events[key]);
      return {
        ...previous,
        events: {
          ...previous.events,
          [key]: {
            ...current,
            ...patch,
          },
        },
      };
    });
  };

  const save = async () => {
    setSaving(true);
    setMessage("");
    try {
      const payload = await updateWledSettings(settings);
      setSettings(payload.settings);
      setMessage("WLED settings saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to save WLED settings.");
    } finally {
      setSaving(false);
    }
  };

  const testEvent = async (event: string) => {
    setTesting(event);
    setMessage("");
    try {
      const payload = await updateWledSettings(settings);
      setSettings(payload.settings);
      await testWledEvent(event);
      setMessage(`Sent WLED test: ${event.replace(/_/g, " ")}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "WLED test failed.");
    } finally {
      setTesting(null);
    }
  };

  const openWledUi = () => {
    const url = buildWledUiUrl(settings.host);
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(34,197,94,0.18),transparent_32%),radial-gradient(circle_at_85%_20%,rgba(56,189,248,0.16),transparent_34%),linear-gradient(135deg,#020617,#0f172a_55%,#0a0a0a)]" />
      <BackendTopNav />
      <main className="relative z-10 mx-auto max-w-6xl px-6 py-8 space-y-6">
        <section className="rounded-3xl border border-white/10 bg-slate-900/75 p-6 shadow-2xl">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-xs uppercase tracking-[0.2em] text-emerald-200">
                <Lightbulb className="h-4 w-4" />
                WLED Integration
              </div>
              <h1 className="mt-4 text-3xl font-black">LED Event Settings</h1>
              <p className="mt-2 max-w-2xl text-sm text-slate-400">
                Connect Machine Darts to a WLED controller on your local network. WLED stays optional; if it is off or unreachable, darts keeps playing normally.
              </p>
            </div>
            <button
              type="button"
              onClick={openWledUi}
              disabled={!settings.host}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/10 px-4 py-2 font-semibold hover:bg-white/15 disabled:opacity-50"
            >
              <ExternalLink className="h-4 w-4" />
              Open WLED UI
            </button>
            <button
              type="button"
              onClick={() => void testEvent("idle")}
              disabled={testing !== null || !settings.host}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 font-semibold hover:bg-emerald-500 disabled:opacity-50"
            >
              <Wifi className="h-4 w-4" />
              {testing === "idle" ? "Testing..." : "Test Ideal"}
            </button>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-3xl border border-white/10 bg-slate-900/75 p-6 space-y-5">
            <h2 className="text-lg font-bold">Connection</h2>
            <label className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/25 p-4">
              <span>
                <span className="block font-semibold">Enable WLED</span>
                <span className="text-sm text-slate-400">Allow game events to trigger lights.</span>
              </span>
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(event) => setSettings((previous) => ({ ...previous, enabled: event.target.checked }))}
                className="h-5 w-5 accent-emerald-500"
              />
            </label>

            <label className="block">
              <span className="text-sm font-semibold text-slate-300">WLED IP / Host</span>
              <input
                value={settings.host}
                onChange={(event) => setSettings((previous) => ({ ...previous, host: event.target.value }))}
                placeholder="192.168.1.36"
                className="mt-2 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-emerald-400"
              />
              <span className="mt-2 block text-xs text-slate-500">
                Your current controller should be reachable at{" "}
                <button type="button" onClick={openWledUi} className="text-emerald-300 underline decoration-emerald-500/40">
                  {buildWledUiUrl(settings.host) || "WLED UI"}
                </button>
                .
              </span>
            </label>

            <label className="block">
              <span className="text-sm font-semibold text-slate-300">Brightness: {settings.brightness}</span>
              <input
                type="range"
                min={1}
                max={255}
                value={settings.brightness}
                onChange={(event) => setSettings((previous) => ({ ...previous, brightness: Number(event.target.value) }))}
                className="mt-3 w-full accent-emerald-500"
              />
            </label>

            <label className="block">
              <span className="text-sm font-semibold text-slate-300">Timeout ms</span>
              <input
                type="number"
                min={250}
                max={5000}
                value={settings.timeout_ms}
                onChange={(event) => setSettings((previous) => ({ ...previous, timeout_ms: Number(event.target.value) }))}
                className="mt-2 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-emerald-400"
              />
            </label>

            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || loading}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-3 font-semibold hover:bg-sky-500 disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {saving ? "Saving..." : "Save WLED Settings"}
            </button>

            {message ? (
              <div className="rounded-2xl border border-white/10 bg-black/30 p-3 text-sm text-slate-200">{message}</div>
            ) : null}
          </div>

          <div className="rounded-3xl border border-white/10 bg-slate-900/75 p-6">
            <h2 className="text-lg font-bold">Ideal State & Events</h2>
            <p className="mt-1 text-sm text-slate-400">The ideal state stays on. Events temporarily replace it, then return to ideal after their time expires.</p>
            <div className="mt-4 rounded-2xl border border-sky-400/20 bg-sky-500/10 p-4 text-sm text-sky-100">
              Build complex animations in the WLED UI, save them as presets, then choose <span className="font-semibold">Preset</span> here and enter the preset number.
              For quick setup, choose <span className="font-semibold">Effect</span> and pick one of the common WLED effects from the dropdown.
            </div>
            <div className="mt-5 space-y-3">
              {DEFAULT_EVENTS.map((item) => {
                const event = normalizeEventConfig(settings.events[item.key]);
                return (
                  <div key={item.key} className="rounded-2xl border border-white/10 bg-black/25 p-4">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <h3 className="font-semibold">{item.label}</h3>
                        <p className="text-sm text-slate-500">{item.description}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void testEvent(item.key)}
                        disabled={testing !== null}
                        className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/10 px-3 py-2 text-sm hover:bg-white/15 disabled:opacity-50"
                      >
                        <Play className="h-4 w-4" />
                        {testing === item.key ? "Testing..." : "Test"}
                      </button>
                    </div>
                    <div className="mt-4 grid gap-3 md:grid-cols-5">
                      <label className="block">
                        <span className="text-xs uppercase tracking-[0.18em] text-slate-500">Mode</span>
                        <select
                          value={event.mode}
                          onChange={(e) => updateEvent(item.key, { mode: e.target.value as WledEventConfig["mode"] })}
                          className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-2"
                        >
                          <option value="color">Color</option>
                          <option value="effect">Effect</option>
                          <option value="preset">Preset</option>
                        </select>
                      </label>
                      <label className="block">
                        <span className="text-xs uppercase tracking-[0.18em] text-slate-500">Color</span>
                        <input
                          type="color"
                          value={colorToHex(event.color)}
                          onChange={(e) => updateEvent(item.key, { color: hexToColor(e.target.value) })}
                          className="mt-2 h-10 w-full rounded-lg border border-white/10 bg-black/40"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs uppercase tracking-[0.18em] text-slate-500">Effect</span>
                        <select
                          value={event.effect ?? 0}
                          onChange={(e) => updateEvent(item.key, { effect: Number(e.target.value) })}
                          className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-2"
                        >
                          {WLED_EFFECTS.map((effect) => (
                            <option key={effect.id} value={effect.id}>
                              {effect.id} - {effect.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="text-xs uppercase tracking-[0.18em] text-slate-500">Preset</span>
                        <input
                          type="number"
                          min={0}
                          value={event.preset ?? 0}
                          onChange={(e) => updateEvent(item.key, { preset: Number(e.target.value) })}
                          className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-2"
                        />
                        <span className="mt-1 block text-[11px] text-slate-500">Use 0 for no preset.</span>
                      </label>
                      {!("idle" in item && item.idle) ? (
                        <label className="block">
                          <span className="text-xs uppercase tracking-[0.18em] text-slate-500">Time</span>
                          <input
                            type="number"
                            min={0}
                            max={10}
                            step={0.1}
                            value={Number(event.duration_ms ?? 1000) / 1000}
                            onChange={(e) =>
                              updateEvent(item.key, {
                                duration_ms: Math.max(0, Math.round(Number(e.target.value || 0) * 1000)),
                              })
                            }
                            className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-2"
                          />
                          <span className="mt-1 block text-[11px] text-slate-500">Seconds before returning to ideal.</span>
                        </label>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
