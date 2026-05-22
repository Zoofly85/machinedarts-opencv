import React from "react";
import { NavLink } from "react-router-dom";
import Logo from "./Logo";
import { getModelSettings } from "../services/api";

type NavItem = {
  to: string;
  label: string;
};

const baseItems: NavItem[] = [
  { to: "/", label: "Home" },
  { to: "/settings/player-bots", label: "Player Bots" },
  { to: "/settings/models", label: "Models" },
  { to: "/settings/runtime", label: "Settings" },
  { to: "/settings/system-accuracy", label: "Accuracy" },
  { to: "/settings/detection", label: "Detection" },
  { to: "/settings/sound", label: "Sound" },
  { to: "/settings/wled", label: "WLED" },
];

export default function BackendTopNav() {
  const [showStats, setShowStats] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    getModelSettings()
      .then((data) => {
        if (!active) return;
        setShowStats(Boolean(data?.settings?.features?.enable_model_stats ?? false));
      })
      .catch(() => {
        if (!active) return;
        setShowStats(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const items = React.useMemo(
    () => (showStats ? [...baseItems.slice(0, 4), { to: "/stats", label: "Stats" }, ...baseItems.slice(4)] : baseItems),
    [showStats],
  );

  return (
    <header className="relative z-10 w-full px-4 sm:px-6 md:px-10 py-4 flex items-center justify-between border-b border-white/10">
      <Logo />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `px-3 py-2 rounded-md text-sm border transition-colors ${
                isActive
                  ? "bg-cyan-500 text-slate-950 border-cyan-400 font-semibold"
                  : "border-white/20 hover:border-cyan-400 text-white"
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </div>
    </header>
  );
}
