/**
 * XP / level curve.
 *
 * Cumulative XP required to REACH a given level:
 *   totalXpForLevel(L) = 50 * L * (L - 1)
 * i.e. each step from level L -> L+1 costs 100 * L XP.
 *   L1 = 0, L2 = 100, L3 = 300, L4 = 600, L5 = 1000, ...
 */

export function totalXpForLevel(level: number): number {
  if (level <= 1) return 0;
  return 50 * level * (level - 1);
}

/** The level a given total XP corresponds to (>= 1). */
export function levelFromXp(xp: number): number {
  if (xp <= 0) return 1;
  // Solve 50*L^2 - 50*L - xp <= 0  ->  L = floor((50 + sqrt(2500 + 200*xp)) / 100)
  const level = Math.floor((50 + Math.sqrt(2500 + 200 * xp)) / 100);
  return Math.max(1, level);
}

export interface LevelProgress {
  level: number;
  xp: number;
  xpIntoLevel: number; // XP earned within the current level
  xpForNextLevel: number; // XP span of the current level (current -> next)
  xpToNextLevel: number; // XP still needed to reach the next level
  progress: number; // 0..1 fraction toward the next level
}

export function levelProgress(xp: number): LevelProgress {
  const safeXp = Math.max(0, Math.floor(xp));
  const level = levelFromXp(safeXp);
  const base = totalXpForLevel(level);
  const next = totalXpForLevel(level + 1);
  const span = next - base;
  const into = safeXp - base;
  return {
    level,
    xp: safeXp,
    xpIntoLevel: into,
    xpForNextLevel: span,
    xpToNextLevel: Math.max(0, next - safeXp),
    progress: span > 0 ? Math.min(1, into / span) : 0,
  };
}
