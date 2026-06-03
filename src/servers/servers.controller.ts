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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthUser } from '../common/types/jwt-payload';
import {
  CreateServerDto,
  BanMemberDto,
  JoinServerDto,
  ServerAnnouncementDto,
  SetNicknameDto,
  TransferOwnershipDto,
  UpdateMemberRoleDto,
  UpdateServerDto,
} from './dto/server.dto';
import { ServersService } from './servers.service';

@ApiTags('servers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('servers')
export class ServersController {
  constructor(private readonly servers: ServersService) {}

  @Post()
  @ApiOperation({ summary: 'Create a server (creator becomes OWNER)' })
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateServerDto) {
    return this.servers.create(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List servers the user is a member of' })
  async list(@CurrentUser() user: AuthUser) {
    return this.servers.listForUser(user.id);
  }

  @Post('join')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Join a server via invite code' })
  async join(@CurrentUser() user: AuthUser, @Body() dto: JoinServerDto) {
    return this.servers.join(user.id, dto.inviteCode);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get server detail (channels + members)' })
  async detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.servers.getDetail(id, user.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update server (ADMIN+)' })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateServerDto,
  ) {
    return this.servers.update(id, user.id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete server (OWNER)' })
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.servers.remove(id, user.id);
  }

  @Post(':id/invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create an invite code (ADMIN+)' })
  async invite(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.servers.createInvite(id, user.id);
  }

  @Delete(':id/invite')
  @ApiOperation({ summary: 'Revoke the current invite code (ADMIN+)' })
  async revokeInvite(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.servers.revokeInvite(id, user.id);
  }

  @Delete(':id/leave')
  @ApiOperation({ summary: 'Leave a server' })
  async leave(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.servers.leave(id, user.id);
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'List server members' })
  async members(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.servers.listMembers(id, user.id);
  }

  @Patch(':id/members/:userId/role')
  @ApiOperation({ summary: 'Change a member role (OWNER/ADMIN)' })
  async updateRole(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.servers.updateMemberRole(id, user.id, targetUserId, dto);
  }

  @Delete(':id/members/:userId')
  @ApiOperation({ summary: 'Kick a member (ADMIN+)' })
  async kick(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
  ) {
    return this.servers.kickMember(id, user.id, targetUserId);
  }

  // ── Server administration ─────────────────────────────────────

  @Post(':id/transfer-ownership')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transfer server ownership (OWNER only)' })
  async transferOwnership(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: TransferOwnershipDto,
  ) {
    return this.servers.transferOwnership(id, user.id, dto.newOwnerId);
  }

  @Post(':id/members/:userId/ban')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ban a member (ADMIN+)' })
  async ban(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
    @Body() dto: BanMemberDto,
  ) {
    return this.servers.banMember(id, user.id, targetUserId, dto.reason);
  }

  @Delete(':id/bans/:userId')
  @ApiOperation({ summary: 'Unban a user (ADMIN+)' })
  async unban(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
  ) {
    return this.servers.unbanMember(id, user.id, targetUserId);
  }

  @Get(':id/bans')
  @ApiOperation({ summary: 'List banned users (ADMIN+)' })
  async bans(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.servers.listBans(id, user.id);
  }

  @Patch(':id/members/:userId/nickname')
  @ApiOperation({
    summary: 'Set a member nickname (self, or ADMIN+ for others)',
  })
  async setNickname(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
    @Body() dto: SetNicknameDto,
  ) {
    return this.servers.setNickname(id, user.id, targetUserId, dto.nickname);
  }

  @Post(':id/announce')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Broadcast an announcement to the server (ADMIN+)' })
  async announce(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ServerAnnouncementDto,
  ) {
    return this.servers.announce(id, user.id, dto.message);
  }
}
