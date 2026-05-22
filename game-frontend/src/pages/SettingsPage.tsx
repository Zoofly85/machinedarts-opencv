import React from "react";
import { Link } from "react-router-dom";
import { SlidersHorizontal, Cpu, ArrowLeft } from "lucide-react";
import Logo from "../components/Logo";

export default function SettingsPage() {
  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden">
      <div className="pointer-events-none fixed inset-0 [background:radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)]" />
      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between">
        <Logo />
        <Link
          to="/console"
          className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-xs hover:bg-white/10 transition"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
      </header>
      <main className="relative z-10 w-full px-6 md:px-10 py-10">
        <h1 className="text-3xl font-bold mb-6">Settings</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl">
          <Link
            to="/backend-settings/detection"
            className="rounded-xl border border-white/10 bg-white/5 p-5 hover:bg-white/10 transition"
          >
            <SlidersHorizontal className="h-6 w-6 text-cyan-400 mb-3" />
            <div className="font-semibold">Detection</div>
            <div className="text-sm text-zinc-400 mt-1">Tune thresholds and view live insights.</div>
          </Link>
          <Link
            to="/settings/models"
            className="rounded-xl border border-white/10 bg-white/5 p-5 hover:bg-white/10 transition"
          >
            <Cpu className="h-6 w-6 text-cyan-400 mb-3" />
            <div className="font-semibold">Models</div>
            <div className="text-sm text-zinc-400 mt-1">Model selection and CPU tuning.</div>
          </Link>
        </div>
      </main>
    </div>
  );
}
