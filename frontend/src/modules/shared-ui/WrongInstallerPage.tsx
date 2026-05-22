import React from "react";

type Props = {
  expected: string;
  actual: string;
  message: string;
};

export default function WrongInstallerPage({ expected, actual, message }: Props) {
  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center px-6">
      <div className="max-w-xl w-full border border-cyan-900/70 rounded-2xl p-6 bg-zinc-950/90">
        <h1 className="text-2xl font-bold text-cyan-300">Wrong Installer For This Account</h1>
        <p className="text-zinc-300 mt-3">{message}</p>
        <div className="mt-5 grid gap-2 text-sm">
          <div className="flex justify-between border border-zinc-800 rounded-lg px-3 py-2">
            <span className="text-zinc-400">Current installer</span>
            <span className="font-semibold">{actual}</span>
          </div>
          <div className="flex justify-between border border-zinc-800 rounded-lg px-3 py-2">
            <span className="text-zinc-400">Expected installer</span>
            <span className="font-semibold">{expected}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

