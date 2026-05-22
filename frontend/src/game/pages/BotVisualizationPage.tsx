import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import BotDartVisualization from '../components/BotDartVisualization';

export default function BotVisualizationPage() {
  const navigate = useNavigate();
  const [botLevel, setBotLevel] = useState(7);
  const [targetField, setTargetField] = useState<'T' | 'D' | 'S'>('T');
  const [targetNumber, setTargetNumber] = useState(20);

  const commonTargets = [
    { field: 'T' as const, number: 20, label: 'T20' },
    { field: 'T' as const, number: 19, label: 'T19' },
    { field: 'D' as const, number: 20, label: 'D20' },
    { field: 'D' as const, number: 16, label: 'D16' },
    { field: 'S' as const, number: 20, label: 'S20' },
    { field: 'D' as const, number: 25, label: 'Bull' },
  ];

  return (
    <div className="min-h-screen w-full bg-black text-white relative overflow-hidden flex flex-col">
      <div
        className="pointer-events-none fixed inset-0 [background:
          radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
          radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
          radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
          radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
          linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95)_30%,rgba(255,255,255,0.04)_60%,rgba(0,0,0,1)_100%)
        ]"
      />

      <header className="relative z-10 w-full px-6 md:px-10 py-6 flex items-center justify-between border-b border-white/10">
        <h1 className="text-xl font-extrabold tracking-wide">
          Bot <span className="text-red-500">Visualization</span>
        </h1>
        <button
          onClick={() => navigate('/')}
          className="px-4 py-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 transition-colors"
        >
          Home
        </button>
      </header>

      <main className="relative z-10 flex-1 px-4 md:px-10 pb-10 overflow-y-auto">
        <div className="max-w-7xl mx-auto mt-6 space-y-6">
          {/* Controls */}
          <div className="rounded-2xl border border-white/10 bg-black/40 px-6 py-6">
            <h2 className="text-lg font-semibold mb-4">Visualization Controls</h2>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Bot Level */}
              <div>
                <label className="block text-sm text-zinc-400 mb-2">Bot Level</label>
                <select
                  value={botLevel}
                  onChange={(e) => setBotLevel(Number(e.target.value))}
                  className="w-full px-4 py-2 rounded-lg bg-zinc-900 border border-white/10 text-white"
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(level => (
                    <option key={level} value={level}>
                      Level {level} {level === 1 ? '(Beginner)' : level === 5 ? '(Expert)' : level === 9 ? '(Superhuman)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* Target Field */}
              <div>
                <label className="block text-sm text-zinc-400 mb-2">Field Type</label>
                <select
                  value={targetField}
                  onChange={(e) => setTargetField(e.target.value as 'T' | 'D' | 'S')}
                  className="w-full px-4 py-2 rounded-lg bg-zinc-900 border border-white/10 text-white"
                >
                  <option value="T">Triple</option>
                  <option value="D">Double</option>
                  <option value="S">Single</option>
                </select>
              </div>

              {/* Target Number */}
              <div>
                <label className="block text-sm text-zinc-400 mb-2">Target Number</label>
                <select
                  value={targetNumber}
                  onChange={(e) => setTargetNumber(Number(e.target.value))}
                  className="w-full px-4 py-2 rounded-lg bg-zinc-900 border border-white/10 text-white"
                >
                  {[20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 25].map(num => (
                    <option key={num} value={num}>
                      {num === 25 ? 'Bull (25)' : num}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Quick Targets */}
            <div className="mt-4">
              <label className="block text-sm text-zinc-400 mb-2">Quick Targets</label>
              <div className="flex flex-wrap gap-2">
                {commonTargets.map(target => (
                  <button
                    key={target.label}
                    onClick={() => {
                      setTargetField(target.field);
                      setTargetNumber(target.number);
                    }}
                    className="px-3 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-sm transition-colors"
                  >
                    {target.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Description */}
          <div className="rounded-2xl border border-white/10 bg-black/40 px-6 py-4">
            <p className="text-sm text-zinc-300">
              This visualization shows where a bot throws 50 darts when aiming for a specific target.
              <span className="text-green-400"> Green dots</span> are successful hits,
              <span className="text-red-400"> red dots</span> are misses.
              The <span className="text-yellow-400">yellow crosshair</span> shows the target location.
            </p>
          </div>

          {/* Visualization Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
            {/* Current Selection */}
            <BotDartVisualization
              botLevel={botLevel}
              targetField={targetField}
              targetNumber={targetNumber}
              numDarts={50}
              size={300}
              className="rounded-2xl border border-white/10 bg-black/40 px-6 py-6"
            />

            {/* Compare with other levels */}
            {botLevel > 1 && (
              <BotDartVisualization
                botLevel={botLevel - 3 > 0 ? botLevel - 3 : 1}
                targetField={targetField}
                targetNumber={targetNumber}
                numDarts={50}
                size={300}
                className="rounded-2xl border border-white/10 bg-black/40 px-6 py-6"
              />
            )}

            {botLevel < 9 && (
              <BotDartVisualization
                botLevel={botLevel + 2 <= 9 ? botLevel + 2 : 9}
                targetField={targetField}
                targetNumber={targetNumber}
                numDarts={50}
                size={300}
                className="rounded-2xl border border-white/10 bg-black/40 px-6 py-6"
              />
            )}
          </div>

          {/* Bot Level Info */}
          <div className="rounded-2xl border border-white/10 bg-black/40 px-6 py-6">
            <h3 className="text-lg font-semibold mb-3">Bot Level Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div>
                <div className="text-zinc-400">Levels 1-3</div>
                <div className="text-white">Beginner to Intermediate</div>
                <div className="text-xs text-zinc-500">~20-40 average</div>
              </div>
              <div>
                <div className="text-zinc-400">Levels 4-6</div>
                <div className="text-white">Advanced to Professional</div>
                <div className="text-xs text-zinc-500">~50-70 average</div>
              </div>
              <div>
                <div className="text-zinc-400">Levels 7-9</div>
                <div className="text-white">World Class to Superhuman</div>
                <div className="text-xs text-zinc-500">~80-100 average</div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}