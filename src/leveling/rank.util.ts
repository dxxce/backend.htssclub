/**
 * Game-style RANK system — INDEPENDENT from level/XP.
 *
 * Rank is driven by its own currency: Rank Points (RP). Tier + division are
 * derived from RP only. (How RP is earned/lost is a separate concern, e.g.
 * competitive wins/activity — wired by RankingService.)
 *
 * Tiers (low -> high), each tiered tier holds 4 divisions of `DIVISION_RP`:
 *   Đồng (Bronze) · Bạc (Silver) · Vàng (Gold) · Bạch Kim (Platinum) ·
 *   Kim Cương (Diamond) · Cao Thủ (Master) · Đại Cao Thủ (Grandmaster) ·
 *   Thách Đấu (Challenger)
 * The top three tiers (Master/Grandmaster/Challenger) are "apex": no
 * divisions, just rising RP.
 */

export enum RankTier {
  BRONZE = 'BRONZE',
  SILVER = 'SILVER',
  GOLD = 'GOLD',
  PLATINUM = 'PLATINUM',
  DIAMOND = 'DIAMOND',
  MASTER = 'MASTER',
  GRANDMASTER = 'GRANDMASTER',
  CHALLENGER = 'CHALLENGER',
}

export interface RankInfo {
  tier: RankTier;
  tierName: string; // Vietnamese display name
  tierIndex: number; // 0-based tier order (for color/asset selection)
  division: number; // 4..1 within a tier (1 highest); 0 for apex tiers
  divisionLabel: string; // 'I'..'IV' or '' for apex
  label: string; // e.g. "Vàng II", "Cao Thủ"
  rp: number; // total rank points
  rpIntoDivision: number; // RP earned within the current division/tier band
  rpForNextStep: number; // RP span of the current band
  rpToNextStep: number; // RP still needed to promote (0 if apex top)
  progress: number; // 0..1 toward the next division/tier
  isApex: boolean;
  // Cosmetics — frontend renders badge color + shape from these.
  shape: string;
  color: string;
  colorSecondary: string;
  glow: boolean;
}

const TIER_VN: Record<RankTier, string> = {
  [RankTier.BRONZE]: 'Đồng',
  [RankTier.SILVER]: 'Bạc',
  [RankTier.GOLD]: 'Vàng',
  [RankTier.PLATINUM]: 'Bạch Kim',
  [RankTier.DIAMOND]: 'Kim Cương',
  [RankTier.MASTER]: 'Cao Thủ',
  [RankTier.GRANDMASTER]: 'Đại Cao Thủ',
  [RankTier.CHALLENGER]: 'Thách Đấu',
};

interface TierStyle {
  shape: string;
  color: string;
  colorSecondary: string;
  glow: boolean;
}

const TIER_STYLE: Record<RankTier, TierStyle> = {
  [RankTier.BRONZE]: { shape: 'shield', color: '#A16207', colorSecondary: '#D6A45B', glow: false },
  [RankTier.SILVER]: { shape: 'shield', color: '#9CA3AF', colorSecondary: '#E5E7EB', glow: false },
  [RankTier.GOLD]: { shape: 'shield', color: '#F59E0B', colorSecondary: '#FCD34D', glow: false },
  [RankTier.PLATINUM]: { shape: 'gem', color: '#14B8A6', colorSecondary: '#5EEAD4', glow: true },
  [RankTier.DIAMOND]: { shape: 'gem', color: '#38BDF8', colorSecondary: '#BAE6FD', glow: true },
  [RankTier.MASTER]: { shape: 'crown', color: '#A855F7', colorSecondary: '#D8B4FE', glow: true },
  [RankTier.GRANDMASTER]: { shape: 'crown', color: '#EF4444', colorSecondary: '#FCA5A5', glow: true },
  [RankTier.CHALLENGER]: { shape: 'wings', color: '#F43F5E', colorSecondary: '#FDE68A', glow: true },
};

const ROMAN = ['', 'I', 'II', 'III', 'IV'];

// RP economy.
const DIVISION_RP = 100; // RP per division
const DIVISIONS = 4; // divisions per tiered tier
const TIER_RP = DIVISION_RP * DIVISIONS; // 400 RP per tiered tier
const TIERED: RankTier[] = [
  RankTier.BRONZE,
  RankTier.SILVER,
  RankTier.GOLD,
  RankTier.PLATINUM,
  RankTier.DIAMOND,
];
const TIERED_RP = TIERED.length * TIER_RP; // 2000 RP to leave Diamond
// Apex tier RP bands (above TIERED_RP).
const APEX_BAND = 500; // Master spans 500, Grandmaster spans 500, then Challenger.

export function rankFromRp(rpInput: number): RankInfo {
  const rp = Math.max(0, Math.floor(rpInput));

  // Tiered region: Bronze..Diamond.
  if (rp < TIERED_RP) {
    const tierIndex = Math.floor(rp / TIER_RP);
    const tier = TIERED[tierIndex];
    const rpInTier = rp - tierIndex * TIER_RP; // 0..399
    const divFromBottom = Math.floor(rpInTier / DIVISION_RP); // 0..3
    const division = DIVISIONS - divFromBottom; // 4..1 (IV lowest -> I highest)
    const rpIntoDivision = rpInTier - divFromBottom * DIVISION_RP;
    return {
      tier,
      tierName: TIER_VN[tier],
      tierIndex,
      division,
      divisionLabel: ROMAN[division],
      label: `${TIER_VN[tier]} ${ROMAN[division]}`,
      rp,
      rpIntoDivision,
      rpForNextStep: DIVISION_RP,
      rpToNextStep: DIVISION_RP - rpIntoDivision,
      progress: rpIntoDivision / DIVISION_RP,
      isApex: false,
      ...TIER_STYLE[tier],
    };
  }

  // Apex region.
  const apexRp = rp - TIERED_RP;
  if (apexRp < APEX_BAND) {
    return apex(RankTier.MASTER, TIERED.length, rp, apexRp, APEX_BAND);
  }
  if (apexRp < APEX_BAND * 2) {
    return apex(
      RankTier.GRANDMASTER,
      TIERED.length + 1,
      rp,
      apexRp - APEX_BAND,
      APEX_BAND,
    );
  }
  // Challenger: top, open-ended.
  return apex(
    RankTier.CHALLENGER,
    TIERED.length + 2,
    rp,
    apexRp - APEX_BAND * 2,
    0,
  );
}

function apex(
  tier: RankTier,
  tierIndex: number,
  rp: number,
  intoBand: number,
  band: number,
): RankInfo {
  return {
    tier,
    tierName: TIER_VN[tier],
    tierIndex,
    division: 0,
    divisionLabel: '',
    label: TIER_VN[tier],
    rp,
    rpIntoDivision: intoBand,
    rpForNextStep: band,
    rpToNextStep: band > 0 ? Math.max(0, band - intoBand) : 0,
    progress: band > 0 ? Math.min(1, intoBand / band) : 1,
    isApex: true,
    ...TIER_STYLE[tier],
  };
}
