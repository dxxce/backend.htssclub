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
import { Message, MessageDocument } from './schemas/message.schema';
import {
  CreateMessageDto,
  MessageHistoryDto,
  UpdateMessageDto,
} from './dto/message.dto';

@Injectable()
export class MessagesService {
  constructor(
    @InjectModel(Message.name)
    private readonly model: Model<MessageDocument>,
    private readonly channels: ChannelsService,
    private readonly servers: ServersService,
    private readonly realtime: RealtimeService,
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
    return {
      items: docs.map((d) => d.toJSON()),
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
      replyToId:
        dto.replyToId && Types.ObjectId.isValid(dto.replyToId)
          ? new Types.ObjectId(dto.replyToId)
          : undefined,
    });
    const json = doc.toJSON();
    this.realtime.emitToChannel(channelId, 'message:new', json);
    return json;
  }

  async update(messageId: string, userId: string, dto: UpdateMessageDto) {
    const message = await this.getOrThrow(messageId);
    if (message.authorId.toString() !== userId) {
      throw new ForbiddenException('Only the author can edit this message');
    }
    message.content = dto.content;
    message.editedAt = new Date();
    await message.save();
    const json = message.toJSON();
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
    await message.deleteOne();
    this.realtime.emitToChannel(channelId, 'message:deleted', {
      messageId,
      channelId,
    });
    return { deleted: true };
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
