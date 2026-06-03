import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthUser } from '../common/types/jwt-payload';
import { VoicePresenceService } from '../voice-gateway/voice-presence.service';
import { ChannelsService } from './channels.service';
import { CreateChannelDto, UpdateChannelDto } from './dto/channel.dto';

@ApiTags('channels')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('servers/:serverId/channels')
export class ServerChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a channel (ADMIN+)' })
  async create(
    @CurrentUser() user: AuthUser,
    @Param('serverId') serverId: string,
    @Body() dto: CreateChannelDto,
  ) {
    return this.channels.create(serverId, user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List channels in a server' })
  async list(
    @CurrentUser() user: AuthUser,
    @Param('serverId') serverId: string,
  ) {
    return this.channels.listForServer(serverId, user.id);
  }
}

@ApiTags('channels')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('channels')
export class ChannelsController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly voicePresence: VoicePresenceService,
  ) {}

  @Patch(':channelId')
  @ApiOperation({ summary: 'Update a channel (ADMIN+)' })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('channelId') channelId: string,
    @Body() dto: UpdateChannelDto,
  ) {
    return this.channels.update(channelId, user.id, dto);
  }

  @Delete(':channelId')
  @ApiOperation({ summary: 'Delete a channel (ADMIN+)' })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('channelId') channelId: string,
  ) {
    return this.channels.remove(channelId, user.id);
  }

  @Get(':channelId/voice-members')
  @ApiOperation({ summary: 'List users currently in a voice channel' })
  async voiceMembers(
    @CurrentUser() user: AuthUser,
    @Param('channelId') channelId: string,
  ) {
    await this.channels.assertAccess(channelId, user.id);
    const members = await this.voicePresence.getMembersWithState(channelId);
    return { channelId, members };
  }
}
