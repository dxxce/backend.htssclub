import { drawOutcome, eloDelta, rankedOutcome } from './elo.util';

describe('eloDelta', () => {
  it('equal ratings: winner gains ~half of K, loser loses ~half', () => {
    expect(eloDelta(1000, 1000, 1)).toBe(16); // K=32, expected 0.5
    expect(eloDelta(1000, 1000, 0)).toBe(-16);
  });

  it('beating a much stronger opponent yields a bigger gain', () => {
    const gainVsStronger = eloDelta(1000, 1400, 1);
    const gainVsEqual = eloDelta(1000, 1000, 1);
    expect(gainVsStronger).toBeGreaterThan(gainVsEqual);
  });

  it('beating a much weaker opponent yields a smaller gain', () => {
    const gainVsWeaker = eloDelta(1400, 1000, 1);
    const gainVsEqual = eloDelta(1000, 1000, 1);
    expect(gainVsWeaker).toBeLessThan(gainVsEqual);
  });
});

describe('rankedOutcome', () => {
  it('winner gains, loser loses', () => {
    const { winnerDelta, loserDelta } = rankedOutcome(1000, 1000);
    expect(winnerDelta).toBeGreaterThan(0);
    expect(loserDelta).toBeLessThan(0);
  });

  it('winner never gains less than 1, loser never loses less than 1', () => {
    // Huge favourite beats a tiny underdog -> deltas clamp to +/-1.
    const { winnerDelta, loserDelta } = rankedOutcome(3000, 0);
    expect(winnerDelta).toBeGreaterThanOrEqual(1);
    expect(loserDelta).toBeLessThanOrEqual(-1);
  });
});

describe('drawOutcome', () => {
  it('equal ratings draw -> ~zero change', () => {
    const [a, b] = drawOutcome(1000, 1000);
    expect(a).toBe(0);
    expect(b).toBe(0);
  });

  it('lower-rated player gains on a draw vs higher-rated', () => {
    const [low, high] = drawOutcome(1000, 1400);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThan(0);
  });
});
