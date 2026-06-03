import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthUser } from '../common/types/jwt-payload';
import { RequestIdDto, TargetUserDto } from './dto/friend.dto';
import { FriendsService } from './friends.service';

@ApiTags('friends')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('friends')
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  @Get()
  @ApiOperation({ summary: 'List accepted friends' })
  async list(@CurrentUser() user: AuthUser) {
    return this.friends.listFriends(user.id);
  }

  @Get('requests')
  @ApiOperation({ summary: 'List pending friend requests' })
  async requests(@CurrentUser() user: AuthUser) {
    return this.friends.listRequests(user.id);
  }

  @Post('request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a friend request' })
  async request(@CurrentUser() user: AuthUser, @Body() dto: TargetUserDto) {
    return this.friends.sendRequest(user.id, dto.userId);
  }

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a friend request' })
  async accept(@CurrentUser() user: AuthUser, @Body() dto: RequestIdDto) {
    return this.friends.accept(user.id, dto.requestId);
  }

  @Post('decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline a friend request' })
  async decline(@CurrentUser() user: AuthUser, @Body() dto: RequestIdDto) {
    return this.friends.decline(user.id, dto.requestId);
  }

  @Post('block')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Block a user' })
  async block(@CurrentUser() user: AuthUser, @Body() dto: TargetUserDto) {
    return this.friends.block(user.id, dto.userId);
  }

  @Delete('block/:userId')
  @ApiOperation({ summary: 'Unblock a user' })
  async unblock(
    @CurrentUser() user: AuthUser,
    @Param('userId') userId: string,
  ) {
    return this.friends.unblock(user.id, userId);
  }

  @Delete(':userId')
  @ApiOperation({ summary: 'Remove a friend' })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('userId') userId: string,
  ) {
    return this.friends.removeFriend(user.id, userId);
  }
}
