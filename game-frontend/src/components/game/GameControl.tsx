import React from "react";
import { Link } from "react-router-dom";

export type GameControlVariant = "neutral" | "primary" | "danger";

const baseClassName =
  "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition border";

const variantClassName: Record<GameControlVariant, string> = {
  neutral: "border-white/10 bg-zinc-800/80 hover:bg-zinc-700/80 text-white",
  primary: "border-blue-500/30 bg-blue-600 hover:bg-blue-500 text-white",
  danger: "border-red-500/30 bg-red-600 hover:bg-red-500 text-white",
};

type CommonProps = {
  label: string;
  icon?: React.ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
  variant?: GameControlVariant;
};

export function GameControlButton({
  label,
  icon,
  className = "",
  disabled = false,
  title,
  variant = "neutral",
  onClick,
  type = "button",
}: CommonProps & {
  onClick?: () => void | Promise<void>;
  type?: "button" | "submit" | "reset";
}) {
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`${baseClassName} ${variantClassName[variant]} ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className}`}
    >
      {icon}
      {label}
    </button>
  );
}

export function GameControlLink({
  label,
  icon,
  className = "",
  title,
  variant = "neutral",
  to,
}: CommonProps & { to: string }) {
  return (
    <Link
      to={to}
      title={title}
      className={`${baseClassName} ${variantClassName[variant]} ${className}`}
    >
      {icon}
      {label}
    </Link>
  );
}

