/**
 * Standard ELO rating used for RANK POINTS (RP) in ranked Caro.
 * Result from A's perspective: 1 win, 0 loss, 0.5 draw.
 */
export function eloDelta(
  ratingA: number,
  ratingB: number,
  scoreA: number,
  k = 32,
): number {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  return Math.round(k * (scoreA - expectedA));
}

export interface EloOutcome {
  winnerDelta: number; // RP change for the winner (>= 0)
  loserDelta: number; // RP change for the loser (<= 0)
}

/** RP deltas for a decisive game (winner vs loser). */
export function rankedOutcome(
  winnerRp: number,
  loserRp: number,
  k = 32,
): EloOutcome {
  const winnerDelta = eloDelta(winnerRp, loserRp, 1, k);
  const loserDelta = eloDelta(loserRp, winnerRp, 0, k);
  return {
    // Guarantee the winner never loses RP and the loser never gains.
    winnerDelta: Math.max(1, winnerDelta),
    loserDelta: Math.min(-1, loserDelta),
  };
}

/** RP deltas for a draw. */
export function drawOutcome(rpA: number, rpB: number, k = 32): [number, number] {
  return [eloDelta(rpA, rpB, 0.5, k), eloDelta(rpB, rpA, 0.5, k)];
}
