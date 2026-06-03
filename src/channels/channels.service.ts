import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ChannelType, MemberRole } from '../common/enums';
import { ServersService } from '../servers/servers.service';
import { Channel, ChannelDocument } from './schemas/channel.schema';
import { CreateChannelDto, UpdateChannelDto } from './dto/channel.dto';

@Injectable()
export class ChannelsService {
  constructor(
    @InjectModel(Channel.name)
    private readonly model: Model<ChannelDocument>,
    private readonly servers: ServersService,
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
    return channel.toJSON();
  }

  async listForServer(serverId: string, userId: string) {
    await this.servers.requireMembership(serverId, userId);
    const channels = await this.model
      .find({ serverId: new Types.ObjectId(serverId) })
      .sort({ position: 1, _id: 1 })
      .exec();
    return channels.map((c) => c.toJSON());
  }

  async getByIdOrThrow(channelId: string): Promise<ChannelDocument> {
    const channel = await this.model.findById(this.oid(channelId)).exec();
    if (!channel) throw new NotFoundException('Channel not found');
    return channel;
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
    return updated!.toJSON();
  }

  async remove(channelId: string, userId: string) {
    const channel = await this.getByIdOrThrow(channelId);
    await this.servers.requireRole(
      channel.serverId.toString(),
      userId,
      MemberRole.ADMIN,
    );
    await channel.deleteOne();
    return { deleted: true };
  }
}
