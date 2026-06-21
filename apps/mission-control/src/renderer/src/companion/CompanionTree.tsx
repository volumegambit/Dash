import { type AssignedLeaf, assignLeaves } from './leaves.js';
import type { CompanionStatus } from './types.js';

const LEAF_SLOTS = [
  { x: 24, y: 64 },
  { x: 104, y: 64 },
  { x: 48, y: 48 },
  { x: 96, y: 40 },
  { x: 72, y: 32 },
];

function Leaf({ slot, leaf }: { slot: { x: number; y: number }; leaf: AssignedLeaf }): JSX.Element {
  const { x, y } = slot;
  const { fill, hi, lo } = leaf.colors;
  return (
    <g className={leaf.pulse ? 'companion-pulse' : undefined}>
      <rect x={x} y={y} width={24} height={24} fill={fill} />
      <rect x={x} y={y} width={8} height={8} fill={hi} />
      <rect x={x + 16} y={y + 16} width={8} height={8} fill={lo} />
    </g>
  );
}

export function CompanionTree({
  statuses,
  size = 96,
}: {
  statuses: CompanionStatus[];
  size?: number;
}): JSX.Element {
  const leaves = assignLeaves(statuses);
  return (
    <svg
      width={size}
      viewBox="0 0 152 184"
      shapeRendering="crispEdges"
      style={{ imageRendering: 'pixelated' }}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
    >
      <title>Companion tree</title>
      <ellipse cx={76} cy={178} rx={46} ry={6} fill="#000" opacity={0.28} />
      <rect x={56} y={168} width={40} height={8} fill="#2f6b3a" />
      <rect x={72} y={104} width={8} height={68} fill="#5c4327" />
      <rect x={80} y={104} width={8} height={68} fill="#7a5a36" />
      <rect x={64} y={156} width={8} height={16} fill="#5c4327" />
      <rect x={88} y={156} width={8} height={16} fill="#7a5a36" />
      <g fill="#6b4f2f">
        <rect x={64} y={104} width={8} height={8} />
        <rect x={56} y={96} width={8} height={8} />
        <rect x={48} y={88} width={8} height={8} />
        <rect x={88} y={104} width={8} height={8} />
        <rect x={96} y={96} width={8} height={8} />
        <rect x={104} y={88} width={8} height={8} />
        <rect x={72} y={96} width={8} height={8} />
        <rect x={64} y={88} width={8} height={8} />
        <rect x={56} y={80} width={8} height={8} />
        <rect x={56} y={72} width={8} height={8} />
        <rect x={88} y={96} width={8} height={8} />
        <rect x={96} y={88} width={8} height={8} />
        <rect x={96} y={80} width={8} height={8} />
        <rect x={96} y={72} width={8} height={8} />
        <rect x={96} y={64} width={8} height={8} />
        <rect x={80} y={96} width={8} height={8} />
        <rect x={80} y={88} width={8} height={8} />
        <rect x={80} y={80} width={8} height={8} />
        <rect x={80} y={72} width={8} height={8} />
        <rect x={80} y={64} width={8} height={8} />
        <rect x={80} y={56} width={8} height={8} />
      </g>
      {LEAF_SLOTS.map((slot, i) => (
        <Leaf key={`${slot.x}-${slot.y}`} slot={slot} leaf={leaves[i]} />
      ))}
    </svg>
  );
}
