import React from "react";
import { Link } from "react-router-dom";
import Logo from "../components/Logo";
import CalibrationPage from "../../pages/CalibrationPage";

export default function BackendCalibratePage() {
  return (
    <div className="min-h-screen w-full bg-slate-950 text-white">
      <header className="px-6 md:px-10 py-5 flex items-center justify-between border-b border-white/10">
        <Logo />
        <div className="flex items-center gap-2">
          <Link
            to="/console"
            className="px-3 py-2 rounded-md text-sm border border-white/20 hover:border-cyan-400"
          >
            Console
          </Link>
          <Link
            to="/calibrate"
            className="px-3 py-2 rounded-md text-sm bg-cyan-500 text-slate-950 font-semibold"
          >
            Calibrate
          </Link>
        </div>
      </header>

      <main className="px-6 md:px-10 py-6">
        <div className="max-w-7xl mx-auto rounded-xl border border-white/10 bg-black/30 overflow-hidden">
          <CalibrationPage embedded />
        </div>
      </main>
    </div>
  );
}

