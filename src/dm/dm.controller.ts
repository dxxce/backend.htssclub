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
import { DmService } from './dm.service';
import { DmHistoryDto, EditDmDto, SendDmDto } from './dto/dm.dto';

@ApiTags('dm')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('dm')
export class DmController {
  constructor(private readonly dm: DmService) {}

  // ── Conversations ─────────────────────────────────────────────
  @Get('conversations')
  @ApiOperation({ summary: 'List my DM conversations (inbox)' })
  async conversations(@CurrentUser() user: AuthUser) {
    return this.dm.listConversations(user.id);
  }

  @Post('conversations')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start (or fetch) a conversation with a user' })
  async start(
    @CurrentUser() user: AuthUser,
    @Body() body: { toUserId: string },
  ) {
    return this.dm.startConversation(user.id, body.toUserId);
  }

  @Get('conversations/:conversationId/messages')
  @ApiOperation({ summary: 'Get message history (cursor by before)' })
  async history(
    @CurrentUser() user: AuthUser,
    @Param('conversationId') conversationId: string,
    @Query() q: DmHistoryDto,
  ) {
    return this.dm.history(user.id, conversationId, q);
  }

  @Patch('conversations/:conversationId/read')
  @ApiOperation({ summary: 'Mark a conversation as read' })
  async markRead(
    @CurrentUser() user: AuthUser,
    @Param('conversationId') conversationId: string,
  ) {
    return this.dm.markRead(user.id, conversationId);
  }

  // ── Messages ──────────────────────────────────────────────────
  @Throttle({ default: { limit: 30, ttl: 10_000 } })
  @Post('messages')
  @ApiOperation({
    summary: 'Send a DM (TLS in transit, encrypted at rest, server-readable)',
  })
  async send(@CurrentUser() user: AuthUser, @Body() dto: SendDmDto) {
    return this.dm.send(user.id, dto);
  }

  @Patch('messages/:messageId')
  @ApiOperation({ summary: 'Edit a DM (sender only)' })
  async edit(
    @CurrentUser() user: AuthUser,
    @Param('messageId') messageId: string,
    @Body() dto: EditDmDto,
  ) {
    return this.dm.edit(user.id, messageId, dto.content);
  }

  @Delete('messages/:messageId')
  @ApiOperation({ summary: 'Delete a DM (sender only)' })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('messageId') messageId: string,
  ) {
    return this.dm.remove(user.id, messageId);
  }
}
