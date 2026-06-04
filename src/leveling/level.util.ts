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

export interface LevelTierStyle {
  bracket: number; // 0-based bracket index (0 = levels 1-10, 1 = 11-20, ...)
  name: string; // display name of the bracket
  minLevel: number; // first level of the bracket
  maxLevel: number; // last level of the bracket (null/large for the top)
  shape: string; // shape token for the frontend (e.g. 'circle', 'hexagon')
  color: string; // primary color (hex)
  colorSecondary: string; // accent / gradient end color (hex)
  glow: boolean; // whether the badge should glow (high brackets)
}

/**
 * Cosmetic style for a level, grouped in brackets of 10 levels.
 * Frontend renders badge color + shape from these tokens.
 *   1-10, 11-20, 21-30, 31-40, 41-50, 51-60, 61-70, 71-80, 81-90, 91-100, 101+
 */
const LEVEL_BRACKETS: Omit<LevelTierStyle, 'bracket' | 'minLevel' | 'maxLevel'>[] =
  [
    { name: 'Tân Binh', shape: 'circle', color: '#9CA3AF', colorSecondary: '#D1D5DB', glow: false },
    { name: 'Học Viên', shape: 'circle', color: '#22C55E', colorSecondary: '#86EFAC', glow: false },
    { name: 'Chiến Binh', shape: 'square', color: '#14B8A6', colorSecondary: '#5EEAD4', glow: false },
    { name: 'Kỵ Sĩ', shape: 'square', color: '#3B82F6', colorSecondary: '#93C5FD', glow: false },
    { name: 'Hiệp Sĩ', shape: 'shield', color: '#6366F1', colorSecondary: '#A5B4FC', glow: false },
    { name: 'Tinh Anh', shape: 'shield', color: '#8B5CF6', colorSecondary: '#C4B5FD', glow: true },
    { name: 'Cao Thủ', shape: 'hexagon', color: '#A855F7', colorSecondary: '#D8B4FE', glow: true },
    { name: 'Bậc Thầy', shape: 'hexagon', color: '#EC4899', colorSecondary: '#F9A8D4', glow: true },
    { name: 'Huyền Thoại', shape: 'star', color: '#F59E0B', colorSecondary: '#FCD34D', glow: true },
    { name: 'Á Thần', shape: 'star', color: '#EF4444', colorSecondary: '#FCA5A5', glow: true },
    { name: 'Thần Thoại', shape: 'crown', color: '#F43F5E', colorSecondary: '#FECDD3', glow: true },
  ];

export function levelStyle(level: number): LevelTierStyle {
  const L = Math.max(1, Math.floor(level));
  const bracket = Math.min(
    Math.floor((L - 1) / 10),
    LEVEL_BRACKETS.length - 1,
  );
  const def = LEVEL_BRACKETS[bracket];
  const minLevel = bracket * 10 + 1;
  // Top bracket is open-ended (101+).
  const isTop = bracket === LEVEL_BRACKETS.length - 1;
  const maxLevel = isTop ? Number.MAX_SAFE_INTEGER : (bracket + 1) * 10;
  return { bracket, minLevel, maxLevel, ...def };
}

export interface LevelProgress {
  level: number;
  xp: number;
  xpIntoLevel: number; // XP earned within the current level
  xpForNextLevel: number; // XP span of the current level (current -> next)
  xpToNextLevel: number; // XP still needed to reach the next level
  progress: number; // 0..1 fraction toward the next level
  style: LevelTierStyle; // cosmetic (color/shape) for the current bracket
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
    style: levelStyle(level),
  };
}
