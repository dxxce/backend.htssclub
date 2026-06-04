import {
  canBeat,
  chopHeoBreakdown,
  choppedHeoCards,
  ComboType,
  deal,
  detectChop,
  detectInstantWin,
  identifyCombo,
  holderOfLowest,
  InstantWin,
  isRedSuit,
  rankOf,
  removeCards,
  shuffledDeck,
  suitOf,
  THREE_OF_SPADES,
} from './tienlen.logic';

// Helper: build a card int from rankIndex (0='3'..12='2') and suit (0..3).
const card = (rank: number, suit: number) => rank * 4 + suit;

describe('card encoding', () => {
  it('3♠ is the lowest card (0)', () => {
    expect(THREE_OF_SPADES).toBe(0);
    expect(rankOf(0)).toBe(0);
    expect(suitOf(0)).toBe(0);
  });
  it('2♥ is the highest card (51)', () => {
    expect(card(12, 3)).toBe(51);
    expect(rankOf(51)).toBe(12);
    expect(suitOf(51)).toBe(3);
  });
});

describe('deck & deal', () => {
  it('shuffled deck has 52 unique cards', () => {
    const d = shuffledDeck();
    expect(d.length).toBe(52);
    expect(new Set(d).size).toBe(52);
  });
  it('deals 13 cards to each player, sorted', () => {
    for (const n of [2, 3, 4]) {
      const hands = deal(n);
      expect(hands.length).toBe(n);
      hands.forEach((h) => {
        expect(h.length).toBe(13);
        const sorted = [...h].sort((a, b) => a - b);
        expect(h).toEqual(sorted);
      });
    }
  });
  it('holderOfLowest finds the 3♠ owner', () => {
    const hands = [
      [card(1, 0), card(2, 0)],
      [THREE_OF_SPADES, card(5, 0)],
    ];
    expect(holderOfLowest(hands)).toBe(1);
  });
});

describe('identifyCombo', () => {
  it('single', () => {
    const c = identifyCombo([card(4, 1)]);
    expect(c?.type).toBe(ComboType.SINGLE);
  });
  it('pair (same rank)', () => {
    const c = identifyCombo([card(4, 0), card(4, 2)]);
    expect(c?.type).toBe(ComboType.PAIR);
  });
  it('rejects a "pair" of different ranks', () => {
    expect(identifyCombo([card(4, 0), card(5, 0)])).toBeNull();
  });
  it('triple and four-of-a-kind', () => {
    expect(identifyCombo([card(6, 0), card(6, 1), card(6, 2)])?.type).toBe(
      ComboType.TRIPLE,
    );
    expect(
      identifyCombo([card(6, 0), card(6, 1), card(6, 2), card(6, 3)])?.type,
    ).toBe(ComboType.FOUR);
  });
  it('straight of 3+ consecutive ranks', () => {
    const c = identifyCombo([card(0, 0), card(1, 0), card(2, 0)]); // 3-4-5
    expect(c?.type).toBe(ComboType.STRAIGHT);
  });
  it('rejects a straight containing 2', () => {
    // J-Q-K-A-2 is NOT a valid straight (2 not allowed)
    const c = identifyCombo([
      card(8, 0),
      card(9, 0),
      card(10, 0),
      card(11, 0),
      card(12, 0),
    ]);
    expect(c).toBeNull();
  });
  it('pair-straight (đôi thông) of 3 consecutive pairs', () => {
    const c = identifyCombo([
      card(0, 0), card(0, 1), // 3 3
      card(1, 0), card(1, 1), // 4 4
      card(2, 0), card(2, 1), // 5 5
    ]);
    expect(c?.type).toBe(ComboType.PAIR_STRAIGHT);
  });
});

describe('canBeat — normal comparisons', () => {
  it('free lead always allowed', () => {
    const c = identifyCombo([card(0, 0)])!;
    expect(canBeat(c, null)).toBe(true);
  });
  it('higher single beats lower single', () => {
    const low = identifyCombo([card(4, 0)])!;
    const high = identifyCombo([card(4, 3)])!; // same rank, higher suit
    expect(canBeat(high, low)).toBe(true);
    expect(canBeat(low, high)).toBe(false);
  });
  it('different type cannot beat', () => {
    const pair = identifyCombo([card(5, 0), card(5, 1)])!;
    const single = identifyCombo([card(12, 3)])!; // 2♥
    expect(canBeat(single, pair)).toBe(false);
  });
  it('straight must match length', () => {
    const s3 = identifyCombo([card(0, 0), card(1, 0), card(2, 0)])!; // 3-4-5
    const s3b = identifyCombo([card(3, 0), card(4, 0), card(5, 0)])!; // 6-7-8
    const s4 = identifyCombo([
      card(3, 0), card(4, 0), card(5, 0), card(6, 0),
    ])!;
    expect(canBeat(s3b, s3)).toBe(true); // higher 3-straight beats lower
    expect(canBeat(s4, s3)).toBe(false); // length mismatch
  });
});

describe('canBeat — bombs (chặt)', () => {
  const singleTwo = identifyCombo([card(12, 3)])!; // 2♥
  const pairTwo = identifyCombo([card(12, 2), card(12, 3)])!; // pair of 2s

  it('four-of-a-kind beats a single 2', () => {
    const four = identifyCombo([
      card(3, 0), card(3, 1), card(3, 2), card(3, 3),
    ])!;
    expect(canBeat(four, singleTwo)).toBe(true);
  });
  it('3 consecutive pairs beat a single 2', () => {
    const threePairs = identifyCombo([
      card(0, 0), card(0, 1),
      card(1, 0), card(1, 1),
      card(2, 0), card(2, 1),
    ])!;
    expect(canBeat(threePairs, singleTwo)).toBe(true);
  });
  it('four-of-a-kind beats 3 consecutive pairs', () => {
    const four = identifyCombo([
      card(5, 0), card(5, 1), card(5, 2), card(5, 3),
    ])!;
    const threePairs = identifyCombo([
      card(0, 0), card(0, 1),
      card(1, 0), card(1, 1),
      card(2, 0), card(2, 1),
    ])!;
    expect(canBeat(four, threePairs)).toBe(true);
  });
  it('4 consecutive pairs beat a pair of 2s and a four-of-a-kind', () => {
    const fourPairs = identifyCombo([
      card(0, 0), card(0, 1),
      card(1, 0), card(1, 1),
      card(2, 0), card(2, 1),
      card(3, 0), card(3, 1),
    ])!;
    const four = identifyCombo([
      card(5, 0), card(5, 1), card(5, 2), card(5, 3),
    ])!;
    expect(canBeat(fourPairs, pairTwo)).toBe(true);
    expect(canBeat(fourPairs, four)).toBe(true);
  });
});

describe('removeCards', () => {
  it('removes present cards and keeps the rest sorted', () => {
    const hand = [0, 1, 2, 3, 4];
    const next = removeCards(hand, [1, 3]);
    expect(next).toEqual([0, 2, 4]);
  });
  it('returns null when a card is missing', () => {
    expect(removeCards([0, 1, 2], [5])).toBeNull();
  });
});

describe('detectChop (chặt heo)', () => {
  const singleBlackTwo = identifyCombo([card(12, 0)])!; // 2♠ (black)
  const singleRedTwo = identifyCombo([card(12, 3)])!; // 2♥ (red)
  const pairTwo = identifyCombo([card(12, 0), card(12, 3)])!; // 2♠ + 2♥
  const four = identifyCombo([card(5, 0), card(5, 1), card(5, 2), card(5, 3)])!;
  const threePairs = identifyCombo([
    card(0, 0), card(0, 1),
    card(1, 0), card(1, 1),
    card(2, 0), card(2, 1),
  ])!;

  it('four-of-a-kind chopping a single 2 = 1 heo', () => {
    expect(detectChop(four, singleBlackTwo)).toBe(1);
  });
  it('four-of-a-kind chopping a pair of 2s = 2 heo', () => {
    expect(detectChop(four, pairTwo)).toBe(2);
  });
  it('3 đôi thông chopping a single 2 = 1 heo', () => {
    expect(detectChop(threePairs, singleBlackTwo)).toBe(1);
  });
  it('not a chop when beating a non-2', () => {
    const lowSingle = identifyCombo([card(4, 0)])!;
    expect(detectChop(four, lowSingle)).toBe(0);
  });
  it('not a chop on a free lead', () => {
    expect(detectChop(four, null)).toBe(0);
  });

  it('returns the actual chopped heo cards', () => {
    expect(choppedHeoCards(four, singleRedTwo)).toEqual([card(12, 3)]);
    expect(choppedHeoCards(four, pairTwo).sort((a, b) => a - b)).toEqual(
      [card(12, 0), card(12, 3)],
    );
  });
});

describe('chop heo black/red pricing (red = 2 units)', () => {
  it('isRedSuit: ♦/♥ red, ♠/♣ black', () => {
    expect(isRedSuit(card(12, 0))).toBe(false); // 2♠
    expect(isRedSuit(card(12, 1))).toBe(false); // 2♣
    expect(isRedSuit(card(12, 2))).toBe(true); // 2♦
    expect(isRedSuit(card(12, 3))).toBe(true); // 2♥
  });
  it('1 black heo = 1 unit', () => {
    expect(chopHeoBreakdown([card(12, 0)])).toEqual({ black: 1, red: 0, units: 1 });
  });
  it('1 red heo = 2 units', () => {
    expect(chopHeoBreakdown([card(12, 2)])).toEqual({ black: 0, red: 1, units: 2 });
  });
  it('1 black + 1 red = 3 units', () => {
    const b = chopHeoBreakdown([card(12, 1), card(12, 3)]);
    expect(b).toEqual({ black: 1, red: 1, units: 3 });
  });
  it('pair of red 2s = 4 units', () => {
    expect(chopHeoBreakdown([card(12, 2), card(12, 3)])).toEqual({
      black: 0,
      red: 2,
      units: 4,
    });
  });
});

describe('detectInstantWin (tới trắng)', () => {
  const handFromRanks = (counts: Record<number, number>) => {
    const cards: number[] = [];
    for (const [r, c] of Object.entries(counts)) {
      for (let s = 0; s < c; s++) cards.push(Number(r) * 4 + s);
    }
    return cards;
  };

  it('four 2s', () => {
    // 4 twos + 9 filler cards (avoid forming a dragon/6-pairs).
    const hand = [card(12, 0), card(12, 1), card(12, 2), card(12, 3),
      card(0, 0), card(2, 0), card(4, 0), card(6, 0), card(8, 0),
      card(0, 1), card(2, 1), card(4, 1), card(6, 1)];
    expect(detectInstantWin(hand)).toBe(InstantWin.FOUR_TWOS);
  });

  it('dragon straight 3..A', () => {
    // One of each rank 0..11 (12 cards) + 1 filler.
    const hand: number[] = [];
    for (let r = 0; r <= 11; r++) hand.push(card(r, 0));
    hand.push(card(0, 1)); // 13th
    expect(detectInstantWin(hand)).toBe(InstantWin.DRAGON);
  });

  it('six pairs', () => {
    const hand = handFromRanks({ 0: 2, 1: 2, 3: 2, 5: 2, 7: 2, 9: 2 });
    hand.push(card(11, 0)); // 13th
    expect(detectInstantWin(hand)).toBe(InstantWin.SIX_PAIRS);
  });

  it('5 consecutive pairs', () => {
    // pairs at ranks 0,1,2,3,4 -> 10 cards + 3 fillers (non-pairing, no dragon)
    const hand = handFromRanks({ 0: 2, 1: 2, 2: 2, 3: 2, 4: 2 });
    hand.push(card(7, 0), card(9, 0), card(11, 0));
    expect(detectInstantWin(hand)).toBe(InstantWin.FIVE_PAIR_RUN);
  });

  it('ordinary hand -> null', () => {
    // No rank repeated (no pairs), and rank 6 is missing (breaks dragon).
    const hand = [card(0, 0), card(1, 0), card(2, 0), card(3, 0), card(4, 0),
      card(5, 0), card(7, 0), card(8, 0), card(9, 0), card(10, 0),
      card(11, 0), card(12, 0), card(0, 1)];
    expect(detectInstantWin(hand)).toBeNull();
  });
});
