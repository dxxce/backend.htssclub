import { RankTier, rankFromRp } from './rank.util';

describe('rank (RP-based, independent of XP)', () => {
  it('starts at Bronze IV with 0 RP', () => {
    const r = rankFromRp(0);
    expect(r.tier).toBe(RankTier.BRONZE);
    expect(r.division).toBe(4);
    expect(r.label).toBe('Đồng IV');
    expect(r.isApex).toBe(false);
  });

  it('division rises within a tier (IV -> I)', () => {
    expect(rankFromRp(0).division).toBe(4); // Bronze IV
    expect(rankFromRp(100).division).toBe(3); // Bronze III
    expect(rankFromRp(200).division).toBe(2); // Bronze II
    expect(rankFromRp(300).division).toBe(1); // Bronze I
  });

  it('promotes to the next tier after 400 RP', () => {
    const r = rankFromRp(400);
    expect(r.tier).toBe(RankTier.SILVER);
    expect(r.division).toBe(4);
    expect(r.label).toBe('Bạc IV');
  });

  it('reaches apex tiers (Master/Grandmaster/Challenger)', () => {
    expect(rankFromRp(2000).tier).toBe(RankTier.MASTER); // 5*400
    expect(rankFromRp(2000).isApex).toBe(true);
    expect(rankFromRp(2500).tier).toBe(RankTier.GRANDMASTER);
    expect(rankFromRp(3000).tier).toBe(RankTier.CHALLENGER);
  });

  it('progress to next step within a division', () => {
    const r = rankFromRp(50); // Bronze IV, 50/100
    expect(r.rpIntoDivision).toBe(50);
    expect(r.rpToNextStep).toBe(50);
    expect(r.progress).toBeCloseTo(0.5, 5);
  });

  it('clamps negative RP to 0', () => {
    expect(rankFromRp(-100).rp).toBe(0);
  });

  it('each tier has cosmetic color + shape', () => {
    const bronze = rankFromRp(0);
    const gold = rankFromRp(900); // Gold
    expect(typeof bronze.color).toBe('string');
    expect(typeof bronze.shape).toBe('string');
    expect(bronze.color).not.toBe(gold.color); // different tiers differ
    expect(rankFromRp(2500).glow).toBe(true); // apex glows
  });
});
