import React from "react";
// removed unused motion import
import { Link } from "react-router-dom";

interface ActionButtonProps {
  label: string;
  href: string;
  icon?: React.ReactNode;
  kbd?: string;
  aria?: string;
  className?: string;
}

const ActionButton: React.FC<ActionButtonProps> = ({
  href,
  label,
  icon,
  kbd,
  aria,
  className = "",
}) => {
  return (
    <Link
      to={href}
      aria-label={aria || label}
      className={`group inline-flex items-center justify-between gap-4 w-full sm:w-auto rounded-2xl px-8 py-5 text-lg font-semibold tracking-wide border border-red-600/60 bg-red-600/90 text-white shadow-lg shadow-red-900/40 hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 transition ${className}`}
    >
      <span className="flex items-center gap-3">{icon}{label}</span>
      {kbd && <span className="ml-2 rounded-md bg-black/40 px-2 py-0.5 text-sm font-mono border border-white/10">{kbd}</span>}
    </Link>
  );
};

export default ActionButton;