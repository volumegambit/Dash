import type { JSX } from 'react';
import { gridRects } from './gridRects.js';
import type { Mood, PetSprite } from './types.js';

/** One grid cell in SVG units. */
export const CELL = 2;

/**
 * Merge a pet's base grid with a mood's overlay cells, and resolve the collar
 * char 'C' to the mood's collar color. Returns the effective grid + palette.
 */
export function composeGrid(
  sprite: PetSprite,
  mood: Mood,
): { grid: string[]; palette: Record<string, string> } {
  const layer = sprite.moods[mood];
  const rows = sprite.grid.map((r) => r.split(''));
  for (const [coord, ch] of Object.entries(layer.cells)) {
    const [x, y] = coord.split(',').map(Number);
    if (rows[y] !== undefined && x >= 0 && x < rows[y].length) rows[y][x] = ch;
  }
  return { grid: rows.map((r) => r.join('')), palette: { ...sprite.palette, C: layer.collar } };
}

export function PixelPet({
  sprite,
  mood,
  size = 128,
}: {
  sprite: PetSprite;
  mood: Mood;
  size?: number;
}): JSX.Element {
  const { grid, palette } = composeGrid(sprite, mood);
  const width = grid[0]?.length ?? 0;
  const height = grid.length;
  const rects = gridRects(grid, palette, CELL);
  return (
    <svg
      width={size}
      viewBox={`0 0 ${width * CELL} ${height * CELL}`}
      shapeRendering="crispEdges"
      style={{ imageRendering: 'pixelated' }}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      className={sprite.moods[mood].pulse ? 'companion-pulse' : undefined}
    >
      <title>{sprite.name}</title>
      {rects.map((r) => (
        <rect
          key={`${r.x}-${r.y}`}
          x={r.x}
          y={r.y}
          width={r.width}
          height={r.height}
          fill={r.fill}
        />
      ))}
    </svg>
  );
}
