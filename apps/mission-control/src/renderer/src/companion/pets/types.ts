import type { PetKind } from '../../../../shared/ipc.js';

export type { PetKind };

/** Aggregate widget mood. `idle` = no sessions; the other four mirror CompanionStatus. */
export type Mood = 'idle' | 'working' | 'needs' | 'done' | 'error';

/** Per-mood presentation layer applied over a pet's base grid. */
export interface PetMoodLayer {
  /** Collar-tag fill for this mood (the char 'C' resolves to this at render time). */
  collar: string;
  /** Cells painted over the base grid: key `"x,y"` (grid coords) -> palette/collar char. */
  cells: Record<string, string>;
  /** When true, the whole sprite animates with the companion-pulse keyframe. */
  pulse?: boolean;
}

/** A pet's full sprite definition: one base grid + palette + one layer per mood. */
export interface PetSprite {
  kind: PetKind;
  /** Human label for the picker (e.g. "Cat", "Red panda"). */
  name: string;
  /**
   * Base pixel grid, one char per 2px cell, rows all equal width. '.' is
   * transparent. The reserved char 'C' marks collar cells (recolored per mood);
   * 'C' must NOT appear in `palette`.
   */
  grid: readonly string[];
  /** char -> hex fill. Excludes '.' and 'C'. */
  palette: Record<string, string>;
  /** Exactly the five moods. */
  moods: Record<Mood, PetMoodLayer>;
}

/** Per-mood animation for a frame-based pet: data-URI frames played on a loop. */
export interface PetMoodAnimation {
  /** PNG data URIs, in playback order. Always at least one frame. */
  frames: readonly string[];
  /** Playback speed in frames per second (default 8). */
  fps?: number;
  /**
   * Mood accent color, shown as a badge dot beside the pet — the frame-based
   * counterpart of {@link PetMoodLayer.collar}, using the same per-mood hues.
   */
  collar: string;
}

/** A pet rendered from pre-generated bitmap frames (e.g. PixelLab) instead of a grid. */
export interface AnimatedPetSprite {
  kind: PetKind;
  /** Human label for the picker (e.g. "Red panda"). */
  name: string;
  /** Exactly the five moods. */
  moods: Record<Mood, PetMoodAnimation>;
}

export type AnyPetSprite = PetSprite | AnimatedPetSprite;

/** Grid pets have a `grid`; frame-based pets don't. */
export function isAnimatedPetSprite(sprite: AnyPetSprite): sprite is AnimatedPetSprite {
  return !('grid' in sprite);
}
