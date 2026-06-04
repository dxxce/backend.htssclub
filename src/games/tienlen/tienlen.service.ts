import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { RealtimeService } from '../../realtime/realtime.service';
import { LevelingService } from '../../leveling/leveling.service';
import { UsersService } from '../../users/users.service';
import { GameMode } from '../../common/enums';
import { WagerService } from '../common/wager.service';
import { RoomsService } from '../common/rooms.service';
import {
  canBeat,
  Combo,
  deal,
  detectChop,
  detectInstantWin,
  holderOfLowest,
  identifyCombo,
  InstantWin,
  removeCards,
} from './tienlen.logic';
import {
  TienLenGame,
  TienLenGameDocument,
  TienLenSeat,
  TienLenStatus,
} from './schemas/tienlen-game.schema';

export const TL_TURN_SECONDS = 30;
const RP_SPREAD = 24; // RP magnitude for 1st/last place

@Injectable()
export class TienLenService {
  private readonly logger = new Logger(TienLenService.name);
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    @InjectModel(TienLenGame.name)
    private readonly model: Model<TienLenGameDocument>,
    private readonly realtime: RealtimeService,
    private readonly leveling: LevelingService,
    private readonly users: UsersService,
    private readonly wager: WagerService,
    private readonly rooms: RoomsService,
    private readonly config: ConfigService,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────
  async createGame(
    userIds: string[],
    opts: { mode?: GameMode; betAmount?: number; roomId?: string } = {},
  ): Promise<TienLenGameDocument> {
    const n = userIds.length;
    if (n < 2 || n > 4) {
      throw new BadRequestException('Tiến Lên needs 2 to 4 players');
    }
    const mode = opts.mode ?? GameMode.CASUAL;
    const betAmount = mode === GameMode.WAGER ? Math.floor(opts.betAmount ?? 0) : 0;
    const hands = deal(n);
    const seats: TienLenSeat[] = userIds.map((uid, i) => ({
      userId: new Types.ObjectId(uid),
      seat: i,
      hand: hands[i],
      handCount: hands[i].length,
      finishedRank: 0,
      passed: false,
      connected: true,
    }));
    const starter = holderOfLowest(hands);
    const openingCard = hands[starter][0]; // lowest dealt card; opener must play it
    const game = await this.model.create({
      roomId: opts.roomId ? new Types.ObjectId(opts.roomId) : undefined,
      mode,
      betAmount,
      pot: betAmount * n,
      status: TienLenStatus.ACTIVE,
      seats,
      turn: starter,
      openingCard,
      currentCombo: [],
      leadSeat: starter,
      history: [],
      finishOrder: [],
    });

    // "Tới trắng": if a player was dealt an instant-win hand, end immediately.
    const instant = this.findInstantWin(hands);
    if (instant) {
      const winnerId = userIds[instant.seat];
      // Notify players of their hands first (so the client can reveal them).
      for (const uid of userIds) {
        const view = await this.publicView(game, uid);
        this.realtime.emitToTienLenUser(uid, 'tienlen:matched', view);
      }
      await this.finishInstantWin(game, instant.seat, winnerId, instant.kind);
      return game;
    }

    // Notify each player privately with their own hand view.
    for (const uid of userIds) {
      const view = await this.publicView(game, uid);
      this.realtime.emitToTienLenUser(uid, 'tienlen:matched', view);
    }
    this.startTurnTimer(game._id.toString());
    return game;
  }

  /** Finds the first seat dealt a "tới trắng" hand, if any. */
  private findInstantWin(
    hands: number[][],
  ): { seat: number; kind: InstantWin } | null {
    for (let i = 0; i < hands.length; i++) {
      const kind = detectInstantWin(hands[i]);
      if (kind) return { seat: i, kind };
    }
    return null;
  }

  /** Launches from a full lobby room (2..4 members already escrowed). */
  async launchFromRoom(room: {
    id: string;
    mode: GameMode;
    betAmount: number;
    memberIds: string[];
  }): Promise<TienLenGameDocument> {
    const game = await this.createGame(room.memberIds, {
      mode: room.mode,
      betAmount: room.betAmount,
      roomId: room.id,
    });
    await this.rooms.markInProgress(room.id, game._id.toString());
    return game;
  }

  async getGameOrThrow(gameId: string): Promise<TienLenGameDocument> {
    if (!Types.ObjectId.isValid(gameId)) {
      throw new NotFoundException('Game not found');
    }
    const game = await this.model.findById(gameId).exec();
    if (!game) throw new NotFoundException('Game not found');
    return game;
  }

  private seatOf(game: TienLenGameDocument, userId: string): TienLenSeat | null {
    return game.seats.find((s) => s.userId.toString() === userId) ?? null;
  }

  private activeSeats(game: TienLenGameDocument): TienLenSeat[] {
    return game.seats.filter((s) => s.handCount > 0);
  }

  // ── Moves ─────────────────────────────────────────────────────
  async play(gameId: string, userId: string, cards: number[]): Promise<any> {
    const game = await this.getGameOrThrow(gameId);
    if (game.status !== TienLenStatus.ACTIVE) {
      throw new BadRequestException('Game is not active');
    }
    const seat = this.seatOf(game, userId);
    if (!seat) throw new ForbiddenException('Not a player in this game');
    if (game.turn !== seat.seat) throw new BadRequestException('Not your turn');
    if (!Array.isArray(cards) || cards.length === 0) {
      throw new BadRequestException('No cards played');
    }

    const combo = identifyCombo(cards);
    if (!combo) throw new BadRequestException('Invalid card combination');

    // First play of the whole game must contain the lowest dealt card.
    const isOpening = game.history.length === 0;
    if (isOpening && !cards.includes(game.openingCard)) {
      throw new BadRequestException('First play must contain the lowest dealt card');
    }

    const current = this.currentComboObj(game);
    if (!isOpening && !canBeat(combo, current)) {
      throw new BadRequestException('Your combo does not beat the table');
    }

    const newHand = removeCards(seat.hand, cards);
    if (!newHand) throw new BadRequestException('You do not have those cards');

    // Detect "chặt heo" BEFORE applyPlay mutates leadSeat (the victim is the
    // current combo owner whose 2/2s are being chopped by a bomb).
    const heoCount = detectChop(combo, current);
    let chopEvent: { chopper: string; victim: string; heoCount: number } | null =
      null;
    if (heoCount > 0 && game.leadSeat >= 0) {
      const victimSeat = game.seats[game.leadSeat];
      if (victimSeat && victimSeat.userId.toString() !== userId) {
        chopEvent = {
          chopper: userId,
          victim: victimSeat.userId.toString(),
          heoCount,
        };
        game.chops.push({ ...chopEvent, at: new Date() });
        game.markModified('chops');
      }
    }

    this.applyPlay(game, seat, combo, newHand);

    await game.save();
    this.broadcast(gameId, 'tienlen:play', {
      gameId,
      seat: seat.seat,
      userId,
      cards: combo.cards,
      comboType: combo.type,
      handCount: seat.handCount,
      nextTurn: game.turn,
      currentCombo: game.currentCombo,
      chop: chopEvent,
    });

    // Apply the chop penalty (coins in WAGER, RP in RANKED) immediately.
    if (chopEvent) {
      await this.applyChopPenalty(game, chopEvent.chopper, chopEvent.victim, chopEvent.heoCount);
    }

    if (this.maybeFinish(game)) {
      await this.finish(game);
      return this.publicView(game, userId);
    }
    await game.save();
    this.startTurnTimer(gameId);
    return this.publicView(game, userId);
  }

  /**
   * Penalises a "chặt heo": in WAGER mode the victim pays the chopper coins;
   * in RANKED mode the victim loses RP and the chopper gains it. Amounts come
   * from config (per heo chopped). Best-effort; never blocks gameplay.
   */
  private async applyChopPenalty(
    game: TienLenGameDocument,
    chopperId: string,
    victimId: string,
    heoCount: number,
  ): Promise<void> {
    const tl = this.config.get('games.tienlen') as
      | { chopHeoCoins: number; chopHeoRp: number }
      | undefined;
    const coinPerHeo = tl?.chopHeoCoins ?? 50;
    const rpPerHeo = tl?.chopHeoRp ?? 5;
    try {
      if (game.mode === GameMode.WAGER) {
        const amount = coinPerHeo * heoCount;
        // Victim pays chopper. Guarded debit: if the victim can't afford it,
        // transfer whatever they have (best-effort) — debit throws on shortfall.
        const ref = `tienlen-chop:${game._id.toString()}`;
        const debited = await this.wager
          .collectStake(victimId, amount, ref)
          .then(() => true)
          .catch(() => false);
        if (debited) {
          await this.wager.payout(chopperId, amount, ref).catch(() => undefined);
          this.broadcast(game._id.toString(), 'tienlen:chop', {
            gameId: game._id.toString(),
            chopper: chopperId,
            victim: victimId,
            heoCount,
            coins: amount,
          });
        }
      } else if (game.mode === GameMode.RANKED) {
        const amount = rpPerHeo * heoCount;
        await Promise.all([
          this.leveling.addRankPoints(chopperId, amount, 'tienlen_chop'),
          this.leveling.addRankPoints(victimId, -amount, 'tienlen_chopped'),
        ]);
        this.broadcast(game._id.toString(), 'tienlen:chop', {
          gameId: game._id.toString(),
          chopper: chopperId,
          victim: victimId,
          heoCount,
          rp: amount,
        });
      }
    } catch (e) {
      this.logger.warn(`chop penalty failed: ${(e as Error).message}`);
    }
  }

  async pass(gameId: string, userId: string): Promise<any> {
    const game = await this.getGameOrThrow(gameId);
    if (game.status !== TienLenStatus.ACTIVE) {
      throw new BadRequestException('Game is not active');
    }
    const seat = this.seatOf(game, userId);
    if (!seat) throw new ForbiddenException('Not a player in this game');
    if (game.turn !== seat.seat) throw new BadRequestException('Not your turn');
    if (game.currentCombo.length === 0) {
      throw new BadRequestException('You must lead — cannot pass on a free turn');
    }
    this.applyPass(game, seat);
    await game.save();
    this.broadcast(gameId, 'tienlen:pass', {
      gameId,
      seat: seat.seat,
      userId,
      nextTurn: game.turn,
      trickReset: game.currentCombo.length === 0,
    });
    this.startTurnTimer(gameId);
    return this.publicView(game, userId);
  }

  // ── Core trick mechanics ──────────────────────────────────────
  private currentComboObj(game: TienLenGameDocument): Combo | null {
    if (!game.currentCombo.length) return null;
    return identifyCombo(game.currentCombo);
  }

  private applyPlay(
    game: TienLenGameDocument,
    seat: TienLenSeat,
    combo: Combo,
    newHand: number[],
  ): void {
    seat.hand = newHand;
    seat.handCount = newHand.length;
    game.currentCombo = combo.cards;
    game.currentComboType = combo.type;
    game.leadSeat = seat.seat;
    // A new combo on the table: everyone else may respond again.
    game.seats.forEach((s) => {
      if (s.handCount > 0) s.passed = false;
    });
    game.history.push({
      seat: seat.seat,
      userId: seat.userId,
      cards: combo.cards,
      comboType: combo.type,
      at: new Date(),
    });
    // Player emptied their hand -> they finish.
    if (seat.handCount === 0) {
      seat.finishedRank = game.finishOrder.length + 1;
      game.finishOrder.push(seat.seat);
    }
    game.markModified('seats');
    this.advanceTurn(game, seat.seat);
  }

  private applyPass(game: TienLenGameDocument, seat: TienLenSeat): void {
    seat.passed = true;
    game.history.push({
      seat: seat.seat,
      userId: seat.userId,
      cards: [],
      at: new Date(),
    });
    game.markModified('seats');
    this.advanceTurn(game, seat.seat);
  }

  /**
   * Advances the turn after an action by `fromSeat`. Resolves end-of-trick:
   * when every other active player has passed (or we wrap to the combo owner),
   * the lead player wins the trick and leads a new one.
   */
  private advanceTurn(game: TienLenGameDocument, fromSeat: number): void {
    const n = game.seats.length;
    for (let i = 1; i <= n; i++) {
      const cand = (fromSeat + i) % n;
      const s = game.seats[cand];
      if (s.handCount === 0) continue; // finished player, skip
      if (cand === game.leadSeat) {
        // Came back to the combo owner -> trick over.
        this.resetTrick(game);
        return;
      }
      if (s.passed) continue;
      game.turn = cand;
      return;
    }
    // No eligible responder remains -> trick over.
    this.resetTrick(game);
  }

  /** Lead player wins the trick and leads next (free play). */
  private resetTrick(game: TienLenGameDocument): void {
    game.currentCombo = [];
    game.currentComboType = undefined;
    game.seats.forEach((s) => (s.passed = false));
    const lead = game.seats[game.leadSeat];
    if (lead && lead.handCount > 0) {
      game.turn = game.leadSeat;
    } else {
      // Lead finished — control passes to the next active player after them.
      game.turn = this.nextActiveSeat(game, game.leadSeat);
    }
    game.markModified('seats');
  }

  private nextActiveSeat(game: TienLenGameDocument, from: number): number {
    const n = game.seats.length;
    for (let i = 1; i <= n; i++) {
      const cand = (from + i) % n;
      if (game.seats[cand].handCount > 0) return cand;
    }
    return from;
  }

  /** True when only one (or zero) active players remain — game is over. */
  private maybeFinish(game: TienLenGameDocument): boolean {
    return this.activeSeats(game).length <= 1;
  }

  // ── Turn timer (auto pass / auto lead) ────────────────────────
  private startTurnTimer(gameId: string): void {
    this.clearTimer(gameId);
    this.timers.set(
      gameId,
      setTimeout(() => {
        void this.onTimeout(gameId);
      }, TL_TURN_SECONDS * 1000),
    );
  }

  private clearTimer(gameId: string): void {
    const t = this.timers.get(gameId);
    if (t) clearTimeout(t);
    this.timers.delete(gameId);
  }

  private async onTimeout(gameId: string): Promise<void> {
    try {
      const game = await this.model.findById(gameId).exec();
      if (!game || game.status !== TienLenStatus.ACTIVE) return;
      const seat = game.seats[game.turn];
      if (!seat || seat.handCount === 0) return;
      const userId = seat.userId.toString();
      if (game.currentCombo.length === 0) {
        // Free lead: auto-play the lowest card. On the opening, that lowest
        // card is also the required opening card.
        const card = seat.hand[0];
        await this.play(gameId, userId, [card]).catch(() => undefined);
      } else {
        await this.pass(gameId, userId).catch(() => undefined);
      }
    } catch (e) {
      this.logger.warn(`tienlen timeout: ${(e as Error).message}`);
    }
  }

  // ── Resign / disconnect ───────────────────────────────────────
  async resign(gameId: string, userId: string): Promise<any> {
    const game = await this.getGameOrThrow(gameId);
    if (game.status !== TienLenStatus.ACTIVE) {
      throw new BadRequestException('Game is not active');
    }
    const seat = this.seatOf(game, userId);
    if (!seat) throw new ForbiddenException('Not a player in this game');
    if (seat.handCount === 0) throw new BadRequestException('Already finished');
    // Resigning player forfeits (placed at the bottom of the final ranking).
    this.forceFinishLast(game, seat);
    if (this.maybeFinish(game)) {
      await this.finish(game);
    } else {
      const wasLead = game.leadSeat === seat.seat;
      const wasTurn = game.turn === seat.seat;
      if (wasLead) {
        // The lead resigned -> the trick is dead; next active player leads fresh.
        game.leadSeat = this.nextActiveSeat(game, seat.seat);
        this.resetTrick(game);
      } else if (wasTurn) {
        // It was their turn mid-trick -> just hand the turn to the next active
        // player (the table combo still stands and must be beaten).
        game.turn = this.nextActiveSeat(game, seat.seat);
      }
      await game.save();
      this.startTurnTimer(gameId);
      this.broadcast(gameId, 'tienlen:resigned', {
        gameId,
        userId,
        seat: seat.seat,
        nextTurn: game.turn,
      });
    }
    return this.publicView(game, userId);
  }

  /** Marks a seat as resigned/forfeited. Recorded separately so they end up
   * at the BOTTOM of the final ranking, never as a winner. */
  private forceFinishLast(game: TienLenGameDocument, seat: TienLenSeat): void {
    seat.handCount = 0;
    seat.hand = [];
    seat.finishedRank = 0; // computed at finish()
    if (!game.resignedSeats.includes(seat.seat)) {
      game.resignedSeats.push(seat.seat);
    }
    game.markModified('seats');
    game.markModified('resignedSeats');
  }

  async onReconnect(gameId: string, userId: string): Promise<void> {
    const game = await this.model.findById(gameId).exec();
    if (!game) return;
    const seat = this.seatOf(game, userId);
    if (seat) {
      seat.connected = true;
      game.markModified('seats');
      await game.save();
    }
    this.broadcast(gameId, 'tienlen:player-reconnected', { gameId, userId });
  }

  async onDisconnect(gameId: string, userId: string): Promise<void> {
    const game = await this.model.findById(gameId).exec();
    if (!game || game.status !== TienLenStatus.ACTIVE) return;
    const seat = this.seatOf(game, userId);
    if (seat) {
      seat.connected = false;
      game.markModified('seats');
      await game.save();
    }
    // The turn timer keeps the game moving (auto-pass) while they're away.
    this.broadcast(gameId, 'tienlen:player-disconnected', { gameId, userId });
  }

  // ── Finishing + rewards ───────────────────────────────────────
  private async finish(game: TienLenGameDocument): Promise<void> {
    this.clearTimer(game._id.toString());
    // Build the FINAL standing:
    //  1) players who emptied their hand, in the order they did (finishOrder)
    //  2) the one remaining active player (if any) — the best of those who
    //     never resigned and still had cards
    //  3) resigned players at the very bottom (earliest resigner = last place)
    const remaining = this.activeSeats(game).map((s) => s.seat);
    const resignedBottom = [...game.resignedSeats].reverse(); // latest resigner ranks above earlier ones
    const finalOrder: number[] = [];
    for (const s of game.finishOrder) if (!finalOrder.includes(s)) finalOrder.push(s);
    for (const s of remaining) if (!finalOrder.includes(s)) finalOrder.push(s);
    for (const s of resignedBottom) if (!finalOrder.includes(s)) finalOrder.push(s);
    // Safety: include any seat not yet placed.
    for (const s of game.seats)
      if (!finalOrder.includes(s.seat)) finalOrder.push(s.seat);
    game.finishOrder = finalOrder;
    game.seats.forEach((s) => {
      s.finishedRank = finalOrder.indexOf(s.seat) + 1;
    });
    game.markModified('seats');
    game.status = TienLenStatus.FINISHED;
    game.endedAt = new Date();

    const n = game.seats.length;
    const placeOf = (seatIdx: number) => game.finishOrder.indexOf(seatIdx) + 1;

    if (game.mode === GameMode.RANKED) {
      const rpChange: Record<string, number> = {};
      for (const s of game.seats) {
        const place = placeOf(s.seat); // 1..n
        // Linear score from +1 (1st) to -1 (last) -> RP delta.
        const score = n > 1 ? (n - 2 * place + 1) / (n - 1) : 0;
        const delta = Math.round(RP_SPREAD * score);
        rpChange[s.userId.toString()] = delta;
      }
      game.rpChange = rpChange;
      await Promise.all(
        game.seats.map((s) =>
          this.leveling.addRankPoints(
            s.userId.toString(),
            rpChange[s.userId.toString()],
            'tienlen',
          ),
        ),
      );
    } else if (game.mode === GameMode.WAGER && game.pot > 0) {
      // Winner (1st place) takes the entire pot.
      const winnerSeat = game.finishOrder[0];
      const winner = game.seats.find((s) => s.seat === winnerSeat);
      const coinChange: Record<string, number> = {};
      game.seats.forEach((s) => {
        coinChange[s.userId.toString()] = -game.betAmount;
      });
      if (winner) {
        coinChange[winner.userId.toString()] = game.pot - game.betAmount;
        await this.wager
          .payout(winner.userId.toString(), game.pot, `tienlen:${game._id.toString()}`)
          .catch((e) =>
            this.logger.warn(`tienlen payout failed: ${(e as Error).message}`),
          );
      }
      game.coinChange = coinChange;
    }

    await game.save();
    const view = await this.publicView(game);
    this.broadcast(game._id.toString(), 'tienlen:end', view);
    if (game.roomId) {
      await this.rooms.close(game.roomId.toString()).catch(() => undefined);
    }
  }

  /**
   * Ends the game immediately because `winnerSeat` was dealt a "tới trắng"
   * hand. Winner is 1st; everyone else shares last place equally. In WAGER
   * the winner takes the pot; in RANKED the winner gets the normal 1st-place
   * RP plus an instant-win bonus and others get the loser delta.
   */
  private async finishInstantWin(
    game: TienLenGameDocument,
    winnerSeat: number,
    winnerId: string,
    kind: InstantWin,
  ): Promise<void> {
    this.clearTimer(game._id.toString());
    // Winner first, then the others in seat order.
    game.finishOrder = [
      winnerSeat,
      ...game.seats.map((s) => s.seat).filter((s) => s !== winnerSeat),
    ];
    game.seats.forEach((s) => {
      s.finishedRank = game.finishOrder.indexOf(s.seat) + 1;
      if (s.seat !== winnerSeat) {
        // Losers don't reveal/lose their cards beyond the result.
      }
    });
    game.status = TienLenStatus.FINISHED;
    game.endedAt = new Date();
    game.instantWinUserId = winnerId;
    game.instantWinKind = kind;
    game.markModified('seats');

    const tl = this.config.get('games.tienlen') as
      | { instantWinRp: number }
      | undefined;
    const bonus = tl?.instantWinRp ?? 10;
    const n = game.seats.length;

    if (game.mode === GameMode.RANKED) {
      const rpChange: Record<string, number> = {};
      for (const s of game.seats) {
        const place = game.finishOrder.indexOf(s.seat) + 1;
        const score = n > 1 ? (n - 2 * place + 1) / (n - 1) : 0;
        let delta = Math.round(RP_SPREAD * score);
        if (s.seat === winnerSeat) delta += bonus; // instant-win bonus
        rpChange[s.userId.toString()] = delta;
      }
      game.rpChange = rpChange;
      await Promise.all(
        game.seats.map((s) =>
          this.leveling.addRankPoints(
            s.userId.toString(),
            rpChange[s.userId.toString()],
            'tienlen_instant',
          ),
        ),
      );
    } else if (game.mode === GameMode.WAGER && game.pot > 0) {
      const coinChange: Record<string, number> = {};
      game.seats.forEach((s) => {
        coinChange[s.userId.toString()] = -game.betAmount;
      });
      coinChange[winnerId] = game.pot - game.betAmount;
      await this.wager
        .payout(winnerId, game.pot, `tienlen:${game._id.toString()}`)
        .catch((e) =>
          this.logger.warn(`tienlen instant payout failed: ${(e as Error).message}`),
        );
      game.coinChange = coinChange;
    }

    await game.save();
    const view = await this.publicView(game);
    this.broadcast(game._id.toString(), 'tienlen:end', {
      ...view,
      instantWin: { userId: winnerId, kind },
    });
    if (game.roomId) {
      await this.rooms.close(game.roomId.toString()).catch(() => undefined);
    }
  }

  private broadcast(gameId: string, event: string, payload: unknown): void {
    this.realtime.emitToTienLenRoom(gameId, event, payload);
  }

  // ── Views ─────────────────────────────────────────────────────
  /**
   * Client-facing view. Each player's own hand is included only for the
   * `viewerId`; everyone else's cards are hidden (only `handCount`).
   */
  async publicView(
    game: TienLenGameDocument,
    viewerId?: string,
  ): Promise<any> {
    const ids = game.seats.map((s) => s.userId.toString());
    const cards = await this.users.getCards(ids);
    const placeOf = (seatIdx: number) => {
      const idx = game.finishOrder.indexOf(seatIdx);
      return idx >= 0 ? idx + 1 : null;
    };
    return {
      id: game._id.toString(),
      mode: game.mode,
      betAmount: game.betAmount,
      pot: game.pot,
      roomId: game.roomId?.toString() ?? null,
      status: game.status,
      turn: game.turn,
      turnSeconds: TL_TURN_SECONDS,
      openingCard: game.openingCard,
      currentCombo: game.currentCombo,
      currentComboType: game.currentComboType ?? null,
      leadSeat: game.leadSeat,
      finishOrder: game.finishOrder,
      rpChange: game.rpChange ?? null,
      coinChange: game.coinChange ?? null,
      chops: game.chops ?? [],
      instantWin: game.instantWinUserId
        ? { userId: game.instantWinUserId, kind: game.instantWinKind }
        : null,
      players: game.seats
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((s) => {
          const uid = s.userId.toString();
          return {
            seat: s.seat,
            userId: uid,
            user: cards.get(uid) ?? { id: uid, username: 'unknown' },
            handCount: s.handCount,
            passed: s.passed,
            connected: s.connected,
            place: placeOf(s.seat),
            // Reveal the hand only to its owner.
            hand: viewerId && uid === viewerId ? s.hand : undefined,
          };
        }),
      myHand: viewerId
        ? game.seats.find((s) => s.userId.toString() === viewerId)?.hand ?? null
        : null,
    };
  }

  // ── History ───────────────────────────────────────────────────
  async myActiveGame(userId: string): Promise<any | null> {
    const game = await this.model
      .findOne({
        status: TienLenStatus.ACTIVE,
        'seats.userId': new Types.ObjectId(userId),
      })
      .sort({ _id: -1 })
      .exec();
    return game ? this.publicView(game, userId) : null;
  }

  async history(userId: string, limit = 20): Promise<any[]> {
    const games = await this.model
      .find({
        status: TienLenStatus.FINISHED,
        'seats.userId': new Types.ObjectId(userId),
      })
      .sort({ _id: -1 })
      .limit(Math.min(limit, 50))
      .exec();
    return Promise.all(games.map((g) => this.publicView(g, userId)));
  }
}
