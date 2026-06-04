import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FriendState, DmMessageType } from '../common/enums';
import { AtRestCipher } from '../common/crypto.util';
import { RealtimeService } from '../realtime/realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import { Friend, FriendDocument } from '../friends/schemas/friend.schema';
import {
  DmConversation,
  DmConversationDocument,
} from './schemas/dm-conversation.schema';
import { DmMessage, DmMessageDocument } from './schemas/dm-message.schema';
import { SendDmDto, DmHistoryDto } from './dto/dm.dto';

@Injectable()
export class DmService {
  private readonly cipher: AtRestCipher;

  constructor(
    @InjectModel(DmConversation.name)
    private readonly convModel: Model<DmConversationDocument>,
    @InjectModel(DmMessage.name)
    private readonly msgModel: Model<DmMessageDocument>,
    @InjectModel(Friend.name)
    private readonly friendModel: Model<FriendDocument>,
    private readonly users: UsersService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
    config: ConfigService,
  ) {
    this.cipher = new AtRestCipher(config.get<string>('dm.encryptionKey')!);
  }

  private oid(id: string, label = 'id'): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Invalid ${label}`);
    }
    return new Types.ObjectId(id);
  }

  private pairKey(a: string, b: string): Types.ObjectId[] {
    return [a, b].sort().map((id) => new Types.ObjectId(id));
  }

  /** Decrypts a stored DM document into a client-facing shape. */
  private decryptMessage(doc: DmMessageDocument): any {
    const json = doc.toJSON() as Record<string, any>;
    // SYSTEM messages are not encrypted; their content is plain.
    if (doc.type === DmMessageType.SYSTEM) {
      json.content = doc.content || '';
    } else {
      json.content = doc.content ? this.cipher.decrypt(doc.content) : '';
    }
    return json;
  }

  /** Ensures the two users may DM each other (not blocked either way). */
  private async assertCanDm(userA: string, userB: string): Promise<void> {
    const a = new Types.ObjectId(userA);
    const b = new Types.ObjectId(userB);
    const blocked = await this.friendModel
      .findOne({
        state: FriendState.BLOCKED,
        $or: [
          { requesterId: a, addresseeId: b },
          { requesterId: b, addresseeId: a },
        ],
      })
      .exec();
    if (blocked) {
      throw new ForbiddenException('Cannot message this user');
    }
  }

  async getOrCreateConversation(
    userId: string,
    otherUserId: string,
  ): Promise<DmConversationDocument> {
    if (userId === otherUserId) {
      throw new BadRequestException('Cannot DM yourself');
    }
    await this.users.findByIdOrThrow(otherUserId);
    const participants = this.pairKey(userId, otherUserId);
    const existing = await this.convModel
      .findOne({ participants: { $all: participants, $size: 2 } })
      .exec();
    if (existing) return existing;
    return this.convModel.create({ participants, unread: {} });
  }

  /**
   * Posts a server-generated SYSTEM message into the DM between two users
   * (e.g. a coin transfer record). Not encrypted, cannot be edited/deleted.
   * `senderId` is the user who triggered it (for display); broadcast goes to
   * both participants. Best-effort: never throws to the caller's flow.
   */
  async postSystemMessage(
    senderId: string,
    otherUserId: string,
    text: string,
    systemData: Record<string, any>,
  ): Promise<any> {
    try {
      const conv = await this.getOrCreateConversation(senderId, otherUserId);
      const convId = conv._id.toString();
      const doc = await this.msgModel.create({
        conversationId: conv._id,
        senderId: new Types.ObjectId(senderId),
        type: DmMessageType.SYSTEM,
        content: text, // plain, server-generated
        systemData,
      });
      await this.convModel
        .updateOne(
          { _id: conv._id },
          {
            $set: { lastMessageAt: new Date() },
            $inc: { [`unread.${otherUserId}`]: 1 },
          },
        )
        .exec();
      const json = this.decryptMessage(doc);
      conv.participants.forEach((p) =>
        this.realtime.emitToUser(p.toString(), 'dm:new', {
          conversationId: convId,
          message: json,
        }),
      );
      return json;
    } catch {
      return null;
    }
  }

  private async requireParticipant(
    conversationId: string,
    userId: string,
  ): Promise<DmConversationDocument> {
    const conv = await this.convModel.findById(this.oid(conversationId)).exec();
    if (!conv) throw new NotFoundException('Conversation not found');
    if (!conv.participants.some((p) => p.toString() === userId)) {
      throw new ForbiddenException('Not a participant of this conversation');
    }
    return conv;
  }

  private otherParticipant(
    conv: DmConversationDocument,
    userId: string,
  ): string {
    const other = conv.participants.find((p) => p.toString() !== userId);
    return other ? other.toString() : userId;
  }

  // ── Conversations ─────────────────────────────────────────────
  async listConversations(userId: string) {
    const uid = new Types.ObjectId(userId);
    const convs = await this.convModel
      .find({ participants: uid })
      .sort({ lastMessageAt: -1, _id: -1 })
      .exec();
    const otherIds = convs.map((c) => this.otherParticipant(c, userId));
    const cards = await this.users.getCards(otherIds);
    return convs.map((c) => {
      const otherId = this.otherParticipant(c, userId);
      return {
        id: c._id.toString(),
        otherUser: cards.get(otherId) ?? { id: otherId, username: 'unknown' },
        lastMessageAt: c.lastMessageAt,
        unread: c.unread?.[userId] ?? 0,
      };
    });
  }

  async startConversation(userId: string, otherUserId: string) {
    await this.assertCanDm(userId, otherUserId);
    const conv = await this.getOrCreateConversation(userId, otherUserId);
    const otherId = this.otherParticipant(conv, userId);
    const card = (await this.users.getCards([otherId])).get(otherId);
    return {
      id: conv._id.toString(),
      otherUser: card ?? { id: otherId, username: 'unknown' },
      lastMessageAt: conv.lastMessageAt,
      unread: conv.unread?.[userId] ?? 0,
    };
  }

  // ── Messages ──────────────────────────────────────────────────
  async send(userId: string, dto: SendDmDto) {
    await this.assertCanDm(userId, dto.toUserId);
    const content = (dto.content ?? '').trim();
    const attachments = dto.attachments ?? [];
    if (!content && attachments.length === 0) {
      throw new BadRequestException(
        'A message must have content or at least one attachment',
      );
    }
    const conv = await this.getOrCreateConversation(userId, dto.toUserId);
    const convId = conv._id.toString();

    const doc = await this.msgModel.create({
      conversationId: conv._id,
      senderId: new Types.ObjectId(userId),
      // Encrypt at rest before storing.
      content: content ? this.cipher.encrypt(content) : '',
      attachments: attachments.length ? attachments : undefined,
      replyToId:
        dto.replyToId && Types.ObjectId.isValid(dto.replyToId)
          ? new Types.ObjectId(dto.replyToId)
          : undefined,
    });

    const unreadField = `unread.${dto.toUserId}`;
    const updatedConv = await this.convModel
      .findOneAndUpdate(
        { _id: conv._id },
        { $set: { lastMessageAt: new Date() }, $inc: { [unreadField]: 1 } },
        { new: true },
      )
      .exec();
    const recipientUnread = updatedConv?.unread?.[dto.toUserId] ?? 1;

    // Return + broadcast the DECRYPTED message (transport is TLS-protected).
    const json = this.decryptMessage(doc);
    const senderCard = (await this.users.getCards([userId])).get(userId) ?? {
      id: userId,
      username: 'unknown',
    };

    // Recipient: includes new unread count + sender card for inbox/badge.
    this.realtime.emitToUser(dto.toUserId, 'dm:new', {
      conversationId: convId,
      message: json,
      from: senderCard,
      unread: recipientUnread,
    });
    // Sender's own devices (echo so other sessions stay in sync).
    this.realtime.emitToUser(userId, 'dm:new', {
      conversationId: convId,
      message: json,
      from: senderCard,
      unread: 0,
    });

    // Persistent notification for the recipient (so an offline user sees it
    // on next login). Best-effort; never blocks sending.
    this.notifications
      .create(dto.toUserId, 'DM_MESSAGE', {
        conversationId: convId,
        messageId: json.id,
        fromUserId: userId,
        preview:
          json.type === 'SYSTEM'
            ? json.content
            : json.content
              ? json.content.slice(0, 80)
              : '[đính kèm]',
      })
      .catch(() => undefined);

    return json;
  }

  async history(userId: string, conversationId: string, q: DmHistoryDto) {
    await this.requireParticipant(conversationId, userId);
    const limit = Math.min(q.limit || 30, 100);
    const filter: Record<string, any> = {
      conversationId: new Types.ObjectId(conversationId),
    };
    if (q.before && Types.ObjectId.isValid(q.before)) {
      filter._id = { $lt: new Types.ObjectId(q.before) };
    }
    const docs = await this.msgModel
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit)
      .exec();
    return {
      items: docs.map((d) => this.decryptMessage(d)),
      hasMore: docs.length === limit,
      nextBefore: docs.length ? docs[docs.length - 1]._id.toString() : null,
    };
  }

  async edit(userId: string, messageId: string, content: string) {
    if (!Types.ObjectId.isValid(messageId)) {
      throw new NotFoundException('Message not found');
    }
    const msg = await this.msgModel.findById(messageId).exec();
    if (!msg) throw new NotFoundException('Message not found');
    if (msg.type === DmMessageType.SYSTEM) {
      throw new ForbiddenException('System messages cannot be edited');
    }
    if (msg.senderId.toString() !== userId) {
      throw new ForbiddenException('Only the sender can edit this message');
    }
    msg.content = this.cipher.encrypt(content.trim());
    msg.editedAt = new Date();
    await msg.save();
    const conv = await this.convModel.findById(msg.conversationId).exec();
    const json = this.decryptMessage(msg);
    if (conv) {
      conv.participants.forEach((p) =>
        this.realtime.emitToUser(p.toString(), 'dm:updated', {
          conversationId: msg.conversationId.toString(),
          message: json,
        }),
      );
    }
    return json;
  }

  async markRead(userId: string, conversationId: string) {
    const conv = await this.requireParticipant(conversationId, userId);
    await this.convModel
      .updateOne({ _id: conv._id }, { $set: { [`unread.${userId}`]: 0 } })
      .exec();
    const otherId = this.otherParticipant(conv, userId);
    this.realtime.emitToUser(otherId, 'dm:read', {
      conversationId,
      byUserId: userId,
      at: new Date().toISOString(),
    });
    return { ok: true };
  }

  async remove(userId: string, messageId: string) {
    if (!Types.ObjectId.isValid(messageId)) {
      throw new NotFoundException('Message not found');
    }
    const msg = await this.msgModel.findById(messageId).exec();
    if (!msg) throw new NotFoundException('Message not found');
    if (msg.type === DmMessageType.SYSTEM) {
      throw new ForbiddenException('System messages cannot be deleted');
    }
    if (msg.senderId.toString() !== userId) {
      throw new ForbiddenException('Only the sender can delete this message');
    }
    const conv = await this.convModel.findById(msg.conversationId).exec();
    const convId = msg.conversationId.toString();
    await msg.deleteOne();
    if (conv) {
      conv.participants.forEach((p) =>
        this.realtime.emitToUser(p.toString(), 'dm:deleted', {
          conversationId: convId,
          messageId,
        }),
      );
    }
    return { deleted: true };
  }

  async typing(userId: string, conversationId: string, isTyping: boolean) {
    const conv = await this.requireParticipant(conversationId, userId);
    const otherId = this.otherParticipant(conv, userId);
    this.realtime.emitToUser(otherId, 'dm:typing', {
      conversationId,
      userId,
      isTyping,
    });
    return { ok: true };
  }
}
