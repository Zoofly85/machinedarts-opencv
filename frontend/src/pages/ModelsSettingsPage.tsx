import React from "react";
import { Cpu } from "lucide-react";
import BackendTopNav from "../components/BackendTopNav";
import { getModelSettings, updateModelSettings } from "../services/api";

type TipModel = {
  id: string;
  path: string;
  xml: string;
  imgsz?: number[] | null;
};

export default function ModelsSettingsPage() {
  const [models, setModels] = React.useState<TipModel[]>([]);
  const [activeModelId, setActiveModelId] = React.useState("");
  const [confidenceThreshold, setConfidenceThreshold] = React.useState(0.3);
  const [iouThreshold, setIouThreshold] = React.useState(0.9);
  const [enableModelStats, setEnableModelStats] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState("");

  const load = React.useCallback(async () => {
    const data = await getModelSettings();
    const list = (data.available_tip_models ?? []) as TipModel[];
    setModels(list);
    const features = data.settings?.features ?? {};
    const tip = data.settings?.tip ?? {};
    setEnableModelStats(Boolean(features.enable_model_stats ?? false));
    setActiveModelId(String(tip.active_model_id ?? ""));
    setConfidenceThreshold(Number(tip.confidence_threshold ?? 0.3));
    setIouThreshold(Number(tip.iou_threshold ?? 0.9));
  }, []);

  React.useEffect(() => {
    load().catch((e) => setMessage(String(e)));
  }, [load]);

  const save = async () => {
    setSaving(true);
    setMessage("");
    try {
      await updateModelSettings({
        features: {
          enable_model_stats: enableModelStats,
        },
        tip: {
          active_model_id: activeModelId,
          confidence_threshold: confidenceThreshold,
          iou_threshold: iouThreshold,
        },
      });
      await load();
      setMessage("Model settings saved.");
    } catch (e) {
      setMessage(String(e));
    } finally {
      setSaving(false);
    }
  };

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
            <Cpu className="h-5 w-5 text-red-400" />
            <h1 className="text-2xl font-bold">Models</h1>
          </div>

          <div className="space-y-5">
            <div>
              <label className="block text-sm mb-2">Active Tip Model</label>
              <select
                value={activeModelId}
                onChange={(e) => setActiveModelId(e.target.value)}
                disabled={models.length === 0}
                className="w-full rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm"
              >
                {models.length === 0 && <option value="">No tip models found</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
              <div className="text-xs text-zinc-400 mt-2">Detected models: {models.length}</div>
            </div>

            <div className="rounded-lg border border-white/10 bg-black/30 px-4 py-3">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={enableModelStats}
                  onChange={(e) => setEnableModelStats(e.target.checked)}
                  className="mt-1"
                />
                <div>
                  <div className="text-sm font-medium">Enable model stats</div>
                  <div className="text-xs text-zinc-400 mt-1">
                    Records per-model detections, corrections, agreement counts, and timing data. Leave this off on weaker machines unless you are actively comparing models.
                  </div>
                </div>
              </label>
            </div>

            <div>
              <div className="flex items-center justify-between text-sm mb-2">
                <span>Tip Confidence Threshold</span>
                <span className="text-zinc-400">{confidenceThreshold.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0.05}
                max={0.95}
                step={0.01}
                value={confidenceThreshold}
                onChange={(e) => setConfidenceThreshold(Number(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <div className="flex items-center justify-between text-sm mb-2">
                <span>NMS IoU Threshold</span>
                <span className="text-zinc-400">{iouThreshold.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0.1}
                max={0.9}
                step={0.01}
                value={iouThreshold}
                onChange={(e) => setIouThreshold(Number(e.target.value))}
                className="w-full"
              />
            </div>

            <button
              onClick={save}
              disabled={saving}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold hover:bg-red-500 disabled:opacity-60"
            >
              {saving ? "Saving..." : "Save Model Settings"}
            </button>

            {message && <div className="text-sm text-zinc-300">{message}</div>}
          </div>
        </section>
      </main>
    </div>
  );
}
