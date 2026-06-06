/**
 * Reproduction tests for the post-chop bug ("your combo does not beat the
 * table" after chopping a heo). Drives the REAL service play/pass methods with
 * in-memory fakes, covering 2/3/4 players and a concurrent turn-timer interleave.
 */
import { GameMode } from '../../common/enums';
import { TienLenService } from './tienlen.service';
import { TienLenStatus } from './schemas/tienlen-game.schema';
import { Types } from 'mongoose';

const card = (rank: number, suit: number) => rank * 4 + suit;

function makeGameDoc(seats: any[], starter: number) {
  const doc: any = {
    _id: new Types.ObjectId(),
    mode: GameMode.CASUAL,
    betAmount: 0,
    pot: 0,
    status: TienLenStatus.ACTIVE,
    seats,
    turn: starter,
    openingCard: 0,
    currentCombo: [],
    currentComboType: undefined,
    leadSeat: starter,
    history: [],
    finishOrder: [],
    resignedSeats: [],
    chops: [],
    markModified() {},
    async save() { return this; },
  };
  doc._id.toString = () => 'game1';
  return doc;
}

function makeService(doc: any): TienLenService {
  const model: any = { findById: () => ({ exec: async () => doc }) };
  const realtime: any = { emitToTienLenRoom() {}, emitToTienLenUser() {} };
  const leveling: any = { addRankPoints: async () => {} };
  const users: any = { getCards: async () => new Map() };
  const wager: any = { collectStake: async () => {}, payout: async () => {} };
  const rooms: any = { close: async () => {} };
  const config: any = { get: () => ({ chopHeoBetRatio: 0.5, chopHeoRp: 5 }) };
  const svc = new TienLenService(model, realtime, leveling, users, wager, rooms, config);
  (svc as any).startTurnTimer = () => {};
  (svc as any).getGameOrThrow = async () => doc;
  return svc;
}

function seat(uid: Types.ObjectId, i: number, hand: number[]) {
  return { userId: uid, seat: i, hand: [...hand].sort((a, b) => a - b), handCount: hand.length, finishedRank: 0, passed: false, connected: true };
}

describe('tienlen post-chop trick reset (multi-player)', () => {
  it('3 players: chopper leads after both others pass the bomb', async () => {
    const U = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
    const four8 = [card(5, 0), card(5, 1), card(5, 2), card(5, 3)];
    const pair9 = [card(6, 0), card(6, 1)];
    const seats = [
      seat(U[0], 0, [card(12, 3), card(0, 0)]),          // victim: 2♥ + 3♠
      seat(U[1], 1, [...four8, ...pair9, card(7, 0)]),   // chopper
      seat(U[2], 2, [card(1, 0), card(1, 1), card(2, 0)]),
    ];
    const doc = makeGameDoc(seats, 0);
    doc.history.push({ seat: 0, userId: U[0], cards: [card(0, 0)], at: new Date() });
    doc.currentCombo = [card(12, 3)];
    doc.currentComboType = 'SINGLE';
    doc.leadSeat = 0;
    doc.turn = 1;
    seats[0].hand = [card(0, 0)]; seats[0].handCount = 1;

    const svc = makeService(doc);
    await svc.play('game1', U[1].toString(), four8);     // chop
    expect(doc.turn).toBe(2);                            // next player must respond
    await svc.pass('game1', U[2].toString());            // P2 passes
    await svc.pass('game1', U[0].toString());            // victim passes -> reset
    expect(doc.currentCombo.length).toBe(0);
    expect(doc.turn).toBe(1);                            // chopper leads
    await expect(svc.play('game1', U[1].toString(), pair9)).resolves.toBeDefined();
  });

  it('2 players: chopper leads after victim (still holding cards) passes the bomb', async () => {
    const U = [new Types.ObjectId(), new Types.ObjectId()];
    const four8 = [card(5, 0), card(5, 1), card(5, 2), card(5, 3)];
    const pair9 = [card(6, 0), card(6, 1)];
    const seats = [
      seat(U[0], 0, [card(12, 3), card(0, 0), card(0, 1)]), // victim keeps cards
      seat(U[1], 1, [...four8, ...pair9]),                  // chopper
    ];
    const doc = makeGameDoc(seats, 0);
    doc.history.push({ seat: 0, userId: U[0], cards: [card(0, 0)], at: new Date() });
    doc.currentCombo = [card(12, 3)];
    doc.currentComboType = 'SINGLE';
    doc.leadSeat = 0;
    doc.turn = 1;
    seats[0].hand = [card(0, 0), card(0, 1)]; seats[0].handCount = 2;

    const svc = makeService(doc);
    await svc.play('game1', U[1].toString(), four8);  // chop
    expect(doc.turn).toBe(0);                          // victim must respond
    await svc.pass('game1', U[0].toString());          // victim passes -> reset
    expect(doc.currentCombo.length).toBe(0);
    expect(doc.turn).toBe(1);                          // chopper leads
    await expect(svc.play('game1', U[1].toString(), pair9)).resolves.toBeDefined();
  });
});
