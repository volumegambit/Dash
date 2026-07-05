import type { PetKind } from '../../../../shared/ipc.js';

export type { PetKind };

/** Aggregate widget mood. `idle` = no sessions; the other four mirror CompanionStatus. */
export type Mood = 'idle' | 'working' | 'needs' | 'done' | 'error';

/**
 * Shared mood palette: the collar badge hue every pet shows for each mood.
 * These are the hues documented in TEST_PLAN §30 — change them together.
 */
export const MOOD_COLLARS: Record<Mood, string> = {
  idle: '#9aa0a6',
  working: '#3da5d9',
  needs: '#f5c518',
  done: '#34c759',
  error: '#f87171',
};

/** Per-mood animation for a frame-based pet: data-URI frames played on a loop. */
export interface PetMoodAnimation {
  /** PNG data URIs, in playback order. Always at least one frame. */
  frames: readonly string[];
  /** Playback speed in frames per second (default 8). */
  fps?: number;
  /** Mood accent color, shown as a badge dot beside the pet (see {@link MOOD_COLLARS}). */
  collar: string;
}

/** A pet rendered from pre-generated bitmap frames (e.g. PixelLab). */
export interface AnimatedPetSprite {
  kind: PetKind;
  /** Human label for the picker (e.g. "Red panda"). */
  name: string;
  /** Exactly the five moods. */
  moods: Record<Mood, PetMoodAnimation>;
}
