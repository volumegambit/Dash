export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
}

/**
 * Render a character grid to run-length-merged rects. '.' and any char not in
 * `palette` are transparent (no rect). Adjacent equal cells merge horizontally
 * so the DOM stays small. Coordinates are multiplied by `cell` (SVG units).
 */
export function gridRects(
  grid: readonly string[],
  palette: Record<string, string>,
  cell: number,
): PixelRect[] {
  const rects: PixelRect[] = [];
  grid.forEach((row, ry) => {
    let runStart = -1;
    let runChar = '';
    const flush = (endX: number): void => {
      if (runStart < 0) return;
      rects.push({
        x: runStart * cell,
        y: ry * cell,
        width: (endX - runStart) * cell,
        height: cell,
        fill: palette[runChar],
      });
      runStart = -1;
    };
    for (let rx = 0; rx < row.length; rx++) {
      const ch = row[rx];
      if (ch === runChar && runStart >= 0) continue;
      flush(rx);
      if (ch !== '.' && palette[ch] !== undefined) {
        runStart = rx;
        runChar = ch;
      } else {
        runChar = '';
      }
    }
    flush(row.length);
  });
  return rects;
}
