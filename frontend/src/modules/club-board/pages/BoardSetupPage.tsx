import React from "react";

import { getClubControlConfig, saveClubControlConfig } from "../../shared-domain/clubControlConfig";
import { registerBoard } from "../services/heartbeat";

export default function BoardSetupPage() {
  const cfg = React.useMemo(() => getClubControlConfig(), []);
  const [server, setServer] = React.useState(cfg.controlServerUrl);
  const [venueId, setVenueId] = React.useState(cfg.venueId);
  const [boardId, setBoardId] = React.useState(cfg.boardId);
  const [machineId, setMachineId] = React.useState(cfg.machineId);
  const [clubName, setClubName] = React.useState(cfg.clubName);
  const [msg, setMsg] = React.useState<string>("");
  const [busy, setBusy] = React.useState(false);

  const handleSave = () => {
    saveClubControlConfig({ controlServerUrl: server, venueId, boardId, machineId, clubName });
    setMsg("Saved board config.");
  };

  const handleRegister = async () => {
    setBusy(true);
    setMsg("");
    saveClubControlConfig({ controlServerUrl: server, venueId, boardId, machineId, clubName });
    const result = await registerBoard();
    setMsg(result.ok ? "Board registered to club server." : `Register failed: ${result.message || "unknown"}`);
    setBusy(false);
  };

  return (
    <div className="min-h-screen bg-black text-white p-8">
      <div className="max-w-2xl border border-cyan-900/70 rounded-2xl p-6 bg-zinc-950/90">
        <h1 className="text-2xl font-bold text-cyan-300">Club Board Setup</h1>
        <p className="text-zinc-300 mt-2">Configure this board to connect to your central club server.</p>

        <div className="grid gap-3 mt-5">
          <label className="text-sm text-zinc-300">
            Club server URL
            <input className="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2" value={server} onChange={(e) => setServer(e.target.value)} />
          </label>
          <label className="text-sm text-zinc-300">
            Venue ID
            <input className="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2" value={venueId} onChange={(e) => setVenueId(e.target.value)} />
          </label>
          <label className="text-sm text-zinc-300">
            Board ID
            <input className="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2" value={boardId} onChange={(e) => setBoardId(e.target.value)} />
          </label>
          <label className="text-sm text-zinc-300">
            Machine ID
            <input className="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2" value={machineId} onChange={(e) => setMachineId(e.target.value)} />
          </label>
          <label className="text-sm text-zinc-300">
            Club Name
            <input className="mt-1 w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2" value={clubName} onChange={(e) => setClubName(e.target.value)} />
          </label>
        </div>

        <div className="flex gap-2 mt-5">
          <button className="px-4 py-2 rounded-md border border-cyan-700 hover:bg-cyan-900/30" onClick={handleSave}>
            Save
          </button>
          <button className="px-4 py-2 rounded-md border border-emerald-700 hover:bg-emerald-900/30 disabled:opacity-50" onClick={() => void handleRegister()} disabled={busy}>
            {busy ? "Registering..." : "Register Board"}
          </button>
          <a className="px-4 py-2 rounded-md border border-zinc-700 hover:bg-zinc-800/60" href="#/kiosk">
            Back to Kiosk
          </a>
        </div>
        {msg && <p className="mt-4 text-sm text-zinc-200">{msg}</p>}
      </div>
    </div>
  );
}
