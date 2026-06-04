import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { RealtimeService } from '../realtime/realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import { levelFromXp, levelProgress } from './level.util';

export type LeaderboardKind = 'xp' | 'coins';

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

  // ── Leaderboards ──────────────────────────────────────────────

  /**
   * Top users by XP or coins, with absolute rank. Returns enriched cards.
   */
  async leaderboard(kind: LeaderboardKind, limit = 50) {
    const sortField = kind === 'coins' ? 'balance' : 'xp';
    const lim = Math.min(Math.max(limit, 1), 100);
    const users = await this.userModel
      .find({}, { username: 1, displayName: 1, avatarUrl: 1, xp: 1, level: 1, balance: 1 })
      .sort({ [sortField]: -1, _id: 1 })
      .limit(lim)
      .exec();
    return users.map((u, i) => this.entry(u, i + 1, kind));
  }

  /** The caller's own rank on a leaderboard (1-based), plus their card. */
  async myRank(userId: string, kind: LeaderboardKind) {
    const sortField = kind === 'coins' ? 'balance' : 'xp';
    const me = await this.userModel.findById(userId).exec();
    if (!me) return null;
    const myValue = kind === 'coins' ? me.balance : me.xp;
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

  private entry(u: UserDocument, rank: number, kind: LeaderboardKind) {
    const progress = levelProgress(u.xp ?? 0);
    return {
      rank,
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
      score: kind === 'coins' ? u.balance ?? 0 : u.xp ?? 0,
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
