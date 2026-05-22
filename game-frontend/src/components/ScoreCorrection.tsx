import React, { useState, useEffect } from 'react';

interface ScoreCorrectionProps {
  isOpen: boolean;
  onClose: () => void;
  dartIndex: number;
  originalScore: {
    score: number;
    multiplier: number;
    segment: string;
    zone: string;
  } | null;
  onSaveCorrection: (correction: {
    dartIndex: number;
    multiplier: number;
    segment: number;
    score: number;
  }) => void;
  onDeleteImages: (dartIndex: number) => void;
  onAddDart?: (correction: {
    dartIndex: number;
    multiplier: number;
    segment: number;
    score: number;
  }) => void;
}

const ScoreCorrection: React.FC<ScoreCorrectionProps> = ({
  isOpen,
  onClose,
  dartIndex,
  originalScore,
  onSaveCorrection,
  onDeleteImages,
  onAddDart,
}) => {
  const isAddMode = !originalScore && onAddDart;
  const [selectedMultiplier, setSelectedMultiplier] = useState<number>(1);
  const [selectedSegment, setSelectedSegment] = useState<number>(20);
  const [calculatedScore, setCalculatedScore] = useState<number>(20);

  // Reset state when modal opens (only when isOpen changes from false to true)
  useEffect(() => {
    if (isOpen) {
      if (originalScore) {
        // Set initial values based on original score
        const segmentNum = originalScore.segment === '0' ? 25 : parseInt(originalScore.segment);
        setSelectedSegment(segmentNum);
        setSelectedMultiplier(originalScore.multiplier);
        setCalculatedScore(originalScore.score);
      } else {
        // Default values if no original score
        setSelectedMultiplier(1);
        setSelectedSegment(20);
        setCalculatedScore(20);
      }
    }
    // Only run when isOpen changes, not when originalScore changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Calculate score when multiplier or segment changes
  useEffect(() => {
    // Special case for bull (25) and bullseye (50)
    if (selectedSegment === 25) {
      // For bull: multiplier 1 = outer bull (25), multiplier 2 = inner bull (50)
      setCalculatedScore(selectedMultiplier === 2 ? 50 : selectedMultiplier === 1 ? 25 : 0);
    } else if (selectedMultiplier === 0) {
      // Miss = 0 points
      setCalculatedScore(0);
    } else {
      setCalculatedScore(selectedSegment * selectedMultiplier);
    }
    
  }, [selectedMultiplier, selectedSegment, originalScore]);

  const handleSave = () => {
    const correction = {
      dartIndex,
      multiplier: selectedMultiplier,
      segment: selectedSegment,
      score: calculatedScore
    };
    
    if (isAddMode && onAddDart) {
      onAddDart(correction);
    } else {
      onSaveCorrection(correction);
    }
    onClose();
  };

  // Generate number buttons 1-20 plus bull (25)
  const renderNumberButtons = () => {
    const numbers = [...Array(20)].map((_, i) => i + 1);
    numbers.push(25); // Add bull
    
    return (
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mt-4">
        {numbers.map(num => (
          <button
            key={num}
            onClick={() => setSelectedSegment(num)}
            className={`py-2 px-3 rounded-lg text-lg font-semibold ${
              selectedSegment === num
                ? 'bg-red-600 text-white'
                : 'bg-gray-700 text-gray-200 hover:bg-gray-600'
            }`}
          >
            {num}
          </button>
        ))}
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-xl border border-gray-700 p-6 max-w-md w-full">
        <h2 className="text-2xl font-bold mb-2">
          {isAddMode ? 'Add Missed Dart' : 'Score Correction'}
        </h2>
        <p className="text-gray-400 mb-4">
          Dart {dartIndex + 1}
          {isAddMode && <span className="ml-2 text-yellow-400">(Not Detected)</span>}
        </p>
        
        {originalScore && (
          <div className="mb-4 p-3 bg-gray-800 rounded-lg">
            <p className="text-sm text-gray-400">Original Score:</p>
            <p className="text-xl font-bold">{originalScore.score}</p>
            <p className="text-sm text-gray-400">
              {originalScore.zone === 'single' ? '' : originalScore.zone} {originalScore.segment}
              {originalScore.zone !== 'single' && ` (${originalScore.multiplier}x)`}
            </p>
          </div>
        )}
        
        <div className="mb-4">
          <p className="text-sm text-gray-400 mb-2">Multiplier:</p>
          <div className="flex gap-2">
            <button
              onClick={() => setSelectedMultiplier(0)}
              className={`py-2 px-4 rounded-lg text-lg font-semibold ${
                selectedMultiplier === 0
                  ? 'bg-red-600 text-white'
                  : 'bg-gray-700 text-gray-200 hover:bg-gray-600'
              }`}
            >
              Miss
            </button>
            <button
              onClick={() => setSelectedMultiplier(1)}
              className={`py-2 px-4 rounded-lg text-lg font-semibold ${
                selectedMultiplier === 1
                  ? 'bg-red-600 text-white'
                  : 'bg-gray-700 text-gray-200 hover:bg-gray-600'
              }`}
            >
              Single
            </button>
            <button
              onClick={() => setSelectedMultiplier(2)}
              className={`py-2 px-4 rounded-lg text-lg font-semibold ${
                selectedMultiplier === 2
                  ? 'bg-red-600 text-white'
                  : 'bg-gray-700 text-gray-200 hover:bg-gray-600'
              }`}
            >
              Double
            </button>
            <button
              onClick={() => setSelectedMultiplier(3)}
              className={`py-2 px-4 rounded-lg text-lg font-semibold ${
                selectedMultiplier === 3
                  ? 'bg-red-600 text-white'
                  : 'bg-gray-700 text-gray-200 hover:bg-gray-600'
              }`}
            >
              Triple
            </button>
          </div>
        </div>
        
        <div className="mb-6">
          <p className="text-sm text-gray-400 mb-2">Number:</p>
          {renderNumberButtons()}
        </div>
        
        <div className="mb-6 p-4 bg-gray-800 rounded-lg text-center">
          <p className="text-sm text-gray-400">Final Score:</p>
          <p className="text-4xl font-bold">{calculatedScore}</p>
        </div>
        
        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="py-2 px-4 rounded-lg bg-gray-900 text-white hover:bg-gray-800"
          >
            Cancel
          </button>
          
          <button
            onClick={handleSave}
            className="py-2 px-4 rounded-lg bg-red-600 text-white hover:bg-red-700"
          >
            {isAddMode ? 'Add Dart' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ScoreCorrection;
