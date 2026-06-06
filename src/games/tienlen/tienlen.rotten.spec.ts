/**
 * "Thối heo" (rotten pig) penalty at game end: a player still holding 2s when
 * the game finishes is penalised, and the winner is rewarded. Drives the REAL
 * service play() that ends the game, asserting rpChange reflects the transfer.
 */
import { GameMode } from '../../common/enums';
import { TienLenService } from './tienlen.service';
import { TienLenStatus } from './schemas/tienlen-game.schema';
import { Types } from 'mongoose';

const card = (rank: number, suit: number) => rank * 4 + suit;

function makeGameDoc(seats: any[], starter: number, mode = GameMode.RANKED) {
  const doc: any = {
    _id: new Types.ObjectId(),
    mode,
    betAmount: 0,
    pot: 0,
    status: TienLenStatus.ACTIVE,
    seats,
    turn: starter,
    openingCard: 0,
    currentCombo: [],
    currentComboType: undefined,
    leadSeat: starter,
    history: [{ seat: 0, userId: seats[0].userId, cards: [0], at: new Date() }],
    finishOrder: [],
    resignedSeats: [],
    chops: [],
    rpChange: undefined,
    coinChange: undefined,
    markModified() {},
    async save() { return this; },
  };
  doc._id.toString = () => 'game1';
  return doc;
}

const RP_PER_UNIT = 5;

function makeService(doc: any): { svc: TienLenService; rpCalls: Record<string, number> } {
  const rpCalls: Record<string, number> = {};
  const model: any = { findById: () => ({ exec: async () => doc }) };
  const realtime: any = { emitToTienLenRoom() {}, emitToTienLenUser() {} };
  const leveling: any = {
    addRankPoints: async (uid: string, delta: number) => { rpCalls[uid] = (rpCalls[uid] ?? 0) + delta; },
  };
  const users: any = { getCards: async () => new Map() };
  const wager: any = { collectStake: async () => {}, payout: async () => {} };
  const rooms: any = { close: async () => {} };
  const config: any = {
    get: () => ({ chopHeoBetRatio: 0.5, chopHeoRp: 5, rottenHeoBetRatio: 0.5, rottenHeoRp: RP_PER_UNIT }),
  };
  const svc = new TienLenService(model, realtime, leveling, users, wager, rooms, config);
  (svc as any).startTurnTimer = () => {};
  (svc as any).getGameOrThrow = async () => doc;
  return { svc, rpCalls };
}

function seat(uid: Types.ObjectId, i: number, hand: number[]) {
  return { userId: uid, seat: i, hand: [...hand].sort((a, b) => a - b), handCount: hand.length, finishedRank: 0, passed: false, connected: true };
}

describe('tienlen thối heo (rotten pig) penalty', () => {
  it('RANKED: loser keeping a red 2 pays the winner (red = 2 units)', async () => {
    const U = [new Types.ObjectId(), new Types.ObjectId()];
    // Seat 0 leads its last card (a 3♠) and empties hand -> wins.
    // Seat 1 is left holding a red 2♥ (2 units) -> rotten heo.
    const seats = [
      seat(U[0], 0, [card(0, 0)]),            // 3♠ only
      seat(U[1], 1, [card(12, 3), card(4, 0)]), // 2♥ (red) + a 7♠
    ];
    const doc = makeGameDoc(seats, 0);
    doc.currentCombo = [];          // free lead
    doc.leadSeat = 0; doc.turn = 0;

    const { svc, rpCalls } = makeService(doc);
    // Seat 0 plays its only card -> hand empty -> game finishes.
    await svc.play('game1', U[0].toString(), [card(0, 0)]);
    expect(doc.status).toBe(TienLenStatus.FINISHED);

    const winner = U[0].toString();
    const loser = U[1].toString();
    // Base placement RP: winner +RP_SPREAD-ish, loser negative. Plus rotten:
    // red heo = 2 units * 5 = 10 RP moved loser->winner.
    expect(doc.rpChange[loser]).toBeLessThan(0);
    expect(doc.rpChange[winner]).toBeGreaterThan(doc.rpChange[loser]);
    // The rotten transfer must be exactly 2 units * RP_PER_UNIT on top of base.
    // base winner = +24 (2 players, place1 => score 1 => 24), loser = -24.
    expect(doc.rpChange[winner]).toBe(24 + 2 * RP_PER_UNIT);
    expect(doc.rpChange[loser]).toBe(-24 - 2 * RP_PER_UNIT);
    // leveling.addRankPoints called with the same adjusted values.
    expect(rpCalls[winner]).toBe(24 + 2 * RP_PER_UNIT);
    expect(rpCalls[loser]).toBe(-24 - 2 * RP_PER_UNIT);
  });

  it('no penalty when the loser holds no 2s', async () => {
    const U = [new Types.ObjectId(), new Types.ObjectId()];
    const seats = [
      seat(U[0], 0, [card(0, 0)]),
      seat(U[1], 1, [card(4, 0), card(5, 0)]), // 7♠, 8♠ — no heo
    ];
    const doc = makeGameDoc(seats, 0);
    doc.leadSeat = 0; doc.turn = 0;
    const { svc } = makeService(doc);
    await svc.play('game1', U[0].toString(), [card(0, 0)]);
    expect(doc.rpChange[U[0].toString()]).toBe(24);
    expect(doc.rpChange[U[1].toString()]).toBe(-24);
  });
});
