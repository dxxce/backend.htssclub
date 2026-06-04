import { levelFromXp, levelProgress, levelStyle, totalXpForLevel } from './level.util';

describe('level curve', () => {
  it('cumulative XP thresholds', () => {
    expect(totalXpForLevel(1)).toBe(0);
    expect(totalXpForLevel(2)).toBe(100);
    expect(totalXpForLevel(3)).toBe(300);
    expect(totalXpForLevel(4)).toBe(600);
    expect(totalXpForLevel(5)).toBe(1000);
  });

  it('levelFromXp maps correctly', () => {
    expect(levelFromXp(0)).toBe(1);
    expect(levelFromXp(99)).toBe(1);
    expect(levelFromXp(100)).toBe(2);
    expect(levelFromXp(299)).toBe(2);
    expect(levelFromXp(300)).toBe(3);
    expect(levelFromXp(1000)).toBe(5);
  });

  it('levelFromXp and totalXpForLevel are consistent', () => {
    for (let L = 1; L <= 30; L++) {
      const base = totalXpForLevel(L);
      const next = totalXpForLevel(L + 1);
      expect(levelFromXp(base)).toBe(L);
      expect(levelFromXp(next - 1)).toBe(L);
    }
  });

  it('progress within a level', () => {
    const p = levelProgress(150); // level 2 (base 100, next 300, span 200)
    expect(p.level).toBe(2);
    expect(p.xpIntoLevel).toBe(50);
    expect(p.xpForNextLevel).toBe(200);
    expect(p.xpToNextLevel).toBe(150);
    expect(p.progress).toBeCloseTo(0.25, 5);
  });

  it('exposes a cosmetic style per 10-level bracket', () => {
    expect(levelProgress(0).style.bracket).toBe(0); // L1 -> bracket 0
    const s1 = levelStyle(5);
    expect(s1.minLevel).toBe(1);
    expect(s1.maxLevel).toBe(10);
    expect(typeof s1.color).toBe('string');
    expect(typeof s1.shape).toBe('string');
    const s2 = levelStyle(11);
    expect(s2.bracket).toBe(1);
    expect(s2.color).not.toBe(s1.color); // different bracket -> different color
  });

  it('handles zero / negative xp', () => {
    expect(levelProgress(0).level).toBe(1);
    expect(levelProgress(-5).level).toBe(1);
    expect(levelProgress(0).progress).toBeGreaterThanOrEqual(0);
  });
});
