import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthUser } from '../common/types/jwt-payload';
import {
  CreateMessageDto,
  MessageHistoryDto,
  ReactionDto,
  UpdateMessageDto,
} from './dto/message.dto';
import { MessagesService } from './messages.service';

@ApiTags('messages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('channels/:channelId/messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get()
  @ApiOperation({ summary: 'Get message history (cursor by before)' })
  async history(
    @CurrentUser() user: AuthUser,
    @Param('channelId') channelId: string,
    @Query() q: MessageHistoryDto,
  ) {
    return this.messages.history(channelId, user.id, q);
  }

  @Throttle({ default: { limit: 20, ttl: 10_000 } })
  @Post()
  @ApiOperation({ summary: 'Send a message (also broadcasts via WebSocket)' })
  async create(
    @CurrentUser() user: AuthUser,
    @Param('channelId') channelId: string,
    @Body() dto: CreateMessageDto,
  ) {
    return this.messages.create(channelId, user.id, dto);
  }

  @Patch(':messageId')
  @ApiOperation({ summary: 'Edit a message (author only)' })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('messageId') messageId: string,
    @Body() dto: UpdateMessageDto,
  ) {
    return this.messages.update(messageId, user.id, dto);
  }

  @Delete(':messageId')
  @ApiOperation({ summary: 'Delete a message (author or ADMIN+)' })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('messageId') messageId: string,
  ) {
    return this.messages.remove(messageId, user.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':messageId/reactions')
  @ApiOperation({ summary: 'Add a reaction to a message (idempotent)' })
  async addReaction(
    @CurrentUser() user: AuthUser,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string,
    @Body() dto: ReactionDto,
  ) {
    return this.messages.addReaction(channelId, messageId, user.id, dto.emoji);
  }

  @Delete(':messageId/reactions')
  @ApiOperation({ summary: 'Remove your reaction from a message' })
  async removeReaction(
    @CurrentUser() user: AuthUser,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string,
    @Body() dto: ReactionDto,
  ) {
    return this.messages.removeReaction(
      channelId,
      messageId,
      user.id,
      dto.emoji,
    );
  }
}
