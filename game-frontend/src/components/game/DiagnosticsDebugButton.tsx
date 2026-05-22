import React, { useCallback, useState } from "react";
import { Bug } from "lucide-react";
import { GameControlButton } from "./GameControl";

const API_BASE = "http://localhost:8000";

type Props = {
  game: string;
  players?: string[];
};

export default function DiagnosticsDebugButton({ game, players }: Props) {
  const [uploading, setUploading] = useState(false);

  const handleUpload = useCallback(async () => {
    if (uploading) return;
    const note = window.prompt("What went wrong? (optional)\nExample: missed dart / slow scoring / wrong score", "");
    setUploading(true);
    try {
      const res = await fetch(`${API_BASE}/api/diagnostics/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game, note: note || undefined, players }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) {
        const msg = data?.message || `Failed to send logs (${res.status})`;
        window.alert(msg);
        return;
      }
      window.alert("Debug logs upload started. Thanks — you can keep playing.");
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to send debug logs.");
    } finally {
      setUploading(false);
    }
  }, [game, players, uploading]);

  return (
    <GameControlButton
      label={uploading ? "Sending Logs..." : "Send Debug Logs"}
      title="Uploads diagnostic logs to help troubleshoot detection problems"
      icon={<Bug className="h-4 w-4" />}
      disabled={uploading}
      onClick={handleUpload}
      variant="neutral"
    />
  );
}

