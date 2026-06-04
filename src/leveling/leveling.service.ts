import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { RealtimeService } from '../realtime/realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import { levelFromXp, levelProgress } from './level.util';
import { rankFromRp } from './rank.util';

export type LeaderboardKind = 'xp' | 'coins' | 'rank';

@Injectable()
export class LevelingService {
  private readonly logger = new Logger(LevelingService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Atomically adds XP to a user, recomputes the level, and emits realtime
   * events (`level:xp` always, `level:up` when the level increases).
   * Best-effort: never throws into the caller's flow.
   */
  async addXp(
    userId: string | Types.ObjectId,
    amount: number,
    reason?: string,
  ): Promise<{ level: number; xp: number; leveledUp: boolean } | null> {
    if (!amount || amount <= 0) return null;
    try {
      const uid = new Types.ObjectId(userId);
      // Atomic increment, then reconcile the denormalized level field.
      const updated = await this.userModel
        .findByIdAndUpdate(uid, { $inc: { xp: amount } }, { new: true })
        .exec();
      if (!updated) return null;

      const newLevel = levelFromXp(updated.xp);
      const prevLevel = updated.level ?? 1;
      const leveledUp = newLevel > prevLevel;
      if (newLevel !== prevLevel) {
        await this.userModel
          .updateOne({ _id: uid }, { level: newLevel })
          .exec();
      }

      const progress = levelProgress(updated.xp);
      const uidStr = uid.toString();

      // Always tell the user their XP changed (progress bar update).
      this.realtime.emitToUser(uidStr, 'level:xp', {
        ...progress,
        gained: amount,
        reason,
      });

      if (leveledUp) {
        this.realtime.emitToUser(uidStr, 'level:up', {
          level: newLevel,
          previousLevel: prevLevel,
          xp: updated.xp,
        });
        // Broadcast to every server the user is in (others can celebrate).
        const serverIds = await this.serverIdsOf(uidStr);
        serverIds.forEach((sid) =>
          this.realtime.emitToServer(sid, 'level:up', {
            serverId: sid,
            userId: uidStr,
            level: newLevel,
          }),
        );
        // Persistent notification.
        this.notifications
          .create(uidStr, 'LEVEL_UP', { level: newLevel })
          .catch(() => undefined);
      }

      return { level: newLevel, xp: updated.xp, leveledUp };
    } catch (err) {
      this.logger.warn(`addXp failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Level + progress for a single user. */
  async getProgress(userId: string) {
    const user = await this.userModel
      .findById(userId, { xp: 1, level: 1 })
      .exec();
    const xp = user?.xp ?? 0;
    return levelProgress(xp);
  }

  /** Rank (tier/division from RP) for a single user. */
  async getRank(userId: string) {
    const user = await this.userModel
      .findById(userId, { rankPoints: 1 })
      .exec();
    return rankFromRp(user?.rankPoints ?? 0);
  }

  /**
   * Adjusts a user's Rank Points (RP) — independent from XP. Positive to
   * gain, negative to lose (floored at 0). Emits `rank:changed` always and
   * `rank:promoted` / `rank:demoted` when the tier/division changes.
   */
  async addRankPoints(
    userId: string | Types.ObjectId,
    delta: number,
    reason?: string,
  ): Promise<{ rankPoints: number } | null> {
    if (!delta) return null;
    try {
      const uid = new Types.ObjectId(userId);
      const before = await this.userModel
        .findById(uid, { rankPoints: 1 })
        .exec();
      if (!before) return null;
      const prevRp = before.rankPoints ?? 0;
      const nextRp = Math.max(0, prevRp + delta);
      await this.userModel
        .updateOne({ _id: uid }, { rankPoints: nextRp })
        .exec();

      const prevRank = rankFromRp(prevRp);
      const nextRank = rankFromRp(nextRp);
      const uidStr = uid.toString();

      this.realtime.emitToUser(uidStr, 'rank:changed', {
        rank: nextRank,
        delta,
        reason,
      });

      // Compare a monotonically increasing "ladder index" to detect promote/demote.
      const ladder = (r: typeof nextRank) =>
        r.tierIndex * 1000 + (r.isApex ? r.rp : (4 - r.division) * 100);
      if (ladder(nextRank) > ladder(prevRank)) {
        this.realtime.emitToUser(uidStr, 'rank:promoted', {
          from: prevRank.label,
          to: nextRank.label,
          rank: nextRank,
        });
        this.notifications
          .create(uidStr, 'RANK_UP', { rank: nextRank.label })
          .catch(() => undefined);
      } else if (ladder(nextRank) < ladder(prevRank)) {
        this.realtime.emitToUser(uidStr, 'rank:demoted', {
          from: prevRank.label,
          to: nextRank.label,
          rank: nextRank,
        });
      }
      return { rankPoints: nextRp };
    } catch (err) {
      this.logger.warn(`addRankPoints failed: ${(err as Error).message}`);
      return null;
    }
  }

  // ── Leaderboards ──────────────────────────────────────────────

  /**
   * Top users by XP or coins, with absolute rank. Returns enriched cards.
   */
  async leaderboard(kind: LeaderboardKind, limit = 50) {
    const sortField = this.sortFieldOf(kind);
    const lim = Math.min(Math.max(limit, 1), 100);
    const users = await this.userModel
      .find(
        {},
        {
          username: 1,
          displayName: 1,
          avatarUrl: 1,
          xp: 1,
          level: 1,
          balance: 1,
          rankPoints: 1,
        },
      )
      .sort({ [sortField]: -1, _id: 1 })
      .limit(lim)
      .exec();
    return users.map((u, i) => this.entry(u, i + 1, kind));
  }

  /** The caller's own rank on a leaderboard (1-based), plus their card. */
  async myRank(userId: string, kind: LeaderboardKind) {
    const sortField = this.sortFieldOf(kind);
    const me = await this.userModel.findById(userId).exec();
    if (!me) return null;
    const myValue = (me as any)[sortField] ?? 0;
    // Rank = (# users strictly greater) + 1. Ties broken by _id ascending,
    // matching the leaderboard sort.
    const greater = await this.userModel
      .countDocuments({
        $or: [
          { [sortField]: { $gt: myValue } },
          { [sortField]: myValue, _id: { $lt: me._id } },
        ],
      })
      .exec();
    return this.entry(me, greater + 1, kind);
  }

  private sortFieldOf(kind: LeaderboardKind): string {
    if (kind === 'coins') return 'balance';
    if (kind === 'rank') return 'rankPoints';
    return 'xp';
  }

  private entry(u: UserDocument, position: number, kind: LeaderboardKind) {
    const progress = levelProgress(u.xp ?? 0);
    const rp = u.rankPoints ?? 0;
    const score =
      kind === 'coins' ? u.balance ?? 0 : kind === 'rank' ? rp : u.xp ?? 0;
    return {
      rank: position, // leaderboard position (1-based)
      userId: u._id.toString(),
      user: {
        id: u._id.toString(),
        username: u.username,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
      },
      level: progress.level,
      xp: u.xp ?? 0,
      coins: u.balance ?? 0,
      rankPoints: rp,
      tier: rankFromRp(rp), // game-style tier/division (independent of XP)
      score,
    };
  }

  /** Server ids a user belongs to (read directly to avoid a module cycle). */
  private async serverIdsOf(userId: string): Promise<string[]> {
    try {
      const docs = await this.userModel.db
        .collection('server_members')
        .find({ userId: new Types.ObjectId(userId) }, { projection: { serverId: 1 } })
        .toArray();
      return docs.map((d: any) => d.serverId.toString());
    } catch {
      return [];
    }
  }
}
