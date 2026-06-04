import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { forwardRef, Inject } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthUser } from '../common/types/jwt-payload';
import { AuthService } from '../auth/auth.service';
import { UsersService } from './users.service';
import {
  SearchUsersDto,
  UpdatePresenceDto,
  UpdateProfileDto,
} from './dto/user.dto';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    @Inject(forwardRef(() => AuthService))
    private readonly auth: AuthService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('search')
  @ApiOperation({ summary: 'Search users by username (with friendStatus)' })
  async search(@CurrentUser() user: AuthUser, @Query() dto: SearchUsersDto) {
    const users = await this.users.search(dto.q);
    return Promise.all(
      users.map(async (u) => {
        const id = u._id.toString();
        const friend = await this.users.getFriendStatus(user.id, id);
        return {
          ...this.users.toPublic(u),
          friendStatus: friend.status,
          friendRequestId: friend.requestId,
        };
      }),
    );
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('me/sessions')
  @ApiOperation({ summary: 'List active login sessions' })
  async sessions(@CurrentUser() user: AuthUser) {
    const sessions = await this.auth.listSessions(user.id);
    return sessions.map((s) => s.toJSON());
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Delete('me/sessions/:sessionId')
  @ApiOperation({ summary: 'Revoke a specific session' })
  async revokeSession(
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
  ) {
    await this.auth.revokeSession(user.id, sessionId);
    return { revoked: true };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Patch('me')
  @ApiOperation({ summary: 'Update own profile' })
  async updateMe(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateProfileDto,
  ) {
    const updated = await this.users.updateProfile(user.id, dto);
    return updated.toJSON();
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Patch('me/presence')
  @ApiOperation({ summary: 'Set presence status' })
  async updatePresence(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdatePresenceDto,
  ) {
    await this.users.setPresence(user.id, dto.status);
    return { presence: dto.status };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get(':id')
  @ApiOperation({
    summary: 'Get a public user profile (includes friendStatus vs caller)',
  })
  async getById(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const target = await this.users.findByIdOrThrow(id);
    const friend = await this.users.getFriendStatus(user.id, id);
    return {
      ...this.users.toPublic(target),
      friendStatus: friend.status,
      friendRequestId: friend.requestId,
    };
  }
}
