import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ChannelType, MemberRole } from '../common/enums';
import { TransactionService } from '../database/transaction.util';
import { RealtimeService } from '../realtime/realtime.service';
import { ServersService } from '../servers/servers.service';
import { UsersService } from '../users/users.service';
import { VoicePresenceService } from '../voice-gateway/voice-presence.service';
import { Message, MessageDocument } from '../messages/schemas/message.schema';
import { Channel, ChannelDocument } from './schemas/channel.schema';
import {
  CreateChannelDto,
  ReorderChannelsDto,
  UpdateChannelDto,
} from './dto/channel.dto';

@Injectable()
export class ChannelsService {
  constructor(
    @InjectModel(Channel.name)
    private readonly model: Model<ChannelDocument>,
    @InjectModel(Message.name)
    private readonly messageModel: Model<MessageDocument>,
    private readonly servers: ServersService,
    private readonly users: UsersService,
    private readonly realtime: RealtimeService,
    private readonly voicePresence: VoicePresenceService,
    private readonly txService: TransactionService,
  ) {}

  private oid(id: string, label = 'id'): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Invalid ${label}`);
    }
    return new Types.ObjectId(id);
  }

  async create(serverId: string, userId: string, dto: CreateChannelDto) {
    await this.servers.requireRole(serverId, userId, MemberRole.ADMIN);
    if (dto.userLimit != null && dto.type !== ChannelType.VOICE) {
      throw new BadRequestException('userLimit is only valid for VOICE channels');
    }
    const last = await this.model
      .findOne({ serverId: new Types.ObjectId(serverId) })
      .sort({ position: -1 })
      .exec();
    const position = last ? last.position + 1 : 0;
    const channel = await this.model.create({
      serverId: new Types.ObjectId(serverId),
      name: dto.name,
      type: dto.type,
      topic: dto.topic,
      userLimit: dto.userLimit,
      position,
    });
    const json = channel.toJSON();
    this.realtime.emitToServer(serverId, 'channel:created', json);
    return json;
  }

  async listForServer(serverId: string, userId: string) {
    await this.servers.requireMembership(serverId, userId);
    const channels = await this.model
      .find({ serverId: new Types.ObjectId(serverId) })
      .sort({ position: 1, _id: 1 })
      .exec();

    // Attach current voice occupancy to VOICE channels so the initial
    // render shows who is already in each voice room.
    const result = await Promise.all(
      channels.map(async (c) => {
        const json = c.toJSON() as Record<string, any>;
        if (c.type === ChannelType.VOICE) {
          json.voiceMembers = await this.voiceMembersOf(c._id.toString());
        }
        return json;
      }),
    );
    return result;
  }

  /** Internal: enriched voice members for a channel (no access check). */
  private async voiceMembersOf(channelId: string) {
    const withState = await this.voicePresence.getMembersWithState(channelId);
    if (withState.length === 0) return [];
    const cards = await this.users.getCards(withState.map((m) => m.userId));
    return withState.map((m) => ({
      userId: m.userId,
      user: cards.get(m.userId) ?? { id: m.userId, username: 'unknown' },
      muted: m.state.muted,
      deafened: m.state.deafened,
      speaking: m.state.speaking,
      streaming: m.state.streaming,
    }));
  }

  async getByIdOrThrow(channelId: string): Promise<ChannelDocument> {
    const channel = await this.model.findById(this.oid(channelId)).exec();
    if (!channel) throw new NotFoundException('Channel not found');
    return channel;
  }

  /** Returns the serverId that owns a channel, or null if not found. */
  async getServerIdOfChannel(channelId: string): Promise<string | null> {
    if (!Types.ObjectId.isValid(channelId)) return null;
    const channel = await this.model
      .findById(channelId, { serverId: 1 })
      .exec();
    return channel ? channel.serverId.toString() : null;
  }

  /** Ensures the user can access the channel (is a member of its server). */
  async assertAccess(
    channelId: string,
    userId: string,
  ): Promise<ChannelDocument> {
    const channel = await this.getByIdOrThrow(channelId);
    await this.servers.requireMembership(
      channel.serverId.toString(),
      userId,
    );
    return channel;
  }

  /**
   * Returns the current voice members of a channel as VoiceMember[]
   * (userId + user card + mic state), for REST fallback / display.
   */
  async getVoiceMembers(channelId: string, userId: string) {
    await this.assertAccess(channelId, userId);
    return this.voiceMembersOf(channelId);
  }

  async update(channelId: string, userId: string, dto: UpdateChannelDto) {
    const channel = await this.getByIdOrThrow(channelId);
    await this.servers.requireRole(
      channel.serverId.toString(),
      userId,
      MemberRole.ADMIN,
    );
    if (dto.userLimit != null && channel.type !== ChannelType.VOICE) {
      throw new BadRequestException('userLimit is only valid for VOICE channels');
    }
    const update: Partial<Channel> = {};
    if (dto.name !== undefined) update.name = dto.name;
    if (dto.topic !== undefined) update.topic = dto.topic;
    if (dto.position !== undefined) update.position = dto.position;
    if (dto.userLimit !== undefined) update.userLimit = dto.userLimit;
    const updated = await this.model
      .findByIdAndUpdate(channelId, update, { new: true })
      .exec();
    const json = updated!.toJSON();
    this.realtime.emitToServer(
      channel.serverId.toString(),
      'channel:updated',
      json,
    );
    return json;
  }

  /**
   * Reorders channels in a server by applying a list of { channelId,
   * position } pairs in a single transaction (ADMIN+).
   */
  async reorder(serverId: string, userId: string, dto: ReorderChannelsDto) {
    await this.servers.requireRole(serverId, userId, MemberRole.ADMIN);
    const sid = new Types.ObjectId(serverId);
    // Validate all ids belong to this server.
    const ids = dto.items.map((i) => this.oid(i.channelId, 'channelId'));
    const count = await this.model
      .countDocuments({ _id: { $in: ids }, serverId: sid })
      .exec();
    if (count !== ids.length) {
      throw new BadRequestException(
        'All channels must belong to this server',
      );
    }
    await this.txService.withTransaction(async (session) => {
      for (const item of dto.items) {
        await this.model
          .updateOne(
            { _id: new Types.ObjectId(item.channelId), serverId: sid },
            { position: item.position },
            { session },
          )
          .exec();
      }
    });
    const channels = await this.model
      .find({ serverId: sid })
      .sort({ position: 1, _id: 1 })
      .exec();
    const json = channels.map((c) => c.toJSON());
    this.realtime.emitToServer(serverId, 'channel:reordered', {
      serverId,
      channels: json,
    });
    return json;
  }

  async remove(channelId: string, userId: string) {
    const channel = await this.getByIdOrThrow(channelId);
    const serverId = channel.serverId.toString();
    await this.servers.requireRole(serverId, userId, MemberRole.ADMIN);

    const cid = channel._id;
    // Delete the channel and all its messages atomically.
    await this.txService.withTransaction(async (session) => {
      await this.model.deleteOne({ _id: cid }, { session }).exec();
      await this.messageModel
        .deleteMany({ channelId: cid }, { session })
        .exec();
    });

    // If it was a voice channel, evict everyone currently connected and
    // clear their Redis presence.
    if (channel.type === ChannelType.VOICE) {
      try {
        const members = await this.voicePresence.listMembers(channelId);
        await Promise.all(
          members.map((uid) => this.voicePresence.removeUser(channelId, uid)),
        );
        this.realtime.closeVoiceChannel(channelId, 'voice:channel-closed', {
          channelId,
        });
      } catch {
        // best-effort cleanup; channel is already deleted
      }
    }

    this.realtime.emitToServer(serverId, 'channel:deleted', {
      serverId,
      channelId,
    });
    return { deleted: true };
  }
}
