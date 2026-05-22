import React, { useState, useEffect } from 'react';

interface DartPosition {
  x: number;
  y: number;
  number: number;
  field: string;
  targetX: number;
  targetY: number;
}

interface BotDartVisualizationProps {
  className?: string;
  size?: number;
  botLevel: number;
  targetField: string; // 'T', 'D', or 'S'
  targetNumber: number;
  numDarts?: number;
}

const BotDartVisualization: React.FC<BotDartVisualizationProps> = ({
  className = "",
  size = 340,
  botLevel,
  targetField,
  targetNumber,
  numDarts = 50,
}) => {
  const [dartPositions, setDartPositions] = useState<DartPosition[]>([]);

  // Dartboard dimensions in SVG coordinates
  const R = {
    outer: 100,
    doubleOuter: 85,
    doubleInner: 79,
    singleOuter: 66,
    trebleOuter: 54,
    trebleInner: 47,
    singleInner: 34,
    bullOuter: 12.7,
    bullInner: 6.35,
  };

  const ringColors = {
    singleDark: "#111111",
    singleLight: "#222222",
    doubleRed: "#d90429",
    doubleGreen: "#2ec27e",
    trebleRed: "#d90429",
    trebleGreen: "#2ec27e",
    bull: "#2ec27e",
    bullseye: "#d90429",
    white: "#f8fafc",
    black: "#0b0b0b",
  };

  const order = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  const seg = (Math.PI * 2) / 20;
  const rotationOffset = -Math.PI / 20;

  // Sigma values for bot levels (from bot implementation)
  const sigmaByLevel: { [key: number]: number } = {
    1: 5.0,
    2: 3.5,
    3: 2.5,
    4: 2.0,
    5: 1.6,
    6: 1.3,
    7: 1.0,
    8: 0.75,
    9: 0.5,
  };

  // BoardDim number order (different from display order)
  const boardNums = [20, 5, 12, 9, 14, 11, 8, 16, 7, 19, 3, 17, 2, 15, 10, 6, 13, 4, 18, 1];

  // Convert cm to SVG units (SVG outer = 100, real outer = 17cm)
  const CM_TO_SVG = 100 / 17.0;

  const getNumber = (x: number, y: number): [number, string] => {
    const angle = Math.atan2(y, x);
    const positiveAngle = angle < 0 ? angle + 2 * Math.PI : angle;
    const num = boardNums[Math.floor(positiveAngle / ((2 * Math.PI) / 20))];
    const radius = Math.sqrt(x * x + y * y);

    if (radius <= R.bullInner) return [25, 'D'];
    if (radius <= R.bullOuter) return [25, 'S'];
    if (radius > R.outer) return [0, 'S'];
    if (radius >= R.trebleInner && radius <= R.trebleOuter) return [num, 'T'];
    if (radius >= R.doubleInner && radius <= R.doubleOuter) return [num, 'D'];
    return [num, 'S'];
  };

  const generateDartPositions = () => {
    const sigma = sigmaByLevel[botLevel] || 1.75;
    const positions: DartPosition[] = [];

    // Calculate target position in cm
    let targetAngleCm = 0;
    let targetRadiusCm = 0;

    if (targetNumber === 25) {
      targetAngleCm = 0;
      targetRadiusCm = targetField === 'D' ? 0 : 1.59 * 0.75;
    } else {
      const index = boardNums.indexOf(targetNumber);
      targetAngleCm = index * ((2 * Math.PI) / 20) + ((2 * Math.PI) / 20) / 2;
      
      if (targetField === 'T') {
        targetRadiusCm = 10.7;
      } else if (targetField === 'D') {
        targetRadiusCm = 17.0;
      } else {
        targetRadiusCm = (10.7 + 17.0) / 2;
      }
    }

    const targetXCm = Math.cos(targetAngleCm) * targetRadiusCm;
    const targetYCm = Math.sin(targetAngleCm) * targetRadiusCm;

    // Convert target to SVG coordinates
    const targetXSvg = targetXCm * CM_TO_SVG;
    const targetYSvg = targetYCm * CM_TO_SVG;

    // Generate dart throws
    for (let i = 0; i < numDarts; i++) {
      // Box-Muller transform for Gaussian distribution
      const u1 = Math.random();
      const u2 = Math.random();
      const deviation = sigma * Math.sqrt(-2 * Math.log(u1));
      const offsetXCm = deviation * Math.cos(2 * Math.PI * u2);
      const offsetYCm = deviation * Math.sin(2 * Math.PI * u2);

      const xCm = targetXCm + offsetXCm;
      const yCm = targetYCm + offsetYCm;

      // Convert to SVG coordinates
      const xSvg = xCm * CM_TO_SVG;
      const ySvg = yCm * CM_TO_SVG;

      const [hitNumber, hitField] = getNumber(xSvg, ySvg);

      positions.push({
        x: xSvg,
        y: ySvg,
        number: hitNumber,
        field: hitField,
        targetX: targetXSvg,
        targetY: targetYSvg,
      });
    }

    setDartPositions(positions);
  };

  useEffect(() => {
    generateDartPositions();
  }, [botLevel, targetField, targetNumber, numDarts]);

  // Calculate hit statistics
  const hits = dartPositions.filter(d => d.number === targetNumber && d.field === targetField).length;
  const hitRate = dartPositions.length > 0 ? (hits / dartPositions.length * 100).toFixed(1) : '0.0';
  
  const singles = dartPositions.filter(d => d.field === 'S' && d.number !== 0).length;
  const doubles = dartPositions.filter(d => d.field === 'D').length;
  const triples = dartPositions.filter(d => d.field === 'T').length;
  const misses = dartPositions.filter(d => d.number === 0).length;

  const Wedge = ({ r1, r2, a0, a1, fill }: { r1: number; r2: number; a0: number; a1: number; fill: string }) => {
    const toXY = (r: number, a: number) => [r * Math.cos(a), r * Math.sin(a)];
    const [x0, y0] = toXY(r1, a0);
    const [x1, y1] = toXY(r1, a1);
    const [x2, y2] = toXY(r2, a1);
    const [x3, y3] = toXY(r2, a0);
    const largeArc = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
    const sweep = 1;
    const d = [
      `M ${x0} ${y0}`,
      `A ${r1} ${r1} 0 ${largeArc} ${sweep} ${x1} ${y1}`,
      `L ${x2} ${y2}`,
      `A ${r2} ${r2} 0 ${largeArc} ${sweep ^ 1} ${x3} ${y3}`,
      "Z",
    ].join(" ");
    return <path d={d} fill={fill} />;
  };

  const fieldName = targetField === 'T' ? 'Triple' : targetField === 'D' ? 'Double' : 'Single';

  return (
    <div className={className}>
      <svg viewBox="-110 -110 220 220" width={size} height={size}>
        {/* Dartboard background */}
        <circle r={R.outer} fill={ringColors.black} />
        
        {/* Singles */}
        {Array.from({ length: 20 }).map((_, i) => {
          const a0 = rotationOffset - Math.PI / 2 + i * seg;
          const a1 = a0 + seg;
          const isLight = i % 2 === 0;
          return (
            <g key={`singles-${i}`}>
              <Wedge r1={R.bullOuter} r2={R.trebleInner} a0={a0} a1={a1} fill={isLight ? ringColors.singleLight : ringColors.singleDark} />
              <Wedge r1={R.trebleOuter} r2={R.doubleInner} a0={a0} a1={a1} fill={isLight ? ringColors.singleLight : ringColors.singleDark} />
            </g>
          );
        })}
        
        {/* Doubles */}
        {Array.from({ length: 20 }).map((_, i) => {
          const a0 = rotationOffset - Math.PI / 2 + i * seg;
          const a1 = a0 + seg;
          const fill = i % 2 === 0 ? ringColors.doubleRed : ringColors.doubleGreen;
          return <Wedge key={`double-${i}`} r1={R.doubleInner} r2={R.doubleOuter} a0={a0} a1={a1} fill={fill} />;
        })}
        
        {/* Triples */}
        {Array.from({ length: 20 }).map((_, i) => {
          const a0 = rotationOffset - Math.PI / 2 + i * seg;
          const a1 = a0 + seg;
          const fill = i % 2 === 0 ? ringColors.trebleGreen : ringColors.trebleRed;
          return <Wedge key={`treble-${i}`} r1={R.trebleInner} r2={R.trebleOuter} a0={a0} a1={a1} fill={fill} />;
        })}
        
        {/* Bulls */}
        <circle r={R.bullOuter} fill={ringColors.bull} />
        <circle r={R.bullInner} fill={ringColors.bullseye} />
        <circle r={R.outer} fill="none" stroke="#0b0b0b" strokeWidth={2} />
        
        {/* Numbers */}
        {Array.from({ length: 20 }).map((_, i) => {
          const a = rotationOffset - Math.PI / 2 + i * seg + seg / 2;
          const r = 94;
          const x = r * Math.cos(a);
          const y = r * Math.sin(a);
          return (
            <text key={`n-${i}`} x={x} y={y + 3} textAnchor="middle" fontSize={8} fill={ringColors.white}>
              {order[i]}
            </text>
          );
        })}
        
        {/* Target crosshair */}
        {dartPositions.length > 0 && (
          <g>
            <circle cx={dartPositions[0].targetX} cy={dartPositions[0].targetY} r="3" fill="none" stroke="yellow" strokeWidth="1.5" opacity="0.8" />
            <line x1={dartPositions[0].targetX - 5} y1={dartPositions[0].targetY} x2={dartPositions[0].targetX + 5} y2={dartPositions[0].targetY} stroke="yellow" strokeWidth="1.5" opacity="0.8" />
            <line x1={dartPositions[0].targetX} y1={dartPositions[0].targetY - 5} x2={dartPositions[0].targetX} y2={dartPositions[0].targetY + 5} stroke="yellow" strokeWidth="1.5" opacity="0.8" />
          </g>
        )}
        
        {/* Dart positions */}
        {dartPositions.map((dart, i) => (
          <circle
            key={i}
            cx={dart.x}
            cy={dart.y}
            r="1.5"
            fill={dart.number === targetNumber && dart.field === targetField ? "#00ff00" : "#ff6b6b"}
            opacity="0.6"
          />
        ))}
      </svg>
      
      {/* Statistics */}
      <div className="mt-2 text-sm text-center">
        <div className="font-semibold">
          Bot Level {botLevel} - {fieldName} {targetNumber}
        </div>
        <div className="text-xs text-zinc-400 mt-1">
          Hit Rate: {hitRate}% | S:{singles} D:{doubles} T:{triples} Miss:{misses}
        </div>
      </div>
    </div>
  );
};

export default BotDartVisualization;