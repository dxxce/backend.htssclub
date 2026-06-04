import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FriendState } from '../common/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import { Friend, FriendDocument } from './schemas/friend.schema';

@Injectable()
export class FriendsService {
  constructor(
    @InjectModel(Friend.name)
    private readonly model: Model<FriendDocument>,
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
  ) {}

  private oid(id: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid id');
    }
    return new Types.ObjectId(id);
  }

  /** Finds any relationship doc between two users regardless of direction. */
  private async findBetween(
    a: Types.ObjectId,
    b: Types.ObjectId,
  ): Promise<FriendDocument | null> {
    return this.model
      .findOne({
        $or: [
          { requesterId: a, addresseeId: b },
          { requesterId: b, addresseeId: a },
        ],
      })
      .exec();
  }

  async listFriends(userId: string) {
    const me = this.oid(userId);
    const docs = await this.model
      .find({
        state: FriendState.ACCEPTED,
        $or: [{ requesterId: me }, { addresseeId: me }],
      })
      .exec();
    const friendIds = docs.map((d) =>
      d.requesterId.equals(me) ? d.addresseeId : d.requesterId,
    );
    const users = await this.users.model
      .find({ _id: { $in: friendIds } })
      .exec();
    return users.map((u) => this.users.toPublic(u));
  }

  async listRequests(userId: string) {
    const me = this.oid(userId);
    const [incoming, outgoing] = await Promise.all([
      this.model
        .find({ addresseeId: me, state: FriendState.PENDING })
        .exec(),
      this.model
        .find({ requesterId: me, state: FriendState.PENDING })
        .exec(),
    ]);
    return {
      incoming: incoming.map((d) => d.toJSON()),
      outgoing: outgoing.map((d) => d.toJSON()),
    };
  }

  async sendRequest(userId: string, targetId: string) {
    if (userId === targetId) {
      throw new BadRequestException('Cannot add yourself');
    }
    const me = this.oid(userId);
    const target = this.oid(targetId);
    await this.users.findByIdOrThrow(target); // ensure exists

    const existing = await this.findBetween(me, target);
    if (existing) {
      if (existing.state === FriendState.BLOCKED) {
        throw new ForbiddenException('Cannot send request');
      }
      if (existing.state === FriendState.ACCEPTED) {
        throw new BadRequestException('Already friends');
      }
      if (existing.state === FriendState.PENDING) {
        // If the other side already requested, accept it.
        if (existing.addresseeId.equals(me)) {
          return this.accept(userId, existing._id.toString());
        }
        throw new BadRequestException('Request already pending');
      }
    }

    const doc = await this.model.create({
      requesterId: me,
      addresseeId: target,
      state: FriendState.PENDING,
    });
    await this.notifications.create(target, 'FRIEND_REQUEST', {
      requestId: doc._id.toString(),
      fromUserId: userId,
    });
    return doc.toJSON();
  }

  async accept(userId: string, requestId: string) {
    const me = this.oid(userId);
    const doc = await this.model.findById(this.oid(requestId)).exec();
    if (!doc || !doc.addresseeId.equals(me)) {
      throw new NotFoundException('Request not found');
    }
    if (doc.state !== FriendState.PENDING) {
      throw new BadRequestException('Request is not pending');
    }
    doc.state = FriendState.ACCEPTED;
    await doc.save();
    await this.notifications.create(doc.requesterId, 'FRIEND_ACCEPTED', {
      byUserId: userId,
    });
    return doc.toJSON();
  }

  async decline(userId: string, requestId: string) {
    const me = this.oid(userId);
    const doc = await this.model.findById(this.oid(requestId)).exec();
    if (!doc || !doc.addresseeId.equals(me)) {
      throw new NotFoundException('Request not found');
    }
    if (doc.state !== FriendState.PENDING) {
      throw new BadRequestException('Request is not pending');
    }
    await doc.deleteOne();
    return { declined: true };
  }

  async removeFriend(userId: string, targetId: string) {
    const me = this.oid(userId);
    const target = this.oid(targetId);
    const doc = await this.findBetween(me, target);
    if (!doc || doc.state !== FriendState.ACCEPTED) {
      throw new NotFoundException('Friendship not found');
    }
    await doc.deleteOne();
    return { removed: true };
  }

  async block(userId: string, targetId: string) {
    if (userId === targetId) {
      throw new BadRequestException('Cannot block yourself');
    }
    const me = this.oid(userId);
    const target = this.oid(targetId);
    await this.users.findByIdOrThrow(target);

    const existing = await this.findBetween(me, target);
    if (existing) {
      existing.requesterId = me;
      existing.addresseeId = target;
      existing.state = FriendState.BLOCKED;
      await existing.save();
      return existing.toJSON();
    }
    const doc = await this.model.create({
      requesterId: me,
      addresseeId: target,
      state: FriendState.BLOCKED,
    });
    return doc.toJSON();
  }

  async unblock(userId: string, targetId: string) {
    const me = this.oid(userId);
    const target = this.oid(targetId);
    const doc = await this.model
      .findOne({
        requesterId: me,
        addresseeId: target,
        state: FriendState.BLOCKED,
      })
      .exec();
    if (!doc) {
      throw new NotFoundException('Block not found');
    }
    await doc.deleteOne();
    return { unblocked: true };
  }

  /**
   * Returns the relationship status between the caller and another user,
   * from the CALLER's perspective. Possible `status` values:
   *  - NONE                : no relationship
   *  - FRIENDS             : already friends (ACCEPTED)
   *  - REQUEST_SENT        : caller sent a pending request
   *  - REQUEST_RECEIVED    : the other user sent the caller a pending request
   *  - BLOCKED             : caller has blocked the other user
   *  - BLOCKED_BY          : caller is blocked by the other user
   */
  async getStatus(userId: string, targetId: string) {
    if (userId === targetId) {
      return { status: 'SELF', requestId: null };
    }
    const me = this.oid(userId);
    const target = this.oid(targetId);
    const doc = await this.findBetween(me, target);
    if (!doc) {
      return { status: 'NONE', requestId: null };
    }
    const requestId = doc._id.toString();
    switch (doc.state) {
      case FriendState.ACCEPTED:
        return { status: 'FRIENDS', requestId, since: doc.get('updatedAt') };
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
}
