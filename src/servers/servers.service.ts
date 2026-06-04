import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { MemberRole } from '../common/enums';
import { TransactionService } from '../database/transaction.util';
import { RealtimeService } from '../realtime/realtime.service';
import { UsersService } from '../users/users.service';
import { Server, ServerDocument } from './schemas/server.schema';
import {
  ServerMember,
  ServerMemberDocument,
} from './schemas/server-member.schema';
import { ServerBan, ServerBanDocument } from './schemas/server-ban.schema';
import {
  CreateServerDto,
  UpdateMemberRoleDto,
  UpdateServerDto,
} from './dto/server.dto';

const ROLE_RANK: Record<MemberRole, number> = {
  [MemberRole.OWNER]: 3,
  [MemberRole.ADMIN]: 2,
  [MemberRole.MEMBER]: 1,
};

@Injectable()
export class ServersService implements OnModuleInit {
  private readonly logger = new Logger(ServersService.name);
  private defaultServerId?: string;

  constructor(
    @InjectModel(Server.name)
    private readonly serverModel: Model<ServerDocument>,
    @InjectModel(ServerMember.name)
    private readonly memberModel: Model<ServerMemberDocument>,
    @InjectModel(ServerBan.name)
    private readonly banModel: Model<ServerBanDocument>,
    private readonly users: UsersService,
    private readonly txService: TransactionService,
    private readonly config: ConfigService,
    private readonly realtime: RealtimeService,
  ) {}

  // ── Bootstrap the default server on startup ───────────────────
  async onModuleInit(): Promise<void> {
    await this.ensureDefaultServer();
  }

  /**
   * Resolves (or creates) the platform default server. Order of precedence:
   *  1. DEFAULT_SERVER_ID config -> mark that server as default.
   *  2. Any existing server flagged isDefault.
   *  3. Bootstrap a new one owned by DEFAULT_SERVER_OWNER_ID.
   */
  private async ensureDefaultServer(): Promise<void> {
    try {
      const configuredId = this.config.get<string>('defaultServer.id');
      if (configuredId && Types.ObjectId.isValid(configuredId)) {
        const server = await this.serverModel.findById(configuredId).exec();
        if (server) {
          if (!server.isDefault) {
            server.isDefault = true;
            await server.save();
          }
          this.defaultServerId = server._id.toString();
          this.logger.log(`Default server: ${this.defaultServerId}`);
          return;
        }
        this.logger.warn(
          `DEFAULT_SERVER_ID ${configuredId} not found; falling back`,
        );
      }

      const existing = await this.serverModel.findOne({ isDefault: true }).exec();
      if (existing) {
        this.defaultServerId = existing._id.toString();
        this.logger.log(`Default server: ${this.defaultServerId}`);
        return;
      }

      const ownerId = this.config.get<string>('defaultServer.ownerId');
      if (!ownerId || !Types.ObjectId.isValid(ownerId)) {
        this.logger.warn(
          'No default server configured and DEFAULT_SERVER_OWNER_ID invalid; skipping bootstrap',
        );
        return;
      }
      const created = await this.txService.withTransaction(async (session) => {
        const [server] = await this.serverModel.create(
          [
            {
              name: 'HTSS Club',
              ownerId: new Types.ObjectId(ownerId),
              isDefault: true,
            },
          ],
          { session },
        );
        await this.memberModel.create(
          [
            {
              serverId: server._id,
              userId: new Types.ObjectId(ownerId),
              role: MemberRole.OWNER,
            },
          ],
          { session },
        );
        return server;
      });
      this.defaultServerId = created._id.toString();
      this.logger.log(`Bootstrapped default server: ${this.defaultServerId}`);
    } catch (err) {
      this.logger.error(
        `Failed to ensure default server: ${(err as Error).message}`,
      );
    }
  }

  getDefaultServerId(): string | undefined {
    return this.defaultServerId;
  }

  isDefaultServer(serverId: string): boolean {
    return !!this.defaultServerId && this.defaultServerId === serverId;
  }

  /**
   * Adds a user to the default server if it exists and they are not already
   * a member. Safe to call on every registration. Returns the serverId or
   * null if there is no default server.
   */
  async addUserToDefaultServer(
    userId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<string | null> {
    if (!this.defaultServerId) return null;
    const serverId = new Types.ObjectId(this.defaultServerId);
    const uid = new Types.ObjectId(userId);
    const existing = await this.memberModel
      .findOne({ serverId, userId: uid })
      .session(session ?? null)
      .exec();
    if (existing) return this.defaultServerId;
    const [member] = await this.memberModel.create(
      [{ serverId, userId: uid, role: MemberRole.MEMBER }],
      { session },
    );
    // Notify existing members that a new user joined the default server.
    await this.broadcastMemberJoined(this.defaultServerId, member);
    return this.defaultServerId;
  }

  /**
   * Builds a full member card and broadcasts `server:member-joined` so other
   * members can render the new member immediately without an extra fetch.
   */
  private async broadcastMemberJoined(
    serverId: string,
    member: ServerMemberDocument,
  ): Promise<void> {
    const userId = member.userId.toString();
    const user = await this.users.findById(userId);
    this.realtime.emitToServer(serverId, 'server:member-joined', {
      serverId,
      userId,
      member: {
        userId,
        role: member.role,
        nickname: member.nickname,
        joinedAt: member.joinedAt,
        user: user ? this.users.toPublic(user) : null,
      },
    });
  }

  private oid(id: string, label = 'id'): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Invalid ${label}`);
    }
    return new Types.ObjectId(id);
  }

  // ── Membership / role resolution ──────────────────────────────
  async getMembership(
    serverId: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ): Promise<ServerMemberDocument | null> {
    return this.memberModel
      .findOne({
        serverId: new Types.ObjectId(serverId),
        userId: new Types.ObjectId(userId),
      })
      .exec();
  }

  async requireMembership(
    serverId: string,
    userId: string,
  ): Promise<ServerMemberDocument> {
    const member = await this.getMembership(serverId, userId);
    if (!member) {
      throw new ForbiddenException('Not a member of this server');
    }
    return member;
  }

  async requireRole(
    serverId: string,
    userId: string,
    minRole: MemberRole,
  ): Promise<ServerMemberDocument> {
    const member = await this.requireMembership(serverId, userId);
    if (ROLE_RANK[member.role] < ROLE_RANK[minRole]) {
      throw new ForbiddenException('Insufficient role');
    }
    return member;
  }

  // ── CRUD ──────────────────────────────────────────────────────
  async create(userId: string, dto: CreateServerDto) {
    return this.txService.withTransaction(async (session) => {
      const ownerId = new Types.ObjectId(userId);
      const [server] = await this.serverModel.create(
        [{ name: dto.name, iconUrl: dto.iconUrl, ownerId }],
        { session },
      );
      await this.memberModel.create(
        [{ serverId: server._id, userId: ownerId, role: MemberRole.OWNER }],
        { session },
      );
      return server.toJSON();
    });
  }

  async listForUser(userId: string): Promise<any[]> {
    const memberships = await this.memberModel
      .find({ userId: new Types.ObjectId(userId) })
      .exec();
    const serverIds = memberships.map((m) => m.serverId);
    const servers = await this.serverModel
      .find({ _id: { $in: serverIds } })
      .exec();
    const roleByServer = new Map(
      memberships.map((m) => [m.serverId.toString(), m.role]),
    );
    return servers.map((s) => ({
      ...s.toJSON(),
      myRole: roleByServer.get(s._id.toString()),
    }));
  }

  async getDetail(serverId: string, userId: string): Promise<any> {
    await this.requireMembership(serverId, userId);
    const server = await this.serverModel.findById(serverId).exec();
    if (!server) throw new NotFoundException('Server not found');
    const members = await this.listMembers(serverId, userId);
    return { ...server.toJSON(), members };
  }

  async update(serverId: string, userId: string, dto: UpdateServerDto) {
    await this.requireRole(serverId, userId, MemberRole.ADMIN);
    const update: Partial<Server> = {};
    if (dto.name !== undefined) update.name = dto.name;
    if (dto.iconUrl !== undefined) update.iconUrl = dto.iconUrl;
    const server = await this.serverModel
      .findByIdAndUpdate(serverId, update, { new: true })
      .exec();
    if (!server) throw new NotFoundException('Server not found');
    this.realtime.emitToServer(serverId, 'server:updated', server.toJSON());
    return server.toJSON();
  }

  async remove(serverId: string, userId: string) {
    await this.requireRole(serverId, userId, MemberRole.OWNER);
    if (this.isDefaultServer(serverId)) {
      throw new ForbiddenException('The default server cannot be deleted');
    }
    // Note: channels & messages cleanup is handled by ChannelsService
    // cascade (invoked from the controller) or a background job.
    return this.txService.withTransaction(async (session) => {
      const sid = new Types.ObjectId(serverId);
      await this.serverModel.findByIdAndDelete(sid, { session }).exec();
      await this.memberModel.deleteMany({ serverId: sid }, { session }).exec();
      await this.banModel.deleteMany({ serverId: sid }, { session }).exec();
      return { deleted: true };
    });
  }

  async createInvite(serverId: string, userId: string) {
    await this.requireRole(serverId, userId, MemberRole.ADMIN);
    const code = randomBytes(6).toString('base64url');
    const server = await this.serverModel
      .findByIdAndUpdate(serverId, { inviteCode: code }, { new: true })
      .exec();
    if (!server) throw new NotFoundException('Server not found');
    return { inviteCode: code };
  }

  /** Revokes the current invite code (ADMIN+). */
  async revokeInvite(serverId: string, userId: string) {
    await this.requireRole(serverId, userId, MemberRole.ADMIN);
    const server = await this.serverModel
      .findByIdAndUpdate(serverId, { $unset: { inviteCode: '' } }, { new: true })
      .exec();
    if (!server) throw new NotFoundException('Server not found');
    return { revoked: true };
  }

  async join(userId: string, inviteCode: string) {
    const server = await this.serverModel.findOne({ inviteCode }).exec();
    if (!server) throw new NotFoundException('Invalid invite code');
    // Blocked from joining if banned.
    const banned = await this.banModel
      .findOne({ serverId: server._id, userId: new Types.ObjectId(userId) })
      .exec();
    if (banned) {
      throw new ForbiddenException('You are banned from this server');
    }
    const existing = await this.getMembership(server._id, userId);
    if (existing) {
      throw new BadRequestException('Already a member');
    }
    const member = await this.memberModel.create({
      serverId: server._id,
      userId: new Types.ObjectId(userId),
      role: MemberRole.MEMBER,
    });
    await this.broadcastMemberJoined(server._id.toString(), member);
    return server.toJSON();
  }

  async leave(serverId: string, userId: string) {
    const member = await this.requireMembership(serverId, userId);
    if (this.isDefaultServer(serverId)) {
      throw new ForbiddenException('You cannot leave the default server');
    }
    if (member.role === MemberRole.OWNER) {
      throw new BadRequestException(
        'Owner cannot leave; transfer ownership or delete the server',
      );
    }
    await member.deleteOne();
    this.realtime.emitToServer(serverId, 'server:member-left', {
      serverId,
      userId,
    });
    return { left: true };
  }

  async listMembers(serverId: string, userId: string) {
    await this.requireMembership(serverId, userId);
    const members = await this.memberModel
      .find({ serverId: new Types.ObjectId(serverId) })
      .exec();
    const userIds = members.map((m) => m.userId);
    const users = await this.users.model
      .find({ _id: { $in: userIds } })
      .exec();
    const userById = new Map(users.map((u) => [u._id.toString(), u]));
    return members.map((m) => {
      const u = userById.get(m.userId.toString());
      return {
        userId: m.userId.toString(),
        role: m.role,
        nickname: m.nickname,
        joinedAt: m.joinedAt,
        user: u ? this.users.toPublic(u) : null,
      };
    });
  }

  async updateMemberRole(
    serverId: string,
    actorId: string,
    targetUserId: string,
    dto: UpdateMemberRoleDto,
  ) {
    const actor = await this.requireRole(serverId, actorId, MemberRole.ADMIN);
    if (dto.role === MemberRole.OWNER) {
      throw new BadRequestException('Cannot assign OWNER role directly');
    }
    const target = await this.getMembership(serverId, targetUserId);
    if (!target) throw new NotFoundException('Member not found');
    if (target.role === MemberRole.OWNER) {
      throw new ForbiddenException('Cannot change the owner role');
    }
    // Only the owner can promote/demote admins.
    if (
      ROLE_RANK[target.role] >= ROLE_RANK[actor.role] &&
      actor.role !== MemberRole.OWNER
    ) {
      throw new ForbiddenException('Cannot modify a member at or above your role');
    }
    target.role = dto.role;
    await target.save();
    this.realtime.emitToServer(serverId, 'server:member-updated', {
      serverId,
      userId: targetUserId,
      role: target.role,
    });
    return target.toJSON();
  }

  async kickMember(serverId: string, actorId: string, targetUserId: string) {
    const actor = await this.requireRole(serverId, actorId, MemberRole.ADMIN);
    if (actorId === targetUserId) {
      throw new BadRequestException('Use leave to remove yourself');
    }
    const target = await this.getMembership(serverId, targetUserId);
    if (!target) throw new NotFoundException('Member not found');
    if (target.role === MemberRole.OWNER) {
      throw new ForbiddenException('Cannot kick the owner');
    }
    if (
      ROLE_RANK[target.role] >= ROLE_RANK[actor.role] &&
      actor.role !== MemberRole.OWNER
    ) {
      throw new ForbiddenException('Cannot kick a member at or above your role');
    }
    await target.deleteOne();
    this.realtime.emitToServer(serverId, 'server:member-left', {
      serverId,
      userId: targetUserId,
    });
    return { kicked: true };
  }

  // ── New admin features ────────────────────────────────────────

  /** Transfers ownership to another member (OWNER only). */
  async transferOwnership(
    serverId: string,
    actorId: string,
    newOwnerId: string,
  ) {
    await this.requireRole(serverId, actorId, MemberRole.OWNER);
    if (actorId === newOwnerId) {
      throw new BadRequestException('You already own this server');
    }
    const target = await this.getMembership(serverId, newOwnerId);
    if (!target) {
      throw new NotFoundException('New owner must be a member of the server');
    }
    return this.txService.withTransaction(async (session) => {
      const sid = new Types.ObjectId(serverId);
      // Demote current owner to ADMIN, promote target to OWNER.
      await this.memberModel
        .updateOne(
          { serverId: sid, userId: new Types.ObjectId(actorId) },
          { role: MemberRole.ADMIN },
          { session },
        )
        .exec();
      await this.memberModel
        .updateOne(
          { serverId: sid, userId: new Types.ObjectId(newOwnerId) },
          { role: MemberRole.OWNER },
          { session },
        )
        .exec();
      await this.serverModel
        .updateOne(
          { _id: sid },
          { ownerId: new Types.ObjectId(newOwnerId) },
          { session },
        )
        .exec();
      this.realtime.emitToServer(serverId, 'server:ownership-transferred', {
        serverId,
        from: actorId,
        to: newOwnerId,
      });
      return { transferred: true, newOwnerId };
    });
  }

  /** Bans a member: removes membership and records a ban (ADMIN+). */
  async banMember(
    serverId: string,
    actorId: string,
    targetUserId: string,
    reason?: string,
  ) {
    const actor = await this.requireRole(serverId, actorId, MemberRole.ADMIN);
    if (actorId === targetUserId) {
      throw new BadRequestException('You cannot ban yourself');
    }
    if (this.isDefaultServer(serverId)) {
      throw new ForbiddenException(
        'Members cannot be banned from the default server',
      );
    }
    const target = await this.getMembership(serverId, targetUserId);
    if (target) {
      if (target.role === MemberRole.OWNER) {
        throw new ForbiddenException('Cannot ban the owner');
      }
      if (
        ROLE_RANK[target.role] >= ROLE_RANK[actor.role] &&
        actor.role !== MemberRole.OWNER
      ) {
        throw new ForbiddenException(
          'Cannot ban a member at or above your role',
        );
      }
    }
    const sid = new Types.ObjectId(serverId);
    const uid = new Types.ObjectId(targetUserId);
    await this.txService.withTransaction(async (session) => {
      await this.memberModel.deleteOne({ serverId: sid, userId: uid }, { session });
      await this.banModel.updateOne(
        { serverId: sid, userId: uid },
        {
          $set: {
            serverId: sid,
            userId: uid,
            bannedBy: new Types.ObjectId(actorId),
            reason,
          },
        },
        { upsert: true, session },
      );
    });
    this.realtime.emitToServer(serverId, 'server:member-banned', {
      serverId,
      userId: targetUserId,
      reason,
    });
    this.realtime.emitToUser(targetUserId, 'server:you-were-banned', {
      serverId,
      reason,
    });
    return { banned: true };
  }

  async unbanMember(serverId: string, actorId: string, targetUserId: string) {
    await this.requireRole(serverId, actorId, MemberRole.ADMIN);
    const res = await this.banModel
      .deleteOne({
        serverId: new Types.ObjectId(serverId),
        userId: new Types.ObjectId(targetUserId),
      })
      .exec();
    if (res.deletedCount === 0) {
      throw new NotFoundException('Ban not found');
    }
    return { unbanned: true };
  }

  async listBans(serverId: string, actorId: string) {
    await this.requireRole(serverId, actorId, MemberRole.ADMIN);
    const bans = await this.banModel
      .find({ serverId: new Types.ObjectId(serverId) })
      .sort({ _id: -1 })
      .exec();
    const userIds = bans.map((b) => b.userId);
    const users = await this.users.model
      .find({ _id: { $in: userIds } })
      .exec();
    const byId = new Map(users.map((u) => [u._id.toString(), u]));
    return bans.map((b) => ({
      userId: b.userId.toString(),
      reason: b.reason,
      bannedBy: b.bannedBy.toString(),
      user: byId.get(b.userId.toString())
        ? this.users.toPublic(byId.get(b.userId.toString())!)
        : null,
    }));
  }

  /**
   * Sets or clears a member nickname. Members may change their own; ADMIN+
   * may change anyone below their role.
   */
  async setNickname(
    serverId: string,
    actorId: string,
    targetUserId: string,
    nickname?: string,
  ) {
    const actor = await this.requireMembership(serverId, actorId);
    const isSelf = actorId === targetUserId;
    if (!isSelf && ROLE_RANK[actor.role] < ROLE_RANK[MemberRole.ADMIN]) {
      throw new ForbiddenException(
        'Only admins can change other members nicknames',
      );
    }
    const target = isSelf
      ? actor
      : await this.getMembership(serverId, targetUserId);
    if (!target) throw new NotFoundException('Member not found');
    if (
      !isSelf &&
      ROLE_RANK[target.role] >= ROLE_RANK[actor.role] &&
      actor.role !== MemberRole.OWNER
    ) {
      throw new ForbiddenException(
        'Cannot change nickname of a member at or above your role',
      );
    }
    const clean = nickname?.trim();
    target.nickname = clean ? clean : undefined;
    await target.save();
    this.realtime.emitToServer(serverId, 'server:member-updated', {
      serverId,
      userId: targetUserId,
      nickname: target.nickname ?? null,
    });
    return { userId: targetUserId, nickname: target.nickname ?? null };
  }

  /** Broadcasts an announcement to every member of the server (ADMIN+). */
  async announce(serverId: string, actorId: string, message: string) {
    await this.requireRole(serverId, actorId, MemberRole.ADMIN);
    const payload = {
      serverId,
      message,
      byUserId: actorId,
      at: new Date().toISOString(),
    };
    this.realtime.emitToServer(serverId, 'server:announcement', payload);
    return { sent: true, ...payload };
  }

  async getServerOrThrow(serverId: string): Promise<ServerDocument> {
    const server = await this.serverModel.findById(this.oid(serverId)).exec();
    if (!server) throw new NotFoundException('Server not found');
    return server;
  }

  /** Returns all server ids a user belongs to (for socket room joins). */
  async listServerIdsForUser(userId: string): Promise<string[]> {
    const memberships = await this.memberModel
      .find({ userId: new Types.ObjectId(userId) }, { serverId: 1 })
      .exec();
    return memberships.map((m) => m.serverId.toString());
  }
}
