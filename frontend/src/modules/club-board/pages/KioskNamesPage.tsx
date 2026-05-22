import React from "react";

import { getKioskState, saveKioskState, type KioskPlayerDraft } from "../kioskState";
import { getPlayersCached, type PlayerProfile } from "../../../game/services/playersApi";

function normalize(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function tokenize(value: string): string[] {
  return normalize(value).split(/[\s,._-]+/).filter(Boolean);
}

function parseProfileName(profileName: string): { firstName: string; lastName: string; nickname: string } {
  const raw = String(profileName || "").trim();
  const withNick = raw.match(/^(.*)\((.*)\)\s*$/);
  let base = raw;
  let nickname = "";
  if (withNick) {
    base = String(withNick[1] || "").trim();
    nickname = String(withNick[2] || "").trim();
  }
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    return { firstName: base, lastName: "", nickname };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
    nickname,
  };
}

export default function KioskNamesPage() {
  const initial = React.useMemo(() => getKioskState(), []);
  const [players, setPlayers] = React.useState<KioskPlayerDraft[]>(initial.players);
  const [profiles, setProfiles] = React.useState<PlayerProfile[]>([]);
  const [loadingProfiles, setLoadingProfiles] = React.useState(false);
  const [profileQueries, setProfileQueries] = React.useState<string[]>(() =>
    initial.players.map((p, i) => {
      const full = `${p.firstName || ""} ${p.lastName || ""}`.trim();
      const nick = `${p.nickname || ""}`.trim();
      return `${full}${nick ? ` (${nick})` : ""}`.trim() || `Player ${i + 1}`;
    }),
  );

  const updatePlayer = (index: number, patch: Partial<KioskPlayerDraft>) => {
    const next = players.map((p, i) => (i === index ? { ...p, ...patch } : p));
    setPlayers(next);
    saveKioskState({ players: next });
  };

  const indexedProfiles = React.useMemo(
    () =>
      profiles.map((profile) => ({
        profile,
        normalizedName: normalize(profile.name),
        tokens: tokenize(profile.name),
      })),
    [profiles],
  );

  const findSuggestions = (player: KioskPlayerDraft, queryOverride: string): PlayerProfile[] => {
    const typedNameQuery = normalize(`${player.firstName} ${player.lastName} ${player.nickname}`);
    const explicitQuery = normalize(queryOverride);
    const query = explicitQuery || typedNameQuery;
    if (query.length < 2) return [];
    const queryTokens = tokenize(query);
    const ranked = indexedProfiles
      .map((item) => {
        let score = 0;
        if (item.normalizedName === query) score += 1000;
        if (item.normalizedName.startsWith(query)) score += 600;
        if (item.normalizedName.includes(query)) score += 250;
        for (const q of queryTokens) {
          if (item.tokens.some((t) => t === q)) score += 120;
          else if (item.tokens.some((t) => t.startsWith(q))) score += 70;
          else if (item.tokens.some((t) => t.includes(q))) score += 30;
        }
        return { item, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.item.profile.name.localeCompare(b.item.profile.name))
      .slice(0, 10)
      .map((entry) => entry.item.profile);
    return ranked;
  };

  React.useEffect(() => {
    let cancelled = false;
    const loadProfiles = async () => {
      setLoadingProfiles(true);
      try {
        const list = await getPlayersCached();
        if (!cancelled) {
          setProfiles(list.filter((p) => p.id && p.name));
        }
      } finally {
        if (!cancelled) setLoadingProfiles(false);
      }
    };
    void loadProfiles();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      <div
        className="pointer-events-none fixed inset-0 [background:
          radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
          radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
          radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
          radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
          linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
        ]"
      />
      <div className="relative z-10 p-8 md:p-10">
        <div className="max-w-6xl mx-auto border border-white/10 rounded-2xl bg-zinc-900/60 p-6 md:p-8">
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500 mb-3">Kiosk Setup</p>
          <h1 className="text-3xl md:text-5xl font-extrabold text-white">Enter player names</h1>
          <p className="text-zinc-300 mt-3 mb-7">Nickname is optional. Tick save profile to keep this player for future visits.</p>

          <div className="space-y-3">
            {players.map((player, index) => (
              <div key={`kiosk-player-${index}`} className="rounded-xl border border-white/10 bg-black/40 p-4">
                <div className="text-xs uppercase tracking-[0.25em] text-zinc-500 mb-3">Player {index + 1}</div>
                <div className="grid md:grid-cols-3 gap-3">
                  <label className="text-sm text-zinc-300">
                    First name
                    <input
                      className="mt-1 w-full rounded-md bg-black/60 border border-zinc-700 px-3 py-2"
                      value={player.firstName}
                      onChange={(e) => updatePlayer(index, { firstName: e.target.value })}
                    />
                  </label>
                  <label className="text-sm text-zinc-300">
                    Surname
                    <input
                      className="mt-1 w-full rounded-md bg-black/60 border border-zinc-700 px-3 py-2"
                      value={player.lastName}
                      onChange={(e) => updatePlayer(index, { lastName: e.target.value })}
                    />
                  </label>
                  <label className="text-sm text-zinc-300">
                    Nickname (optional)
                    <input
                      className="mt-1 w-full rounded-md bg-black/60 border border-zinc-700 px-3 py-2"
                      value={player.nickname}
                      onChange={(e) => updatePlayer(index, { nickname: e.target.value })}
                    />
                  </label>
                </div>
                <label className="mt-3 block text-sm text-zinc-300">
                  Find saved player
                  <input
                    className="mt-1 w-full rounded-md bg-black/60 border border-zinc-700 px-3 py-2"
                    value={profileQueries[index] || ""}
                    onChange={(e) => {
                      const next = [...profileQueries];
                      next[index] = e.target.value;
                      setProfileQueries(next);
                    }}
                    placeholder="Type name or nickname..."
                  />
                </label>
                {loadingProfiles ? (
                  <div className="mt-3 text-xs text-zinc-500">Loading saved player profiles...</div>
                ) : (
                  (() => {
                    const suggestions = findSuggestions(player, profileQueries[index] || "");
                    if (!suggestions.length) return null;
                    return (
                      <div className="mt-3 rounded-lg border border-zinc-800 bg-black/30 p-2">
                        <div className="text-[11px] uppercase tracking-[0.25em] text-zinc-500 mb-2">
                          Existing players
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {suggestions.map((profile) => (
                            <button
                              key={profile.id}
                              type="button"
                              onClick={() => {
                                const parsed = parseProfileName(profile.name);
                                const nextQueries = [...profileQueries];
                                nextQueries[index] = profile.name;
                                setProfileQueries(nextQueries);
                                updatePlayer(index, {
                                  firstName: parsed.firstName,
                                  lastName: parsed.lastName,
                                  nickname: parsed.nickname,
                                  saveProfile: true,
                                });
                              }}
                              className="rounded-md border border-cyan-800 bg-cyan-950/20 px-3 py-1.5 text-sm text-cyan-200 hover:bg-cyan-900/30"
                            >
                              {profile.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })()
                )}
                <label className="mt-3 inline-flex items-center gap-2 text-sm text-zinc-200">
                  <input
                    type="checkbox"
                    checked={player.saveProfile}
                    onChange={(e) => updatePlayer(index, { saveProfile: e.target.checked })}
                  />
                  Save profile
                </label>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-3 mt-7">
            <a href="#/kiosk/players" className="rounded-lg border border-zinc-700 px-5 py-2 text-zinc-200 hover:bg-zinc-800/70">
              Back
            </a>
            <a href="#/kiosk/games" className="rounded-lg border border-red-600/70 bg-red-600/90 px-5 py-2 text-white hover:bg-red-500">
              Next
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
