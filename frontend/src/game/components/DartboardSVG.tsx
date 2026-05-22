import React from "react";

function DartboardSVG({ className = "", size = 512 }) {
  const segments = Array.from({ length: 20 });
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
  } as const;

  const R = {
    outer: 100,
    doubleOuter: 85,
    doubleInner: 80,
    trebleOuter: 53.5,
    trebleInner: 49,
    bullOuter: 7.95,
    bullInner: 3.175,
  } as const;

  const order = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  const seg = (Math.PI * 2) / 20;
  const boardStart = -Math.PI / 2 - seg / 2;

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

  return (
    <svg className={className} viewBox="-110 -110 220 220" width={size} height={size}>
      <circle r={R.outer} fill={ringColors.black} />
      {segments.map((_, i) => {
        const a0 = boardStart + i * seg;
        const a1 = a0 + seg;
        const isLight = i % 2 === 0;
        return (
          <g key={`singles-${i}`}>
            <Wedge r1={R.bullOuter} r2={R.trebleInner} a0={a0} a1={a1} fill={isLight ? ringColors.singleLight : ringColors.singleDark} />
            <Wedge r1={R.trebleOuter} r2={R.doubleInner} a0={a0} a1={a1} fill={isLight ? ringColors.singleLight : ringColors.singleDark} />
          </g>
        );
      })}
      {segments.map((_, i) => {
        const a0 = boardStart + i * seg;
        const a1 = a0 + seg;
        const fill = i % 2 === 0 ? ringColors.doubleRed : ringColors.doubleGreen;
        return <Wedge key={`double-${i}`} r1={R.doubleInner} r2={R.doubleOuter} a0={a0} a1={a1} fill={fill} />;
      })}
      {segments.map((_, i) => {
        const a0 = boardStart + i * seg;
        const a1 = a0 + seg;
        const fill = i % 2 === 0 ? ringColors.trebleGreen : ringColors.trebleRed;
        return <Wedge key={`treble-${i}`} r1={R.trebleInner} r2={R.trebleOuter} a0={a0} a1={a1} fill={fill} />;
      })}

      <circle r={R.bullOuter} fill={ringColors.bull} />
      <circle r={R.bullInner} fill={ringColors.bullseye} />

      <circle r={R.outer} fill="none" stroke="#0b0b0b" strokeWidth={2} />

      {segments.map((_, i) => {
        const a = boardStart + i * seg + seg / 2;
        const r = 94;
        const x = r * Math.cos(a);
        const y = r * Math.sin(a);
        return (
          <text key={`n-${i}`} x={x} y={y + 3} textAnchor="middle" fontSize={8} fill={ringColors.white}>
            {order[i]}
          </text>
        );
      })}
    </svg>
  );
}

export default DartboardSVG;
