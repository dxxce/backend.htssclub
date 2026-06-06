/**
 * Tiến Lên Miền Nam (Southern Vietnamese "Thirteen") core rules — pure, no IO.
 *
 * Deck: 52 cards. Rank order (low→high): 3 4 5 6 7 8 9 10 J Q K A 2.
 * Suit order (low→high): ♠ Spades < ♣ Clubs < ♦ Diamonds < ♥ Hearts.
 * Each card is encoded as an integer 0..51 where:
 *    rankIndex = floor(card / 4)   // 0 = '3' ... 12 = '2'
 *    suitIndex = card % 4          // 0=♠ 1=♣ 2=♦ 3=♥
 * This encoding makes natural numeric comparison equal to game strength.
 */

export const DECK_SIZE = 52;

export enum ComboType {
  SINGLE = 'SINGLE',
  PAIR = 'PAIR',
  TRIPLE = 'TRIPLE',
  STRAIGHT = 'STRAIGHT', // run of >=3 consecutive ranks (no 2)
  PAIR_STRAIGHT = 'PAIR_STRAIGHT', // >=3 consecutive pairs (đôi thông)
  FOUR = 'FOUR', // four of a kind (tứ quý) — also a bomb
}

export interface Combo {
  type: ComboType;
  cards: number[]; // sorted ascending
  // Comparable strength: the highest card of the combo (numeric).
  rankValue: number;
  length: number; // # cards
}

export const SUITS = ['♠', '♣', '♦', '♥'];
export const RANKS = [
  '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2',
];

export function rankOf(card: number): number {
  return Math.floor(card / 4);
}
export function suitOf(card: number): number {
  return card % 4;
}
export function cardLabel(card: number): string {
  return `${RANKS[rankOf(card)]}${SUITS[suitOf(card)]}`;
}

/** The lowest card in the game: 3♠ (rankIndex 0, suit 0) === 0. */
export const THREE_OF_SPADES = 0;

/** Returns a shuffled full deck (Fisher–Yates). */
export function shuffledDeck(rng: () => number = Math.random): number[] {
  const deck = Array.from({ length: DECK_SIZE }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** Deals 13 cards to each of `n` players (n in 2..4). Returns sorted hands. */
export function deal(n: number, rng: () => number = Math.random): number[][] {
  const deck = shuffledDeck(rng);
  const hands: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < 13 * n; i++) {
    hands[i % n].push(deck[i]);
  }
  return hands.map((h) => h.sort((a, b) => a - b));
}

/** Index (0-based) of the player holding 3♠, who must lead the first round. */
export function holderOfLowest(hands: number[][]): number {
  let best = Infinity;
  let who = 0;
  hands.forEach((hand, i) => {
    if (hand.length && hand[0] < best) {
      best = hand[0];
      who = i;
    }
  });
  return who;
}

/**
 * Identifies the combo formed by `cards` (already a subset of a hand), or null
 * if the cards don't form a legal combo.
 */
export function identifyCombo(cards: number[]): Combo | null {
  if (!cards.length) return null;
  const sorted = [...cards].sort((a, b) => a - b);
  const ranks = sorted.map(rankOf);
  const n = sorted.length;
  const top = sorted[n - 1];

  // Singles / pairs / triples / four-of-a-kind (same rank).
  const allSameRank = ranks.every((r) => r === ranks[0]);
  if (allSameRank) {
    if (n === 1) return { type: ComboType.SINGLE, cards: sorted, rankValue: top, length: 1 };
    if (n === 2) return { type: ComboType.PAIR, cards: sorted, rankValue: top, length: 2 };
    if (n === 3) return { type: ComboType.TRIPLE, cards: sorted, rankValue: top, length: 3 };
    if (n === 4) return { type: ComboType.FOUR, cards: sorted, rankValue: top, length: 4 };
    return null;
  }

  // Straight: >=3 cards, consecutive ranks, no '2' (rankIndex 12), distinct ranks.
  if (n >= 3 && isStraight(ranks)) {
    return { type: ComboType.STRAIGHT, cards: sorted, rankValue: top, length: n };
  }

  // Pair-straight (đôi thông): even count >=6, consecutive pairs, no '2'.
  if (n >= 6 && n % 2 === 0) {
    const ps = isPairStraight(sorted);
    if (ps) {
      return {
        type: ComboType.PAIR_STRAIGHT,
        cards: sorted,
        rankValue: top,
        length: n,
      };
    }
  }
  return null;
}

function isStraight(ranks: number[]): boolean {
  // No 2 allowed in a straight.
  if (ranks.includes(12)) return false;
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] !== ranks[i - 1] + 1) return false;
  }
  return true;
}

/** Checks consecutive pairs (e.g. 33 44 55). No '2' allowed. */
function isPairStraight(sorted: number[]): boolean {
  const ranks = sorted.map(rankOf);
  if (ranks.includes(12)) return false;
  // Group into pairs.
  for (let i = 0; i < sorted.length; i += 2) {
    if (ranks[i] !== ranks[i + 1]) return false; // each adjacent two share a rank
  }
  // Consecutive rank between pairs.
  for (let i = 2; i < sorted.length; i += 2) {
    if (ranks[i] !== ranks[i - 2] + 1) return false;
  }
  return true;
}

/** Number of consecutive pairs in a pair-straight combo. */
export function pairStraightLength(combo: Combo): number {
  return combo.length / 2;
}

/**
 * Can `candidate` be played on top of `current` (the combo to beat)?
 * Handles normal same-type/same-length comparisons plus "bombs" (chặt):
 *   - 3+ consecutive pairs beat a single '2'.
 *   - four-of-a-kind beats a single '2' and beats 3-consecutive-pairs.
 *   - 4 consecutive pairs beat a four-of-a-kind / a pair of '2's.
 */
export function canBeat(candidate: Combo, current: Combo | null): boolean {
  if (!current) return true; // free lead

  // ── Bombs ──
  const isSingleTwo =
    current.type === ComboType.SINGLE && rankOf(current.cards[0]) === 12;
  const isPairTwo =
    current.type === ComboType.PAIR && rankOf(current.cards[0]) === 12;

  if (candidate.type === ComboType.FOUR) {
    if (isSingleTwo || isPairTwo) return true;
    if (current.type === ComboType.PAIR_STRAIGHT && pairStraightLength(current) === 3)
      return true;
    // four vs four: higher wins
    if (current.type === ComboType.FOUR)
      return candidate.rankValue > current.rankValue;
  }
  if (
    candidate.type === ComboType.PAIR_STRAIGHT &&
    pairStraightLength(candidate) === 3
  ) {
    if (isSingleTwo) return true;
  }
  if (
    candidate.type === ComboType.PAIR_STRAIGHT &&
    pairStraightLength(candidate) === 4
  ) {
    if (isSingleTwo || isPairTwo || current.type === ComboType.FOUR) return true;
  }

  // ── Normal comparison: same type + same length, higher top card ──
  if (candidate.type !== current.type) return false;
  if (candidate.length !== current.length) return false;
  return candidate.rankValue > current.rankValue;
}

/** Removes `cards` from `hand` if all present; returns new hand or null. */
export function removeCards(hand: number[], cards: number[]): number[] | null {
  const set = new Set(hand);
  for (const c of cards) {
    if (!set.has(c)) return null;
    set.delete(c);
  }
  return [...set].sort((a, b) => a - b);
}

// ── "Chặt heo" (chopping a 2) detection ──────────────────────────

/** A red suit is ♦ (2) or ♥ (3); black is ♠ (0) or ♣ (1). */
export function isRedSuit(card: number): boolean {
  return suitOf(card) >= 2;
}

/**
 * Returns how many '2's (heo) a bomb chop beats, or 0 if `candidate` played on
 * `current` is not a heo-chop. Only counts beating actual 2s with a bomb
 * (tứ quý / 3+ đôi thông). Bomb-vs-bomb is NOT a heo chop.
 */
export function detectChop(candidate: Combo, current: Combo | null): number {
  return choppedHeoCards(candidate, current).length;
}

/**
 * Returns the actual '2' cards being chopped (so the caller can price black
 * vs red heo differently), or [] if this is not a heo-chop.
 */
export function choppedHeoCards(
  candidate: Combo,
  current: Combo | null,
): number[] {
  if (!current) return [];
  const isSingleTwo =
    current.type === ComboType.SINGLE && rankOf(current.cards[0]) === 12;
  const isPairTwo =
    current.type === ComboType.PAIR && rankOf(current.cards[0]) === 12;
  if (!isSingleTwo && !isPairTwo) return [];

  const isBomb =
    candidate.type === ComboType.FOUR ||
    (candidate.type === ComboType.PAIR_STRAIGHT &&
      pairStraightLength(candidate) >= 3);
  if (!isBomb) return [];

  return current.cards.filter((c) => rankOf(c) === 12);
}

/**
 * Breaks down chopped heo into black/red counts and "units" where a red heo
 * (♦/♥) is worth DOUBLE a black heo (♠/♣). Used to price the chop penalty.
 */
export function chopHeoBreakdown(heoCards: number[]): {
  black: number;
  red: number;
  units: number;
} {
  let black = 0;
  let red = 0;
  for (const c of heoCards) {
    if (isRedSuit(c)) red++;
    else black++;
  }
  return { black, red, units: black + red * 2 };
}

// ── "Tới trắng" (instant win on deal) detection ──────────────────

export enum InstantWin {
  FOUR_TWOS = 'TU_QUY_HEO', // four 2s
  SIX_PAIRS = 'SAU_DOI', // any six pairs
  DRAGON = 'SANH_RONG', // straight 3..A (12 distinct ranks)
  FIVE_PAIR_RUN = 'NAM_DOI_THONG', // 5 consecutive pairs
}

/**
 * Detects an instant-win ("tới trắng") hand dealt to a player. Returns the
 * kind, or null. Checked once right after dealing.
 */
export function detectInstantWin(hand: number[]): InstantWin | null {
  const freq = new Array(13).fill(0);
  for (const c of hand) freq[rankOf(c)]++;

  // Four 2s (rankIndex 12).
  if (freq[12] === 4) return InstantWin.FOUR_TWOS;

  // Dragon straight 3..A => ranks 0..11 all present.
  let dragon = true;
  for (let r = 0; r <= 11; r++) if (freq[r] < 1) dragon = false;
  if (dragon) return InstantWin.DRAGON;

  // Six pairs (>=6 pairs total across the hand).
  const pairs = freq.reduce((acc, f) => acc + Math.floor(f / 2), 0);
  if (pairs >= 6) return InstantWin.SIX_PAIRS;

  // 5 consecutive pairs (no 2). Sliding window of 5 ranks each with freq>=2.
  for (let start = 0; start + 5 <= 12; start++) {
    let ok = true;
    for (let r = start; r < start + 5; r++) if (freq[r] < 2) ok = false;
    if (ok) return InstantWin.FIVE_PAIR_RUN;
  }
  return null;
}

// ── "Thối heo" (rotten pig: keeping 2s when the game ends) ───────

/**
 * Returns the '2' (heo) cards still left in a losing hand at game end. Keeping
 * a heo until the game is over is penalised ("thối heo"), priced like a chop:
 * a red heo (♦/♥) counts double a black heo (♠/♣) via chopHeoBreakdown().
 * Returns [] for an empty hand (a winner never has rotten heo).
 */
export function rottenHeoCards(hand: number[]): number[] {
  return hand.filter((c) => rankOf(c) === 12);
}
