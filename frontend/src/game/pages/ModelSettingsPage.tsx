import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, Cpu, CheckCircle, AlertCircle } from "lucide-react";
import Logo from "../components/Logo";
import ActionButton from "../components/ActionButton";
import {
  ALLOWED_TIP_MODELS,
  TIP_MODEL_DETAILS,
  TIP_MODEL_LABELS,
  TIP_MODEL_ORDER,
} from "../constants/tipModels";
import { API_BASE_URL } from "../../services/api";

const API_BASE = API_BASE_URL;

interface TipModelEntry {
  name: string;
  path: string;
  selected: boolean;
}

export default function ModelSettingsPage() {
  const navigate = useNavigate();
  const [models, setModels] = useState<TipModelEntry[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [botSpeed, setBotSpeed] = useState<string>("normal");
  const [botSpeedSaving, setBotSpeedSaving] = useState(false);
  const [botSpeedMessage, setBotSpeedMessage] = useState<string | null>(null);
  const [botSpeedError, setBotSpeedError] = useState<string | null>(null);
  const [diffThreshold, setDiffThreshold] = useState<number>(0.15);
  const [diffThresholdLoading, setDiffThresholdLoading] = useState(false);
  const [diffThresholdSaving, setDiffThresholdSaving] = useState(false);
  const [diffThresholdMessage, setDiffThresholdMessage] = useState<string | null>(null);
  const [diffThresholdError, setDiffThresholdError] = useState<string | null>(null);

  const loadModels = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${API_BASE}/api/models/tip`);
      const contentType = resp.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await resp.json()
        : await resp.text();
      if (!resp.ok) {
        const message =
          typeof payload === "string"
            ? payload
            : payload?.detail || payload?.message || `Failed to load models (${resp.status})`;
        throw new Error(message);
      }
      const data = payload;
      const entries = (Array.isArray(data.models) ? data.models : [])
        .filter((entry: TipModelEntry) => ALLOWED_TIP_MODELS.has(entry.name))
        .sort(
          (a: TipModelEntry, b: TipModelEntry) =>
            TIP_MODEL_ORDER.indexOf(a.name) - TIP_MODEL_ORDER.indexOf(b.name)
        );
      setModels(entries);
      const active = entries.find((m: TipModelEntry) => m.selected);
      if (active) {
        setSelected(active.name);
      } else if (entries.length > 0) {
        setSelected(entries[0].name);
      } else if (data.selected) {
        setSelected(String(data.selected));
      }
    } catch (err: any) {
      setError(err?.message || "Unable to load models.");
    } finally {
      setLoading(false);
    }
  };

  const loadBotSpeed = async () => {
    setBotSpeedError(null);
    try {
      const resp = await fetch(`${API_BASE}/api/bots/speed`);
      const contentType = resp.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await resp.json()
        : await resp.text();
      if (!resp.ok) {
        const message =
          typeof payload === "string"
            ? payload
            : payload?.detail || payload?.message || `Failed to load bot speed (${resp.status})`;
        throw new Error(message);
      }
      if (payload?.speed) {
        setBotSpeed(String(payload.speed));
      }
    } catch (err: any) {
      setBotSpeedError(err?.message || "Unable to load bot speed.");
    }
  };

  const saveSelection = async () => {
    if (!selected) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const resp = await fetch(`${API_BASE}/api/models/tip/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: selected }),
      });
      const contentType = resp.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await resp.json()
        : await resp.text();
      if (!resp.ok) {
        const message =
          typeof payload === "string"
            ? payload
            : payload?.detail || payload?.message || "Failed to switch model.";
        throw new Error(message);
      }
      setMessage("Tip model updated. Backend restarted detection.");
      await loadModels();
    } catch (err: any) {
      setError(err?.message || "Failed to switch model.");
    } finally {
      setSaving(false);
    }
  };

  const saveBotSpeed = async () => {
    setBotSpeedSaving(true);
    setBotSpeedMessage(null);
    setBotSpeedError(null);
    try {
      const resp = await fetch(`${API_BASE}/api/bots/speed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speed: botSpeed }),
      });
      const contentType = resp.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await resp.json()
        : await resp.text();
      if (!resp.ok) {
        const message =
          typeof payload === "string"
            ? payload
            : payload?.detail || payload?.message || "Failed to update bot speed.";
        throw new Error(message);
      }
      setBotSpeedMessage("Bot speed updated.");
    } catch (err: any) {
      setBotSpeedError(err?.message || "Failed to update bot speed.");
    } finally {
      setBotSpeedSaving(false);
    }
  };

  const loadDiffThreshold = async () => {
    setDiffThresholdLoading(true);
    setDiffThresholdError(null);
    try {
      const resp = await fetch(`${API_BASE}/api/diagnostics/metrics`);
      const contentType = resp.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await resp.json()
        : await resp.text();
      if (!resp.ok) {
        const message =
          typeof payload === "string"
            ? payload
            : payload?.detail || payload?.message || `Failed to load thresholds (${resp.status})`;
        throw new Error(message);
      }
      const thresholdValue = payload?.thresholds?.DIFF_THRESHOLD;
      if (typeof thresholdValue === "number" && Number.isFinite(thresholdValue)) {
        setDiffThreshold(Number(thresholdValue.toFixed(3)));
      }
    } catch (err: any) {
      setDiffThresholdError(err?.message || "Unable to load detection thresholds.");
    } finally {
      setDiffThresholdLoading(false);
    }
  };

  const applyDiffThreshold = async (persist: boolean) => {
    setDiffThresholdSaving(true);
    setDiffThresholdMessage(null);
    setDiffThresholdError(null);
    try {
      const endpoint = persist ? "/api/diagnostics/thresholds/save" : "/api/diagnostics/thresholds";
      const resp = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diffThreshold }),
      });
      const contentType = resp.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await resp.json()
        : await resp.text();
      if (!resp.ok) {
        const message =
          typeof payload === "string"
            ? payload
            : payload?.detail || payload?.message || "Failed to update detection threshold.";
        throw new Error(message);
      }
      const serverValue = payload?.thresholds?.DIFF_THRESHOLD;
      if (typeof serverValue === "number" && Number.isFinite(serverValue)) {
        setDiffThreshold(Number(serverValue.toFixed(3)));
      }
      setDiffThresholdMessage(
        persist ? "Diff threshold saved." : "Diff threshold applied."
      );
    } catch (err: any) {
      setDiffThresholdError(err?.message || "Failed to update detection threshold.");
    } finally {
      setDiffThresholdSaving(false);
    }
  };

  useEffect(() => {
    loadModels();
    loadBotSpeed();
    loadDiffThreshold();
  }, []);

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      <div className="pointer-events-none fixed inset-0 [background:
        radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
        radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
        radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
        radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
        linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95) 30%,rgba(255,255,255,0.04) 60%,rgba(0,0,0,1) 100%)
      ]" />

      <header className="relative z-10 w-full px-4 sm:px-6 md:px-10 py-4 flex items-center justify-between">
        <Logo />
        <ActionButton
          href="/"
          label="Back"
          aria="Return to settings"
          icon={<ArrowLeft className="h-5 w-5" />}
          className="bg-zinc-800 hover:bg-zinc-700 border-zinc-700 shadow-zinc-900/40 text-sm py-2 px-3"
        />
      </header>

      <main className="relative z-10 w-full px-4 sm:px-6 md:px-10 pb-10">
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="text-3xl sm:text-4xl font-bold mb-6 flex items-center gap-3"
        >
          <Cpu className="h-7 w-7 text-red-400" />
          Settings
        </motion.h1>

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/50 bg-red-900/30 px-4 py-3 text-sm text-red-100 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}
        {message && (
          <div className="mb-4 rounded-lg border border-green-500/40 bg-green-900/30 px-4 py-3 text-sm text-green-100 flex items-center gap-2">
            <CheckCircle className="h-4 w-4" />
            {message}
          </div>
        )}
        {botSpeedError && (
          <div className="mb-4 rounded-lg border border-red-500/50 bg-red-900/30 px-4 py-3 text-sm text-red-100 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            {botSpeedError}
          </div>
        )}
        {botSpeedMessage && (
          <div className="mb-4 rounded-lg border border-green-500/40 bg-green-900/30 px-4 py-3 text-sm text-green-100 flex items-center gap-2">
            <CheckCircle className="h-4 w-4" />
            {botSpeedMessage}
          </div>
        )}
        {diffThresholdError && (
          <div className="mb-4 rounded-lg border border-red-500/50 bg-red-900/30 px-4 py-3 text-sm text-red-100 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            {diffThresholdError}
          </div>
        )}
        {diffThresholdMessage && (
          <div className="mb-4 rounded-lg border border-green-500/40 bg-green-900/30 px-4 py-3 text-sm text-green-100 flex items-center gap-2">
            <CheckCircle className="h-4 w-4" />
            {diffThresholdMessage}
          </div>
        )}
        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Tip model</h2>
            <button
              type="button"
              onClick={loadModels}
              disabled={loading}
              className="text-xs px-3 py-2 rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 transition-colors disabled:opacity-60"
            >
              Refresh
            </button>
          </div>

          {loading ? (
            <div className="text-sm text-zinc-400">Loading models...</div>
          ) : (
            <div className="space-y-2">
              {models.length === 0 && (
                <div className="text-sm text-zinc-400">No OpenVINO tip models found.</div>
              )}
              {models.map((model) => (
                <label
                  key={model.name}
                  className={`flex items-start gap-3 rounded-lg border px-3 py-2 cursor-pointer transition ${
                    selected === model.name
                      ? "border-red-400 bg-red-500/10"
                      : "border-white/10 bg-black/20 hover:border-white/30"
                  }`}
                >
                  <input
                    type="radio"
                    name="tip-model"
                    checked={selected === model.name}
                    onChange={() => setSelected(model.name)}
                    className="mt-1"
                  />
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">{TIP_MODEL_LABELS[model.name] ?? model.name}</span>
                    <span className="text-[11px] text-zinc-400">{TIP_MODEL_DETAILS[model.name] ?? model.name}</span>
                  </div>
                </label>
              ))}
            </div>
          )}

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={saveSelection}
              disabled={!selected || saving}
              className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {saving ? "Applying..." : "Use Selected Model"}
            </button>
            <button
              type="button"
              onClick={() => navigate("/settings/model-stats")}
              className="px-4 py-2 rounded-lg border border-white/15 bg-black/30 text-sm font-semibold hover:bg-white/10"
            >
              Model Stats
            </button>
            <span className="text-xs text-zinc-400">
              Switching models restarts detection for a few seconds.
            </span>
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4">
          <h2 className="text-lg font-semibold mb-2">Bot speed</h2>
          <p className="text-xs text-zinc-400 mb-4">
            Controls how quickly bots throw. Use slow for casual games.
          </p>
          <div className="flex flex-wrap gap-2">
            {[
              { key: "slow", label: "Slow" },
              { key: "normal", label: "Normal" },
              { key: "fast", label: "Fast" },
            ].map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setBotSpeed(option.key)}
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
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={saveBotSpeed}
              disabled={botSpeedSaving}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {botSpeedSaving ? "Applying..." : "Apply Bot Speed"}
            </button>
            <span className="text-xs text-zinc-400">
              Applies to all bot games on this machine.
            </span>
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-semibold">Detection sensitivity</h2>
            <button
              type="button"
              onClick={loadDiffThreshold}
              disabled={diffThresholdLoading}
              className="text-xs px-3 py-2 rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 transition-colors disabled:opacity-60"
            >
              Refresh
            </button>
          </div>
          <p className="text-xs text-zinc-400 mb-4">
            Adjust the DIFF_THRESHOLD to reduce false detections or improve sensitivity.
          </p>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min={0.05}
              max={0.6}
              step={0.01}
              value={diffThreshold}
              onChange={(event) => setDiffThreshold(Number(event.target.value))}
              className="flex-1 accent-red-500"
            />
            <div className="text-sm font-semibold text-white w-16 text-right">
              {diffThreshold.toFixed(2)}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => applyDiffThreshold(false)}
              disabled={diffThresholdSaving || diffThresholdLoading}
              className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {diffThresholdSaving ? "Applying..." : "Apply (runtime)"}
            </button>
            <button
              type="button"
              onClick={() => applyDiffThreshold(true)}
              disabled={diffThresholdSaving || diffThresholdLoading}
              className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {diffThresholdSaving ? "Saving..." : "Save Default"}
            </button>
            <span className="text-xs text-zinc-400">
              Save default to keep this value after restart.
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}
