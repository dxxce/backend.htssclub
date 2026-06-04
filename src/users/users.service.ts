import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, FilterQuery, Model, Types } from 'mongoose';
import { AccountStatus, FriendState, PresenceStatus } from '../common/enums';
import { RealtimeService } from '../realtime/realtime.service';
import {
  ServerMember,
  ServerMemberDocument,
} from '../servers/schemas/server-member.schema';
import { Friend, FriendDocument } from '../friends/schemas/friend.schema';
import { User, UserDocument } from './schemas/user.schema';
import { UpdateProfileDto } from './dto/user.dto';

export type FriendStatus =
  | 'NONE'
  | 'FRIENDS'
  | 'REQUEST_SENT'
  | 'REQUEST_RECEIVED'
  | 'BLOCKED'
  | 'BLOCKED_BY'
  | 'SELF';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(ServerMember.name)
    private readonly memberModel: Model<ServerMemberDocument>,
    @InjectModel(Friend.name)
    private readonly friendModel: Model<FriendDocument>,
    private readonly realtime: RealtimeService,
  ) {}

  get model(): Model<UserDocument> {
    return this.userModel;
  }

  async create(data: Partial<User>): Promise<UserDocument> {
    const created = await this.userModel.create(data);
    return created;
  }

  async findById(id: string | Types.ObjectId): Promise<UserDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.userModel.findById(id).exec();
  }

  async findByIdOrThrow(id: string | Types.ObjectId): Promise<UserDocument> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findByEmail(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.toLowerCase() }).exec();
  }

  async findByUsername(username: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ username }).exec();
  }

  async findByIdentifier(identifier: string): Promise<UserDocument | null> {
    const query: FilterQuery<UserDocument> = identifier.includes('@')
      ? { email: identifier.toLowerCase() }
      : { username: identifier };
    return this.userModel.findOne(query).exec();
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<UserDocument> {
    const update: Partial<User> = {};
    if (dto.displayName !== undefined) update.displayName = dto.displayName;
    if (dto.avatarUrl !== undefined) update.avatarUrl = dto.avatarUrl;
    if (dto.bio !== undefined) update.bio = dto.bio;
    if (dto.statusMessage !== undefined)
      update.statusMessage = dto.statusMessage;
    const user = await this.userModel
      .findByIdAndUpdate(userId, update, { new: true })
      .exec();
    if (!user) throw new NotFoundException('User not found');
    // Broadcast the updated identity card to every server the user is in,
    // plus their personal room, so members see the new name/avatar live.
    await this.broadcastProfileUpdate(user);
    return user;
  }

  /**
   * Emits `user:updated` to every server room the user belongs to and to
   * their personal room, including bio/statusMessage so other members
   * refresh the displayed profile without a reload.
   */
  private async broadcastProfileUpdate(user: UserDocument): Promise<void> {
    const card = {
      ...this.toCard(user),
      bio: user.bio,
      statusMessage: user.statusMessage,
    };
    const memberships = await this.memberModel
      .find({ userId: user._id }, { serverId: 1 })
      .exec();
    const serverIds = memberships.map((m) => m.serverId.toString());
    for (const serverId of serverIds) {
      this.realtime.emitToServer(serverId, 'user:updated', { serverId, user: card });
    }
    this.realtime.emitToUser(user._id.toString(), 'user:updated', {
      user: card,
    });
  }

  /**
   * Sets the presence the user explicitly chose. Persists it as both the
   * live `presence` and the `desiredPresence` so it survives reconnects.
   * Returns the effective presence applied.
   */
  async setPresence(
    userId: string | Types.ObjectId,
    presence: PresenceStatus,
  ): Promise<PresenceStatus> {
    const update: Partial<User> = {
      presence,
      desiredPresence: presence,
    };
    if (presence === PresenceStatus.OFFLINE) {
      update.lastSeenAt = new Date();
    }
    await this.userModel.findByIdAndUpdate(userId, update).exec();
    return presence;
  }

  /**
   * Called when a socket connects. Restores the user's chosen presence
   * (e.g. IDLE/DND) rather than forcing ONLINE. If the user previously
   * chose OFFLINE we treat the new connection as ONLINE.
   * Returns the presence that was actually applied.
   */
  async goOnline(
    userId: string | Types.ObjectId,
  ): Promise<PresenceStatus> {
    const user = await this.userModel
      .findById(userId, { desiredPresence: 1 })
      .exec();
    const desired = user?.desiredPresence ?? PresenceStatus.ONLINE;
    const effective =
      desired === PresenceStatus.OFFLINE ? PresenceStatus.ONLINE : desired;
    await this.userModel
      .findByIdAndUpdate(userId, { presence: effective })
      .exec();
    return effective;
  }

  /**
   * Called when a user's last socket disconnects. Marks them OFFLINE for
   * display but keeps `desiredPresence` intact for the next connection.
   */
  async goOffline(userId: string | Types.ObjectId): Promise<void> {
    await this.userModel
      .findByIdAndUpdate(userId, {
        presence: PresenceStatus.OFFLINE,
        lastSeenAt: new Date(),
      })
      .exec();
  }

  async setStatus(
    userId: string,
    status: AccountStatus,
    session?: ClientSession,
  ): Promise<UserDocument> {
    const user = await this.userModel
      .findByIdAndUpdate(userId, { status }, { new: true, session })
      .exec();
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async setPasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.userModel.findByIdAndUpdate(userId, { passwordHash }).exec();
  }

  async search(q: string, limit = 20): Promise<UserDocument[]> {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.userModel
      .find({ username: { $regex: escaped, $options: 'i' } })
      .limit(limit)
      .exec();
  }

  async ensureActive(userId: string | Types.ObjectId): Promise<UserDocument> {
    const user = await this.findByIdOrThrow(userId);
    if (user.status !== AccountStatus.ACTIVE) {
      throw new BadRequestException(`Account is ${user.status}`);
    }
    return user;
  }

  /** Public-safe projection for a user profile. */
  toPublic(user: UserDocument) {
    return {
      id: user._id.toString(),
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
      statusMessage: user.statusMessage,
      presence: user.presence,
      status: user.status,
      lastSeenAt: user.lastSeenAt,
    };
  }

  /**
   * Relationship status between `viewerId` and `targetId` from the viewer's
   * perspective. Queries the friends collection directly to avoid a module
   * cycle with FriendsService.
   */
  async getFriendStatus(
    viewerId: string,
    targetId: string,
  ): Promise<{ status: FriendStatus; requestId: string | null }> {
    if (viewerId === targetId) return { status: 'SELF', requestId: null };
    if (!Types.ObjectId.isValid(viewerId) || !Types.ObjectId.isValid(targetId)) {
      return { status: 'NONE', requestId: null };
    }
    const me = new Types.ObjectId(viewerId);
    const other = new Types.ObjectId(targetId);
    const doc = await this.friendModel
      .findOne({
        $or: [
          { requesterId: me, addresseeId: other },
          { requesterId: other, addresseeId: me },
        ],
      })
      .exec();
    if (!doc) return { status: 'NONE', requestId: null };
    const requestId = doc._id.toString();
    switch (doc.state) {
      case FriendState.ACCEPTED:
        return { status: 'FRIENDS', requestId };
      case FriendState.PENDING:
        return doc.requesterId.equals(me)
          ? { status: 'REQUEST_SENT', requestId }
          : { status: 'REQUEST_RECEIVED', requestId };
      case FriendState.BLOCKED:
        return doc.requesterId.equals(me)
          ? { status: 'BLOCKED', requestId }
          : { status: 'BLOCKED_BY', requestId };
      default:
        return { status: 'NONE', requestId: null };
    }
  }

  /** Compact identity card used by voice members / peer lists. */
  toCard(user: UserDocument) {
    return {
      id: user._id.toString(),
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
    };
  }

  /**
   * Returns a map of userId -> compact identity card for the given ids.
   * Used to enrich voice member lists with profile info.
   */
  async getCards(
    userIds: (string | Types.ObjectId)[],
  ): Promise<Map<string, ReturnType<UsersService['toCard']>>> {
    const ids = userIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (ids.length === 0) return new Map();
    const users = await this.userModel.find({ _id: { $in: ids } }).exec();
    return new Map(users.map((u) => [u._id.toString(), this.toCard(u)]));
  }
}
