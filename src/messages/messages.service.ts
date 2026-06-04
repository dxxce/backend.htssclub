import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { MemberRole } from '../common/enums';
import { ChannelsService } from '../channels/channels.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ServersService } from '../servers/servers.service';
import { UsersService } from '../users/users.service';
import { LevelingService } from '../leveling/leveling.service';
import {
  Message,
  MessageDocument,
  MessageReaction,
} from './schemas/message.schema';
import {
  CreateMessageDto,
  MessageHistoryDto,
  UpdateMessageDto,
} from './dto/message.dto';

const REPLY_PREVIEW_LEN = 120;
const MAX_REACTION_USER_IDS = 50;
// XP per message, rate-limited to once per this window to discourage spam.
const XP_PER_MESSAGE = 5;
const XP_COOLDOWN_MS = 60_000;

type UserCard = {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
};

@Injectable()
export class MessagesService {
  // In-memory cooldown for message XP (per backend instance). For multi-node
  // exactness this could move to Redis, but a small skew is acceptable.
  private readonly lastXpAt = new Map<string, number>();

  constructor(
    @InjectModel(Message.name)
    private readonly model: Model<MessageDocument>,
    private readonly channels: ChannelsService,
    private readonly servers: ServersService,
    private readonly users: UsersService,
    private readonly realtime: RealtimeService,
    private readonly leveling: LevelingService,
  ) {}

  async history(channelId: string, userId: string, q: MessageHistoryDto) {
    await this.channels.assertAccess(channelId, userId);
    const limit = Math.min(q.limit || 30, 100);
    const filter: FilterQuery<MessageDocument> = {
      channelId: new Types.ObjectId(channelId),
    };
    if (q.before && Types.ObjectId.isValid(q.before)) {
      filter._id = { $lt: new Types.ObjectId(q.before) };
    }
    const docs = await this.model
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit)
      .exec();
    const items = await this.serializeMany(docs, userId);
    return {
      items,
      hasMore: docs.length === limit,
      nextBefore: docs.length ? docs[docs.length - 1]._id.toString() : null,
    };
  }

  /**
   * Creates a message and broadcasts `message:new` to the channel room.
   * Shared by both REST and the chat gateway. A message must have either
   * non-empty content or at least one attachment.
   */
  async create(channelId: string, userId: string, dto: CreateMessageDto) {
    await this.channels.assertAccess(channelId, userId);
    const content = (dto.content ?? '').trim();
    const attachments = dto.attachments ?? [];
    if (!content && attachments.length === 0) {
      throw new BadRequestException(
        'A message must have content or at least one attachment',
      );
    }
    const doc = await this.model.create({
      channelId: new Types.ObjectId(channelId),
      authorId: new Types.ObjectId(userId),
      content,
      attachments: attachments.length ? attachments : undefined,
      reactions: [],
      replyToId:
        dto.replyToId && Types.ObjectId.isValid(dto.replyToId)
          ? new Types.ObjectId(dto.replyToId)
          : undefined,
    });
    const json = await this.serialize(doc, userId);
    this.realtime.emitToChannel(channelId, 'message:new', json);
    // Award XP (rate-limited per user) for chatting; fire-and-forget.
    this.awardMessageXp(userId);
    return json;
  }

  /** Grants message XP at most once per cooldown window per user. */
  private awardMessageXp(userId: string): void {
    const now = Date.now();
    const last = this.lastXpAt.get(userId) ?? 0;
    if (now - last < XP_COOLDOWN_MS) return;
    this.lastXpAt.set(userId, now);
    void this.leveling.addXp(userId, XP_PER_MESSAGE, 'message');
  }

  async update(messageId: string, userId: string, dto: UpdateMessageDto) {
    const message = await this.getOrThrow(messageId);
    if (message.authorId.toString() !== userId) {
      throw new ForbiddenException('Only the author can edit this message');
    }
    message.content = dto.content;
    message.editedAt = new Date();
    await message.save();
    const json = await this.serialize(message, userId);
    this.realtime.emitToChannel(
      message.channelId.toString(),
      'message:updated',
      json,
    );
    return json;
  }

  async remove(messageId: string, userId: string) {
    const message = await this.getOrThrow(messageId);
    const channel = await this.channels.getByIdOrThrow(
      message.channelId.toString(),
    );
    const isAuthor = message.authorId.toString() === userId;
    if (!isAuthor) {
      // Non-authors must be ADMIN+ of the server.
      await this.servers.requireRole(
        channel.serverId.toString(),
        userId,
        MemberRole.ADMIN,
      );
    } else {
      await this.servers.requireMembership(
        channel.serverId.toString(),
        userId,
      );
    }
    const channelId = message.channelId.toString();
    // Reactions live on the message document, so deleting it cascades them.
    await message.deleteOne();
    this.realtime.emitToChannel(channelId, 'message:deleted', {
      messageId,
      channelId,
    });
    return { deleted: true };
  }

  // ── Reactions ─────────────────────────────────────────────────

  async addReaction(
    channelId: string,
    messageId: string,
    userId: string,
    emoji: string,
  ) {
    await this.channels.assertAccess(channelId, userId);
    const message = await this.getOrThrow(messageId);
    if (message.channelId.toString() !== channelId) {
      throw new NotFoundException('Message not found in this channel');
    }
    const uid = new Types.ObjectId(userId);
    // Idempotent add: $addToSet on the matching emoji group, or push a new
    // group if the emoji isn't present yet.
    const updated = await this.model
      .findOneAndUpdate(
        { _id: message._id, 'reactions.emoji': emoji },
        { $addToSet: { 'reactions.$.userIds': uid } },
        { new: true },
      )
      .exec();
    if (!updated) {
      await this.model
        .updateOne(
          { _id: message._id, 'reactions.emoji': { $ne: emoji } },
          { $push: { reactions: { emoji, userIds: [uid] } } },
        )
        .exec();
    }
    this.realtime.emitToChannel(channelId, 'reaction:added', {
      channelId,
      messageId,
      emoji,
      userId,
    });
    return { ok: true };
  }

  async removeReaction(
    channelId: string,
    messageId: string,
    userId: string,
    emoji: string,
  ) {
    await this.channels.assertAccess(channelId, userId);
    const message = await this.getOrThrow(messageId);
    if (message.channelId.toString() !== channelId) {
      throw new NotFoundException('Message not found in this channel');
    }
    const uid = new Types.ObjectId(userId);
    await this.model
      .updateOne(
        { _id: message._id, 'reactions.emoji': emoji },
        { $pull: { 'reactions.$.userIds': uid } },
      )
      .exec();
    // Drop any emoji groups that no longer have reactors.
    await this.model
      .updateOne(
        { _id: message._id },
        { $pull: { reactions: { userIds: { $size: 0 } } } },
      )
      .exec();
    this.realtime.emitToChannel(channelId, 'reaction:removed', {
      channelId,
      messageId,
      emoji,
      userId,
    });
    return { ok: true };
  }

  // ── Serialization ─────────────────────────────────────────────

  /** Serializes one message with author, replyTo and grouped reactions. */
  private async serialize(
    doc: MessageDocument,
    viewerId: string,
  ): Promise<any> {
    const [out] = await this.serializeMany([doc], viewerId);
    return out;
  }

  /**
   * Serializes a batch of messages, resolving author cards, reply previews
   * and grouped reactions in as few queries as possible.
   */
  private async serializeMany(
    docs: MessageDocument[],
    viewerId: string,
  ): Promise<any[]> {
    if (docs.length === 0) return [];

    // Collect all user ids (authors + reactors) and reply target ids.
    const userIds = new Set<string>();
    const replyIds = new Set<string>();
    for (const d of docs) {
      userIds.add(d.authorId.toString());
      (d.reactions ?? []).forEach((r) =>
        (r.userIds ?? []).forEach((u) => userIds.add(u.toString())),
      );
      if (d.replyToId) replyIds.add(d.replyToId.toString());
    }

    // Fetch reply targets, then add their authors to the card lookup.
    const replyDocs = replyIds.size
      ? await this.model
          .find({ _id: { $in: [...replyIds].map((id) => new Types.ObjectId(id)) } })
          .exec()
      : [];
    const replyById = new Map(replyDocs.map((r) => [r._id.toString(), r]));
    replyDocs.forEach((r) => userIds.add(r.authorId.toString()));

    const cards = await this.users.getCards([...userIds]);

    return docs.map((d) =>
      this.shape(d, viewerId, cards, replyById),
    );
  }

  private shape(
    d: MessageDocument,
    viewerId: string,
    cards: Map<string, UserCard>,
    replyById: Map<string, MessageDocument>,
  ): any {
    const authorId = d.authorId.toString();
    const base = d.toJSON() as Record<string, any>;

    base.author = cards.get(authorId) ?? { id: authorId, username: 'unknown' };
    base.reactions = this.shapeReactions(d.reactions ?? [], viewerId);

    if (d.replyToId) {
      base.replyTo = this.shapeReplyTo(
        replyById.get(d.replyToId.toString()),
        cards,
      );
    }
    return base;
  }

  private shapeReactions(reactions: MessageReaction[], viewerId: string) {
    return (reactions ?? [])
      .filter((r) => (r.userIds ?? []).length > 0)
      .map((r) => {
        const ids = (r.userIds ?? []).map((u) => u.toString());
        return {
          emoji: r.emoji,
          count: ids.length,
          userIds: ids.slice(0, MAX_REACTION_USER_IDS),
          me: ids.includes(viewerId),
        };
      });
  }

  private shapeReplyTo(
    reply: MessageDocument | undefined,
    cards: Map<string, UserCard>,
  ) {
    if (!reply) return null; // original message was deleted
    const authorId = reply.authorId.toString();
    const content = reply.content ?? '';
    return {
      id: reply._id.toString(),
      authorId,
      author: cards.get(authorId) ?? { id: authorId, username: 'unknown' },
      content:
        content.length > REPLY_PREVIEW_LEN
          ? content.slice(0, REPLY_PREVIEW_LEN)
          : content,
      hasAttachments: Boolean(reply.attachments && reply.attachments.length),
    };
  }

  private async getOrThrow(messageId: string): Promise<MessageDocument> {
    if (!Types.ObjectId.isValid(messageId)) {
      throw new NotFoundException('Message not found');
    }
    const message = await this.model.findById(messageId).exec();
    if (!message) throw new NotFoundException('Message not found');
    return message;
  }
}
