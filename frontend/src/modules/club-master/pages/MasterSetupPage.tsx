import React from "react";

import {
  getClubControlConfig,
  saveClubControlConfig,
} from "../../shared-domain/clubControlConfig";
import { testClubServerConnection } from "../services/clubApi";

export default function MasterSetupPage() {
  const cfg = React.useMemo(() => getClubControlConfig(), []);
  const [server, setServer] = React.useState(cfg.controlServerUrl);
  const [venueId, setVenueId] = React.useState(cfg.venueId);
  const [msg, setMsg] = React.useState<string>("");
  const [busy, setBusy] = React.useState(false);

  const handleSave = () => {
    saveClubControlConfig({ controlServerUrl: server, venueId });
    setMsg("Saved master config.");
  };

  const handleTest = async () => {
    setBusy(true);
    setMsg("");
    saveClubControlConfig({ controlServerUrl: server, venueId });
    const ok = await testClubServerConnection();
    setMsg(ok ? "Connected to club server." : "Connection failed. Check URL and network.");
    setBusy(false);
  };

  return (
    <div className="min-h-screen bg-black text-white p-6 md:p-8">
      <div className="max-w-3xl border border-cyan-900/70 rounded-2xl p-6 bg-zinc-950/90">
        <h1 className="text-2xl md:text-3xl font-extrabold text-cyan-300">Club Master Setup</h1>
        <p className="text-zinc-300 mt-2">Set the central control server for this master tablet.</p>

        <div className="grid gap-3 mt-5">
          <label className="text-sm text-zinc-300">
            Club server URL
            <input
              className="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2"
              value={server}
              onChange={(e) => setServer(e.target.value)}
            />
          </label>
          <label className="text-sm text-zinc-300">
            Venue ID
            <input
              className="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2"
              value={venueId}
              onChange={(e) => setVenueId(e.target.value)}
            />
          </label>
        </div>

        <div className="flex gap-2 mt-5">
          <button
            className="px-4 py-2 rounded-md border border-cyan-700 hover:bg-cyan-900/30"
            onClick={handleSave}
          >
            Save
          </button>
          <button
            className="px-4 py-2 rounded-md border border-emerald-700 hover:bg-emerald-900/30 disabled:opacity-50"
            onClick={() => void handleTest()}
            disabled={busy}
          >
            {busy ? "Testing..." : "Test Connection"}
          </button>
          <a className="px-4 py-2 rounded-md border border-zinc-700 hover:bg-zinc-800/60" href="#/club/master">
            Back to Dashboard
          </a>
        </div>

        {msg && <p className="mt-4 text-sm text-zinc-200">{msg}</p>}
      </div>
    </div>
  );
}
