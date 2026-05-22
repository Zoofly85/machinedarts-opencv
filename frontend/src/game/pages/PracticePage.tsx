import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import Logo from '../components/Logo';
import ScoreCorrection from '../components/ScoreCorrection';
import GameRecalibrateButton from '../components/game/GameRecalibrateButton';
import { subscribeDetection, onDetectionOpen, onDetectionClose, onDetectionError } from '../services/detectionSocket';
import { API_BASE_URL } from "../../services/api";

const API_URL = API_BASE_URL;

interface DetectionStatus {
  is_active: boolean;
  dart_count: number;
  has_background: boolean;
}

interface DartScore {
  score: number;
  multiplier: number;
  segment: string;
  zone: string;
  confidence: number;
}

export default function PracticePage() {
  const navigate = useNavigate();
  const [dartCount, setDartCount] = useState(0);
  const [detectionState, setDetectionState] = useState<string>("no_movement");
  const [currentImage, setCurrentImage] = useState<string | null>(null);
  const [scores, setScores] = useState<(DartScore | null)[]>([]);
  const [totalScore, setTotalScore] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedCamera, setSelectedCamera] = useState(0);
  const scoreRetryRef = useRef<number | null>(null);
  const glowStyle = useCallback(() => {
    if (detectionState === "removing_darts") {
      return { boxShadow: "0 0 38px 18px rgba(59, 130, 246, 0.85), 0 0 70px 28px rgba(59, 130, 246, 0.45)" };
    }
    if (detectionState === "partial_takeout") {
      return { boxShadow: "0 0 38px 18px rgba(250, 204, 21, 0.9), 0 0 70px 28px rgba(250, 204, 21, 0.5)" };
    }
    return { boxShadow: "0 0 36px 16px rgba(239, 68, 68, 0.9), 0 0 64px 26px rgba(239, 68, 68, 0.5)" };
  }, [detectionState]);
  
  // Enable detection images while on Practice page
  useEffect(() => {
    let cancelled = false;
    const enable = async () => {
      try {
        await fetch(`${API_URL}/api/detection/image/enable`, { method: 'POST' });
        await fetch(`${API_URL}/api/detection/preview_camera`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ camera_index: selectedCamera }),
        });
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to enable detection images', err);
        }
      }
    };
    enable();
    return () => {
      cancelled = true;
      fetch(`${API_URL}/api/detection/image/disable`, { method: 'POST' }).catch(() => {});
    };
  }, [selectedCamera]);

  // Score correction state
  const [isCorrectionModalOpen, setIsCorrectionModalOpen] = useState(false);
  const [selectedDartIndex, setSelectedDartIndex] = useState<number>(-1);
  const lastDartCountRef = useRef<number>(0);

  const fetchImageForSettings = useCallback(async () => {
    try {
      const imageResponse = await fetch(`${API_URL}/api/detection/image?view=fronton&camera_index=${selectedCamera}`);
      const imageData = await imageResponse.json();
      if (imageData.image) {
        setCurrentImage(`data:image/jpeg;base64,${imageData.image}`);
      } else {
        setCurrentImage(null);
      }
    } catch (err) {
      console.error('Error fetching image:', err);
    }
  }, [selectedCamera]);

  const updateScoresFromApi = useCallback(async () => {
    const scoresResponse = await fetch(`${API_URL}/api/detection/scores?raw=true`);
    const scoresData = await scoresResponse.json();
    setScores(scoresData.scores);
    const total = scoresData.scores.reduce((sum: number, score: DartScore | null) => {
      if (score) {
        return sum + score.score;
      }
      return sum;
    }, 0);
    setTotalScore(total);
    return scoresData.scores as (DartScore | null)[];
  }, []);

  const scheduleScoreRetry = useCallback(
    (dartIndex: number, attempt: number) => {
      if (attempt <= 0) return;
      if (scoreRetryRef.current) {
        window.clearTimeout(scoreRetryRef.current);
      }
      scoreRetryRef.current = window.setTimeout(async () => {
        try {
          const latest = await updateScoresFromApi();
          const scoreReady = dartIndex < latest.length && latest[dartIndex] !== null;
          if (!scoreReady) {
            scheduleScoreRetry(dartIndex, attempt - 1);
          }
        } catch (err) {
          console.error("Error fetching updated scores:", err);
        }
      }, 250);
    },
    [updateScoresFromApi]
  );

  const applyScoreEvent = useCallback((data: Record<string, any>) => {
    const dartIndex = Math.max(0, Math.min(2, Number(data.dart_index ?? 1) - 1));
    const rawScore = data.score && typeof data.score === "object" ? data.score : {};
    const scoreValue = Number(data.score_value ?? rawScore.score ?? 0) || 0;
    const score: DartScore = {
      score: scoreValue,
      multiplier: Number(rawScore.multiplier ?? 1) || 1,
      segment: String(rawScore.segment ?? (scoreValue > 0 ? scoreValue : 0)),
      zone: String(rawScore.zone ?? (scoreValue <= 0 ? "miss" : "single")),
      confidence: Number(rawScore.confidence ?? data.votes ?? 1) || 1,
    };

    setScores((prev) => {
      const next: (DartScore | null)[] = [prev[0] ?? null, prev[1] ?? null, prev[2] ?? null];
      next[dartIndex] = score;
      setTotalScore(next.reduce((sum, item) => sum + (item?.score ?? 0), 0));
      return next;
    });

    if (scoreRetryRef.current) {
      window.clearTimeout(scoreRetryRef.current);
      scoreRetryRef.current = null;
    }
  }, []);

  // Subscribe to shared detection WebSocket
  useEffect(() => {
    const unsubscribe = subscribeDetection(async (data) => {
      if (typeof data.dart_count === "number") {
        setDartCount(data.dart_count);
      }
      if (typeof data.detection_state === "string") {
        setDetectionState(data.detection_state);
      }
      
      if (data.event === 'dart_detected') {
        if (data.image) {
          setCurrentImage(`data:image/jpeg;base64,${data.image}`);
        } else {
          await fetchImageForSettings();
        }
      } else if (data.event === 'dart_score') {
        applyScoreEvent(data);
      } else if (data.event === 'dart_score_unavailable') {
        const targetIndex = Math.max(0, Math.min(2, Number(data.dart_index ?? dartCount ?? 1) - 1));
        scheduleScoreRetry(targetIndex, 3);
      } else if (data.event === 'darts_removed') {
        if (data.image) {
          setCurrentImage(`data:image/jpeg;base64,${data.image}`);
        } else {
          await fetchImageForSettings();
        }
        
        setScores([]);
        setTotalScore(0);
      } else if (data.event === 'detection_status_update') {
        if (typeof data.dart_count === "number" && data.dart_count !== lastDartCountRef.current) {
          lastDartCountRef.current = data.dart_count;
        }
      }
    });

    const offOpen = onDetectionOpen(() => {
      setError(null);
    });
    const offClose = onDetectionClose(() => {
      setError('WebSocket disconnected');
    });
    const offError = onDetectionError(() => {
      setError('WebSocket connection error');
    });
    
    // Cleanup on unmount
    return () => {
      unsubscribe();
      offOpen();
      offClose();
      offError();
      if (scoreRetryRef.current) {
        window.clearTimeout(scoreRetryRef.current);
      }
    };
  }, [applyScoreEvent, dartCount, fetchImageForSettings, scheduleScoreRetry]);

  useEffect(() => {
    fetchImageForSettings();
  }, [fetchImageForSettings]);

  // Fetch initial status and image
  useEffect(() => {
    const fetchInitialData = async () => {
      try {
        setIsLoading(true);
        
        // Get detection status
        const statusResponse = await fetch(`${API_URL}/api/detection/status`);
        const statusData = await statusResponse.json();
        setDartCount(statusData.dart_count);
        
        // Get scores if darts are present
        if (statusData.dart_count > 0) {
          const scoresResponse = await fetch(`${API_URL}/api/detection/scores?raw=true`);
          const scoresData = await scoresResponse.json();
          setScores(scoresData.scores);
          
          // Calculate total score
          const total = scoresData.scores.reduce((sum: number, score: DartScore | null) => {
            if (score) {
              return sum + score.score; // Score already includes multiplier
            }
            return sum;
          }, 0);
          setTotalScore(total);
        }
      } catch (err) {
        console.error('Error fetching initial data:', err);
        setError('Failed to load initial data');
      } finally {
        setIsLoading(false);
      }
    };
    
    fetchInitialData();
  }, []);

  // Reset detection (clear dart count and scores)
  const resetDetection = async () => {
    try {
      setIsLoading(true);
      const response = await fetch(`${API_URL}/api/detection/reset`, {
        method: 'POST',
      });
      const data = await response.json();
      
      if (data.status === 'reset') {
        setDartCount(0);
        setScores([]);
        setTotalScore(0);
        
        await fetchImageForSettings();
      } else {
        setError(data.message || 'Failed to reset detection');
      }
    } catch (err) {
      console.error('Error resetting detection:', err);
      setError('Failed to reset detection');
    } finally {
      setIsLoading(false);
    }
  };

  // Handle opening the score correction modal
  const handleOpenCorrection = (dartIndex: number) => {
    setSelectedDartIndex(dartIndex);
    setIsCorrectionModalOpen(true);
  };

  // Handle saving a score correction
  const handleSaveCorrection = async (correction: {
    dartIndex: number;
    multiplier: number;
    segment: number;
    score: number;
  }) => {
    try {
      setIsLoading(true);
      const response = await fetch(`${API_URL}/api/correction/score`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(correction),
      });
      
      const data = await response.json();
      
      if (data.status === 'success') {
        // Update scores with the corrected score
        const newScores = [...scores];
        newScores[correction.dartIndex] = {
          score: correction.score,
          multiplier: correction.multiplier,
          segment: correction.segment.toString(),
          zone: correction.multiplier === 2 ? 'double' :
                correction.multiplier === 3 ? 'triple' :
                correction.segment === 25 ? (correction.multiplier === 2 ? 'inner_bull' : 'outer_bull') :
                'single',
          confidence: 1.0 // Manual correction has 100% confidence
        };
        
        setScores(newScores);
        
        // Recalculate total score
        const total = newScores.reduce((sum: number, score: DartScore | null) => {
          if (score) {
            return sum + score.score;
          }
          return sum;
        }, 0);
        
        setTotalScore(total);
      } else {
        setError(data.message || 'Failed to save correction');
      }
    } catch (err) {
      console.error('Error saving correction:', err);
      setError('Failed to save correction');
    } finally {
      setIsLoading(false);
    }
  };
  // Handle adding a manual dart (when system missed it)
  const handleAddDart = async (correction: {
    dartIndex: number;
    multiplier: number;
    segment: number;
    score: number;
  }) => {
    try {
      setIsLoading(true);
      const response = await fetch(`${API_URL}/api/correction/add-dart`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(correction),
      });
      
      const data = await response.json();
      
      if (data.status === 'success') {
        // Update scores with the added dart
        const newScores = [...scores];
        newScores[correction.dartIndex] = {
          score: correction.score,
          multiplier: correction.multiplier,
          segment: correction.segment.toString(),
          zone: correction.multiplier === 2 ? 'double' :
                correction.multiplier === 3 ? 'triple' :
                correction.segment === 25 ? (correction.multiplier === 2 ? 'inner_bull' : 'outer_bull') :
                'single',
          confidence: 1.0 // Manual entry has 100% confidence
        };
        
        setScores(newScores);
        
        // Recalculate total score
        const total = newScores.reduce((sum: number, score: DartScore | null) => {
          if (score) {
            return sum + score.score;
          }
          return sum;
        }, 0);
        
        setTotalScore(total);
      } else {
        setError(data.message || 'Failed to add dart');
      }
    } catch (err) {
      console.error('Error adding dart:', err);
      setError('Failed to add dart');
    } finally {
      setIsLoading(false);
    }
  };


  // Handle deleting images when score is confirmed correct
  const handleDeleteImages = async (dartIndex: number) => {
    try {
      setIsLoading(true);
      const response = await fetch(`${API_URL}/api/correction/delete-images`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ dartIndex }),
      });
      
      const data = await response.json();
      
      if (data.status !== 'success') {
        setError(data.message || 'Failed to delete images');
      }
    } catch (err) {
      console.error('Error deleting images:', err);
      setError('Failed to delete images');
    } finally {
      setIsLoading(false);
    }
  };

  // Render dart scores
  const renderScores = () => {
    return (
      <div className="grid grid-cols-3 gap-4 mt-4">
        {[0, 1, 2].map((index) => {
          const score = scores[index];
          return (
            <div
              key={index}
              className={`p-4 rounded-lg ${score ? 'bg-red-900/30 hover:bg-red-800/40' : 'bg-gray-800/30 hover:bg-gray-700/40'} border ${score ? 'border-red-700' : 'border-gray-700'} cursor-pointer transition-colors`}
              onClick={() => handleOpenCorrection(index)}
            >
              <h3 className="text-lg font-semibold mb-1">Dart {index + 1}</h3>
              {score ? (
                <div>
                  <p className="text-3xl font-bold">{score.score}</p>
                  <p className="text-sm text-gray-400">
                    {score.zone === 'single' ? '' : score.zone} {score.segment}
                    {score.zone !== 'single' && ` (${score.multiplier}x)`}
                  </p>
                </div>
              ) : (
                <p className="text-gray-500">No dart - Click to add</p>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="h-dvh w-full bg-black text-white relative overflow-hidden flex flex-col">
      {/* Reflective glossy edges */}
      <div className="pointer-events-none fixed inset-0 [background:
        radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.12),transparent_60%),
        radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_70%),
        radial-gradient(ellipse_at_bottom_left,rgba(255,255,255,0.06),transparent_70%),
        radial-gradient(ellipse_at_bottom_right,rgba(255,255,255,0.1),transparent_65%),
        linear-gradient(135deg,rgba(255,255,255,0.05),rgba(0,0,0,0.95) 30%,rgba(255,255,255,0.04) 60%,rgba(0,0,0,1) 100%)
      ]" />

      <header className="relative z-10 w-full px-6 md:px-10 py-4 flex items-center justify-between flex-shrink-0">
        <Logo />
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800/50 hover:bg-gray-700/50 transition-colors"
        >
          <ArrowLeft size={18} />
          <span>Home</span>
        </button>
      </header>

      <main className="relative z-10 w-full px-6 md:px-10 py-4 flex-1 overflow-hidden min-h-0">
        <div className="max-w-7xl mx-auto h-full flex flex-col">
          <h1 className="text-3xl font-bold mb-4 flex-shrink-0">Practice Mode</h1>
          
          {error && (
            <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 mb-6">
              <p className="text-red-300">{error}</p>
              <button 
                onClick={() => setError(null)} 
                className="text-sm text-red-400 hover:text-red-300 mt-2"
              >
                Dismiss
              </button>
            </div>
          )}
          
          <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6 flex-1 min-h-0">
            {/* Left column - Dartboard image */}
            <div className="bg-gray-900/50 rounded-xl p-4 border border-gray-800 flex flex-col min-h-0">
              <h2 className="text-xl font-semibold mb-3 flex-shrink-0">Dartboard</h2>
              <div className="flex-1 bg-black rounded-lg overflow-hidden flex items-center justify-center min-h-0 p-6">
                {currentImage ? (
                  <div className="relative w-full h-full flex items-center justify-center">
                    <div
                      className="relative w-full h-full rounded-2xl overflow-hidden bg-black flex items-center justify-center"
                      style={glowStyle()}
                    >
                      <img 
                        src={currentImage} 
                        alt="Dartboard" 
                        className="max-w-full max-h-full w-auto h-auto object-contain"
                      />
                    </div>
                  </div>
                ) : (
                  <p className="text-gray-500">No image available</p>
                )}
              </div>
              <div className="mt-3 flex flex-col gap-2 md:flex-row md:justify-between md:items-center flex-shrink-0">
                <div className="text-base">
                  <span className="text-gray-400">Darts: </span>
                  <span className="font-semibold">{dartCount}/3</span>
                </div>
                <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
                  <div className="flex gap-2 bg-gray-900/50 rounded-lg p-1 border border-gray-800">
                    {[0, 1, 2].map((cam) => (
                      <button
                        key={cam}
                        onClick={() => setSelectedCamera(cam)}
                        className={`px-3 py-1 rounded-md text-sm transition-colors ${
                          selectedCamera === cam
                            ? 'bg-purple-600 text-white border border-purple-300'
                            : 'bg-transparent text-gray-300 border border-transparent hover:border-gray-600'
                        }`}
                      >
                        Cam {cam + 1}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={resetDetection}
                    disabled={isLoading || dartCount === 0}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-900/50 hover:bg-blue-800/50 transition-colors disabled:opacity-50 text-sm"
                  >
                    <RefreshCw size={16} />
                    <span>Clear Board</span>
                  </button>
                  <GameRecalibrateButton className="justify-center bg-blue-900/50 hover:bg-blue-800/50" />
                </div>
              </div>
            </div>
            
            {/* Right column - Scores */}
            <div className="bg-gray-900/50 rounded-xl p-4 border border-gray-800 flex flex-col min-h-0">
              <h2 className="text-xl font-semibold mb-3 flex-shrink-0">Scores</h2>
              <div className="flex-1 flex flex-col justify-between min-h-0">
                {renderScores()}
                
                {/* Detection Status */}
                <div className="mt-4 grid grid-cols-2 gap-4 text-xs flex-shrink-0">
                  <div className="flex flex-col gap-1">
                    <span className="text-zinc-500 uppercase tracking-wider">Turn Status</span>
                    <span className="text-white font-semibold">
                      {scores.filter(d => d !== null).length}/3 darts thrown
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-zinc-500 uppercase tracking-wider">Detection</span>
                    <span className="text-white font-semibold">
                      {dartCount > 0 ? `${dartCount} detected` : 'Ready'}
                    </span>
                  </div>
                  {detectionState === "removing_darts" && (
                    <div className="flex flex-col gap-1 col-span-2">
                      <span className="text-blue-400 uppercase tracking-wider font-semibold">
                        🔄 Removing darts...
                      </span>
                    </div>
                  )}
                  {detectionState === "partial_takeout" && (
                    <div className="flex flex-col gap-1 col-span-2">
                      <span className="text-yellow-400 uppercase tracking-wider font-semibold">
                        ⚠️ Partial takeout detected - Remove remaining darts
                      </span>
                    </div>
                  )}
                </div>
                
                <div className="mt-4 p-3 bg-gray-800/50 rounded-lg border border-gray-700 flex-shrink-0">
                  <div className="flex justify-between items-center">
                    <span className="text-xl">Total Score:</span>
                    <span className="text-3xl font-bold">{totalScore}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Score Correction Modal */}
      <ScoreCorrection
        isOpen={isCorrectionModalOpen}
        onClose={() => setIsCorrectionModalOpen(false)}
        dartIndex={selectedDartIndex}
        originalScore={selectedDartIndex >= 0 ? scores[selectedDartIndex] : null}
        onSaveCorrection={handleSaveCorrection}
        onDeleteImages={handleDeleteImages}
        onAddDart={handleAddDart}
      />
    </div>
  );
}
