import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { RealtimeService } from '../../realtime/realtime.service';
import { LevelingService } from '../../leveling/leveling.service';
import { UsersService } from '../../users/users.service';
import { GameMode } from '../../common/enums';
import { WagerService } from '../common/wager.service';
import { RoomsService } from '../common/rooms.service';
import {
  BombermanGame,
  BombermanGameDocument,
  BombermanStatus,
} from './schemas/bomberman-game.schema';
import {
  BombermanState,
  createState,
  getMap,
  movePlayer,
  placeBomb,
  tickWorld,
  aliveCount,
  placements,
  BPlayer,
} from './bomberman.logic';

const TICK_HZ = 30; // 30Hz: chuyển động phản hồi nhanh hơn + nội suy người khác mượt hơn
const TICK_MS = 1000 / TICK_HZ;
const ROUND_LIMIT_MS = 3 * 60 * 1000; // 3 minutes hard cap → sudden death/draw
const RP_SPREAD = 28; // max RP swing for 1st vs last

interface LiveMatch {
  gameId: string;
  mode: GameMode;
  betAmount: number;
  pot: number;
  roomId?: string;
  mapId: string;
  state: BombermanState;
  loop: NodeJS.Timeout;
  lastTick: number;
  finished: boolean;
}

/**
 * Bomberman engine: keeps live matches in memory and runs a per-match game
 * loop at TICK_HZ, broadcasting state snapshots over /ws-bomberman. Only the
 * final result is persisted (for history + rank/wallet). Authoritative — the
 * client only sends inputs (move direction, place bomb).
 */
@Injectable()
export class BombermanService {
  private readonly logger = new Logger(BombermanService.name);
  private matches = new Map<string, LiveMatch>();

  constructor(
    @InjectModel(BombermanGame.name)
    private readonly model: Model<BombermanGameDocument>,
    private readonly realtime: RealtimeService,
    private readonly leveling: LevelingService,
    private readonly users: UsersService,
    private readonly wager: WagerService,
    private readonly rooms: RoomsService,
  ) {}

  // ── Creation ──────────────────────────────────────────────────
  async createGame(
    playerIds: string[],
    opts: { mode?: GameMode; betAmount?: number; roomId?: string; mapId?: string } = {},
  ): Promise<BombermanGameDocument> {
    if (playerIds.length < 2 || playerIds.length > 4) {
      throw new BadRequestException('Bomberman requires 2-4 players');
    }
    const mode = opts.mode ?? GameMode.RANKED;
    const betAmount = mode === GameMode.WAGER ? Math.floor(opts.betAmount ?? 0) : 0;
    const mapId = getMap(opts.mapId).id;
    const doc = await this.model.create({
      players: playerIds.map((id) => new Types.ObjectId(id)),
      mapId,
      mode,
      betAmount,
      pot: betAmount * playerIds.length,
      roomId: opts.roomId ? new Types.ObjectId(opts.roomId) : undefined,
      status: BombermanStatus.ACTIVE,
      placements: {},
      rankingUserIds: [],
    });
    const gameId = doc._id.toString();
    const now = Date.now();
    const state = createState(mapId, playerIds, now);

    const match: LiveMatch = {
      gameId,
      mode,
      betAmount,
      pot: betAmount * playerIds.length,
      roomId: opts.roomId,
      mapId,
      state,
      lastTick: now,
      finished: false,
      loop: setInterval(() => this.tick(gameId), TICK_MS),
    };
    this.matches.set(gameId, match);

    // Notify all players to navigate in.
    const view = await this.matchedView(match);
    playerIds.forEach((uid) => this.realtime.emitToBombermanUser(uid, 'bomberman:matched', view));
    return doc;
  }

  async launchFromRoom(room: {
    id: string;
    mode: GameMode;
    betAmount: number;
    memberIds: string[];
    mapId?: string;
  }): Promise<BombermanGameDocument> {
    const doc = await this.createGame(room.memberIds, {
      mode: room.mode,
      betAmount: room.betAmount,
      roomId: room.id,
      mapId: room.mapId,
    });
    await this.rooms.markInProgress(room.id, doc._id.toString());
    return doc;
  }

  // ── Input from clients ────────────────────────────────────────
  setInput(gameId: string, userId: string, dx: number, dy: number): void {
    const m = this.matches.get(gameId);
    if (!m || m.finished) return;
    const p = m.state.players.find((pl) => pl.userId === userId);
    if (!p || !p.alive) return;
    p.input = {
      dx: Math.max(-1, Math.min(1, Math.round(dx))),
      dy: Math.max(-1, Math.min(1, Math.round(dy))),
    };
  }

  placeBomb(gameId: string, userId: string): void {
    const m = this.matches.get(gameId);
    if (!m || m.finished) return;
    const p = m.state.players.find((pl) => pl.userId === userId);
    if (!p) return;
    const bomb = placeBomb(m.state, p, Date.now());
    if (bomb) {
      this.broadcast(gameId, 'bomberman:bomb', { col: bomb.col, row: bomb.row, ownerId: bomb.ownerId, fuseMs: bomb.fuseAt - Date.now() });
    }
  }

  /** A player leaves / disconnects → mark dead so the match can resolve. */
  killPlayer(gameId: string, userId: string): void {
    const m = this.matches.get(gameId);
    if (!m || m.finished) return;
    const p = m.state.players.find((pl) => pl.userId === userId);
    if (!p || !p.alive) return;
    p.alive = false;
    p.diedAt = Date.now();
    if (!m.state.deathOrder.includes(p.seat)) m.state.deathOrder.push(p.seat);
  }

  // ── Game loop ─────────────────────────────────────────────────
  private tick(gameId: string): void {
    const m = this.matches.get(gameId);
    if (!m || m.finished) return;
    const now = Date.now();
    const dt = Math.min(0.1, (now - m.lastTick) / 1000);
    m.lastTick = now;

    // movement
    for (const p of m.state.players) movePlayer(m.state, p, dt);

    // world (bombs/flames/pickups/deaths)
    const res = tickWorld(m.state, now);
    if (res.explosion && res.explosion.detonated.length) {
      this.broadcast(gameId, 'bomberman:explode', {
        flames: m.state.flames.map((f) => ({ col: f.col, row: f.row })),
        destroyed: res.explosion.destroyedBricks.map((b) => ({ col: b.col, row: b.row, drop: b.drop ?? null })),
      });
    }
    for (const pk of res.pickups) {
      this.broadcast(gameId, 'bomberman:pickup', { seat: pk.seat, type: pk.type });
    }
    for (const seat of res.deaths) {
      this.broadcast(gameId, 'bomberman:death', { seat });
    }

    // win condition: 0 or 1 alive, or time limit
    const alive = aliveCount(m.state);
    const timeUp = now - m.state.startedAt > ROUND_LIMIT_MS;
    if (alive <= 1 || timeUp) {
      void this.finish(gameId);
      return;
    }

    // broadcast lightweight snapshot every tick
    this.broadcast(gameId, 'bomberman:state', this.snapshot(m));
  }

  // ── Snapshots / views ─────────────────────────────────────────
  private snapshot(m: LiveMatch): any {
    const s = m.state;
    return {
      t: Date.now(),
      players: s.players.map((p) => ({
        seat: p.seat,
        userId: p.userId,
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
        alive: p.alive,
        dx: p.input.dx,
        dy: p.input.dy,
        bombs: p.maxBombs,
        flame: p.flame,
        speedTiles: Math.round(p.speed * 100) / 100,
      })),
      bombs: s.bombs.map((b) => ({ col: b.col, row: b.row, ownerId: b.ownerId, fuseMs: Math.max(0, b.fuseAt - Date.now()) })),
      flames: s.flames.map((f) => ({ col: f.col, row: f.row })),
      powerups: s.powerups.map((u) => ({ col: u.col, row: u.row, type: u.type })),
    };
  }

  /** Full "matched" view: includes the static map grid + player cards. */
  private async matchedView(m: LiveMatch): Promise<any> {
    const cards = await this.users.getCards(m.state.players.map((p) => p.userId));
    return {
      id: m.gameId,
      mapId: m.mapId,
      cols: m.state.cols,
      rows: m.state.rows,
      grid: m.state.grid,
      mode: m.mode,
      betAmount: m.betAmount,
      pot: m.pot,
      roomId: m.roomId ?? null,
      status: 'ACTIVE',
      tickHz: TICK_HZ,
      roundLimitMs: ROUND_LIMIT_MS,
      startedAt: m.state.startedAt,
      players: m.state.players.map((p) => ({
        seat: p.seat,
        userId: p.userId,
        user: cards.get(p.userId) ?? { id: p.userId, username: 'unknown' },
        spawn: { col: Math.round(p.x), row: Math.round(p.y) },
      })),
    };
  }

  /** Returns the live "matched" view for reconnection, or null if not live. */
  async liveView(gameId: string): Promise<any | null> {
    const m = this.matches.get(gameId);
    if (!m) return null;
    const view = await this.matchedView(m);
    return { ...view, snapshot: this.snapshot(m), grid: m.state.grid };
  }

  // ── Finishing ─────────────────────────────────────────────────
  private async finish(gameId: string): Promise<void> {
    const m = this.matches.get(gameId);
    if (!m || m.finished) return;
    m.finished = true;
    clearInterval(m.loop);

    // ensure all-but-winner are in deathOrder; the lone survivor (if any) wins.
    const placeMap = placements(m.state); // seat -> rank
    const seatToUser = new Map(m.state.players.map((p) => [p.seat, p.userId]));
    const ranking = [...placeMap.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([seat]) => seatToUser.get(seat)!)
      .filter(Boolean);
    const winnerId = ranking[0];
    const n = m.state.players.length;

    const placementsByUser: Record<string, number> = {};
    placeMap.forEach((rank, seat) => {
      const uid = seatToUser.get(seat);
      if (uid) placementsByUser[uid] = rank;
    });

    let rpChange: Record<string, number> | undefined;
    let coinChange: Record<string, number> | undefined;

    if (m.mode === GameMode.RANKED) {
      rpChange = {};
      for (const [uid, place] of Object.entries(placementsByUser)) {
        const score = n > 1 ? (n - 2 * place + 1) / (n - 1) : 0; // +1..-1
        rpChange[uid] = Math.round(RP_SPREAD * score);
      }
      await Promise.all(
        Object.entries(rpChange).map(([uid, delta]) =>
          this.leveling.addRankPoints(uid, delta, 'bomberman').catch(() => undefined),
        ),
      );
    } else if (m.mode === GameMode.WAGER && m.pot > 0) {
      coinChange = {};
      m.state.players.forEach((p) => (coinChange![p.userId] = -m.betAmount));
      if (winnerId) {
        coinChange[winnerId] = m.pot - m.betAmount;
        await this.wager
          .payout(winnerId, m.pot, `bomberman:${gameId}`)
          .catch((e) => this.logger.warn(`bomberman payout failed: ${(e as Error).message}`));
      }
    }

    // persist result
    await this.model
      .findByIdAndUpdate(gameId, {
        status: BombermanStatus.FINISHED,
        winner: winnerId ? new Types.ObjectId(winnerId) : undefined,
        placements: placementsByUser,
        rankingUserIds: ranking,
        rpChange,
        coinChange,
        endedAt: new Date(),
      })
      .exec()
      .catch(() => undefined);

    const cards = await this.users.getCards(m.state.players.map((p) => p.userId));
    const view = {
      id: gameId,
      status: 'FINISHED',
      mode: m.mode,
      pot: m.pot,
      winner: winnerId ?? null,
      placements: placementsByUser,
      ranking: ranking.map((uid) => ({ userId: uid, user: cards.get(uid) ?? { id: uid, username: 'unknown' }, place: placementsByUser[uid] })),
      rpChange: rpChange ?? null,
      coinChange: coinChange ?? null,
    };
    this.broadcast(gameId, 'bomberman:end', view);
    if (m.roomId) await this.rooms.close(m.roomId).catch(() => undefined);

    // free memory shortly after (allow late reconnects to read the end view via REST).
    setTimeout(() => this.matches.delete(gameId), 15000);
  }

  // ── History / reconnect ───────────────────────────────────────
  async myActiveGame(userId: string): Promise<any | null> {
    // live, in-memory match this user belongs to
    for (const m of this.matches.values()) {
      if (!m.finished && m.state.players.some((p) => p.userId === userId)) {
        return this.liveView(m.gameId);
      }
    }
    return null;
  }

  async history(userId: string, limit = 20): Promise<any[]> {
    const uid = new Types.ObjectId(userId);
    const games = await this.model
      .find({ status: BombermanStatus.FINISHED, players: uid })
      .sort({ _id: -1 })
      .limit(Math.min(limit, 50))
      .exec();
    const allIds = new Set<string>();
    games.forEach((g) => g.players.forEach((p) => allIds.add(p.toString())));
    const cards = await this.users.getCards([...allIds]);
    return games.map((g) => ({
      id: g._id.toString(),
      mapId: g.mapId,
      mode: g.mode,
      betAmount: g.betAmount,
      pot: g.pot,
      winner: g.winner?.toString() ?? null,
      placements: g.placements,
      rpChange: g.rpChange ?? null,
      coinChange: g.coinChange ?? null,
      players: g.players.map((p) => ({ userId: p.toString(), user: cards.get(p.toString()) ?? { id: p.toString(), username: 'unknown' }, place: g.placements?.[p.toString()] ?? null })),
      endedAt: g.endedAt,
    }));
  }

  private broadcast(gameId: string, event: string, payload: unknown): void {
    this.realtime.emitToBombermanRoom(gameId, event, payload);
  }
}
