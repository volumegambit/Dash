import { type AssignedLeaf, assignLeaves } from './leaves.js';
import type { CompanionStatus } from './types.js';

/** One grid cell in SVG units — 2px cells on the 152x184 canvas (was 8px). */
export const CELL = 2;

/** Char → fill. '.' = transparent. Trunk has 3 shades now (t/T/u), canopy 2 (b/B). */
export const TREE_PALETTE: Record<string, string> = {
  t: '#5c4327', // trunk dark
  T: '#7a5a36', // trunk light
  u: '#8f6b40', // trunk highlight
  b: '#6b4f2f', // branch dark
  B: '#7d5d3a', // branch light
  g: '#2f6b3a', // ground
  G: '#3d8a4b', // ground highlight
  s: '#00000047', // shadow (28% black)
};

/**
 * The tree, one character per 2px cell, 76 wide x 92 tall. Authored art —
 * REQUIRED features (the tests + reviewer enforce): tapered trunk (wider at
 * the base than the crown), at least two asymmetric branch arms, a shapely
 * canopy silhouette (not a rectangle), a ground strip with highlight, and a
 * shadow ellipse row at the bottom. '.' is transparent.
 */
export const TREE_GRID: readonly string[] = [
  '............................................................................',
  '............................................................................',
  '................................................b...........................',
  '............................................bbbbbbbbb.......................',
  '......................................b...bbbbbbbbbbbbb.....................',
  '..............................b.bbbbbbbbbbbbbbbbbbbbbbbb....................',
  '..........................bbbbbbbbBbbbbbbbbbbbbbbbbbbbbbb...................',
  '........................bbbbbbbBBBBBBBbbbbbbbbbbbbbbbbbbbb..................',
  '.......................bbbbbbbBBBBBBBBBbbbbbbbbbbbbbbbbbbbb.................',
  '......................bbbbBBBBBBBBBBBBBBbbbbbbbbbbbbbbbbbbb.................',
  '.....................bbbBBBBBBBBBBBBBBBBbbbbbbbbbbbbbbbbbbbb................',
  '.....................bbBBBBBBBBBBBBBBBBBbbbbBbbbbbbbbbbbbbbb................',
  '....................bbBBBBBBBBBBBBBBBBBBBBBBBBBBBbbbbbbbbbbb................',
  '....................bbBBBBBBBBBBBBBBBBBBBBBBBBBBBBbbbbbbbbbb................',
  '....................bBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBbbbbbbbbbb...............',
  '....................bBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBbbbbbbbbbb..............',
  '...................bbBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBbbbbbbbbbbb............',
  '.................bbbbBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBbbbbbbbbbbbb...........',
  '...............bbbbbBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBbbbbbbbbbbbbb..........',
  '..............bbbBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBbbbbbbbbbbbbbb.........',
  '.............bbBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBbbbbbbbbbbbbb.........',
  '............bbBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBbbbbbbbbbbbbbbb........',
  '...........bbbBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBbbbbbbbbbbbbbbb........',
  '..........bbbBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBbbbbbbbbbbbbbbbb.......',
  '..........bbbBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBbbbbbbbbbbbbbbbb.......',
  '.........bbbbBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBbbbbbbbbbbbbbbb.......',
  '.........bbbBBBBBBBBBBBBBBBBBBBBBBBBBbBBBBBBBBBBBBBBBBBbbbbbbbbbbbbbb.......',
  '.........bbbbBBBBBBBBBBBBBBBBBBBBBBbbbbBBBBBBBBBBBBBBBBBbbbbbbbbbbbbb.......',
  '.........bbbbBBBBBBBBBBBBBBBbbBbbbbbbbbbBBBBBBBBBBBBBBBBbbbbbbbbbbbbbb......',
  '.........bbbbBBBBBBBBBBBBBBBbbbbbbbbbbbbbbbbBBBBBBBBBBBBbbbbbbbbbbbbb.......',
  '........bbbbbbBBBBBBBBBBBBBbbbbbbbbbbbbbbbbbBBBBBBBBBBBBBbbbbbbbbbbbb.......',
  '.........bbbbbBBBBBBBBBBBBBbbbbbbbbbbbbbbbbbbBBBBBBBBBBBbbbbbbbbbbbbb.......',
  '.........bbbbbbBBBBBBBBBBBbbbbbbbbbbbbbbbbbbbBBBBBBBBBBBbbbbbbbbbbbbb.......',
  '.........bbbbbbbbBBBBBBBbbbbbbbbbbbbbbbbbbbbbBBBBBBBBBBBbbbbbbbbbbbbb.......',
  '.........bbbbbbbbbbbBbbbbbbbbbbbbbbbbbbbbbbbbbBBBBBBBBBbbbbbbbbbBbbb........',
  '.........bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbBBBBBBBbbbbbbbbbbBbbb........',
  '..........bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbBbbbbbbbbbbbbbbbbbb.......',
  '.........bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.......',
  '.........bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.......',
  '.........bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.......',
  '........bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb......',
  '.........bbbbbbbbbbBBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.......',
  '.........bbbbbbbbbbbBBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.......',
  '.........bbbbbbbbbbbbbBBbbbb.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.......',
  '..........bbbbbbbbbbbbbbBB...bbbbbbbbbbbbbbbbbbbbbbbbbbBbbbbbbbbbbbbb.......',
  '..........bbbbbbbbbbbbbbbBB..bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbBbbbbbbbb........',
  '...........bbbbbbbbbbb..bbbB.bbbbbbbbbbbbbbbbbbbbbbb..bbbbbbbBbbbbb.........',
  '.............bbbbbbb......bbBBbbbbbbbbbbbbbbbbbbbbb....bbbbbbbBbbb..........',
  '................b..........bbBBbbbbbbbbbbbbbbbbbbbb.....bbbbbbbbb...........',
  '............................bbbBBbbbbbbbbbbbbbbbbb..........b...............',
  '..............................bbBBbuuTTTttbbbbbbb...........................',
  '...............................bbbBuuTTTttbbbbbb............................',
  '.................................bbuuTTTttbbbbb.............................',
  '..................................buuTTTTttbb...............................',
  '...................................uuTTTTtt.................................',
  '...................................uuTTTTtt.................................',
  '..................................uuTTTTttt.................................',
  '..................................uuTTTTTtt.................................',
  '..................................uuTTTTTTtt................................',
  '..................................uuTTTTTTtt................................',
  '..................................uuTTTTtTtt................................',
  '..................................uuTTTTTttt................................',
  '..................................uuTTTTTTtt................................',
  '..................................uuTTTTTTTtt...............................',
  '..................................uuTTTTtTTtt...............................',
  '..................................uuTTTTTtTtt...............................',
  '.................................uuTTTTTTTTtt...............................',
  '.................................uuTTTTTTTTtt...............................',
  '.................................uuTTTTTtTTTtt..............................',
  '.................................uuTTTTTTtTTtt..............................',
  '.................................uuuTTTTTTTTtt..............................',
  '.................................uuTTTTTTTTTtt..............................',
  '.................................uuTTTTTtTTTtt..............................',
  '.................................uuTTTTTTtTTTtt.............................',
  '.................................uuTTTTTTTTTTtt.............................',
  '................................uuTuTTTTTTTTTtt.............................',
  '................................uuTTTTTTtTTTTtt.............................',
  '................................uuTTTTTTTtTTTtt.............................',
  '................................uuTTTTTTTTTTTTtt............................',
  '................................uuTTTTTTTTTTTTtt............................',
  '................................uuTTTTTTTTTTTTtt............................',
  '................................uuTTTTTTTTTTTTtt............................',
  '..........................tTttttttTTTTTTTTTtttttTtt.........................',
  '..........................ttTtttttTTTTTTTTTttttTttt.........................',
  '........ggggGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGgggg.......',
  '..........ggggggGgggggGgggggGgggggGgggggGgggggGgggggGgggggGgggggggg.........',
  '............ggggggggggggggggggggggggggggggggggggggggggggggggggggg...........',
  '..............ggggggggggggggggggggggggggggggggggggggggggggggggg.............',
  '........................sssssssssssssssssssssssssssss.......................',
  '..................sssssssssssssssssssssssssssssssssssssssss.................',
  '............sssssssssssssssssssssssssssssssssssssssssssssssssssss...........',
  '............................................................................',
];

/** Leaf anchor points (SVG units, multiples of CELL), front-to-back. */
export const LEAF_SLOTS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 18, y: 62 },
  { x: 116, y: 58 },
  { x: 44, y: 44 },
  { x: 100, y: 38 },
  { x: 70, y: 28 },
  { x: 30, y: 78 },
  { x: 108, y: 76 },
  { x: 62, y: 50 },
];

function GridRects(): JSX.Element {
  const rects: JSX.Element[] = [];
  TREE_GRID.forEach((row, ry) => {
    // Run-length merge horizontally so the DOM stays small.
    let runStart = -1;
    let runChar = '';
    const flush = (endX: number): void => {
      if (runStart < 0) return;
      rects.push(
        <rect
          key={`${ry}-${runStart}`}
          x={runStart * CELL}
          y={ry * CELL}
          width={(endX - runStart) * CELL}
          height={CELL}
          fill={TREE_PALETTE[runChar]}
        />,
      );
      runStart = -1;
    };
    for (let rx = 0; rx < row.length; rx++) {
      const ch = row[rx];
      if (ch === runChar && runStart >= 0) continue;
      flush(rx);
      if (ch !== '.') {
        runStart = rx;
        runChar = ch;
      }
    }
    flush(row.length);
  });
  return <g shapeRendering="crispEdges">{rects}</g>;
}

function Leaf({ slot, leaf }: { slot: { x: number; y: number }; leaf: AssignedLeaf }): JSX.Element {
  const { x, y } = slot;
  const { fill, hi, lo } = leaf.colors;
  // 12x12 leaf cluster built from 2px cells (was a 24x24 block of 8px cells).
  return (
    <g className={leaf.pulse ? 'companion-pulse' : undefined}>
      <rect x={x} y={y} width={12} height={12} fill={fill} />
      <rect x={x} y={y} width={4} height={4} fill={hi} />
      <rect x={x + 8} y={y + 8} width={4} height={4} fill={lo} />
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
  const leaves = assignLeaves(statuses, LEAF_SLOTS.length);
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
      <GridRects />
      {LEAF_SLOTS.map((slot, i) => (
        <Leaf key={`${slot.x}-${slot.y}`} slot={slot} leaf={leaves[i]} />
      ))}
    </svg>
  );
}
