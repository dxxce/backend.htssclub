import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthUser } from '../common/types/jwt-payload';
import { LeaderboardKind, LevelingService } from './leveling.service';

function parseKind(raw?: string): LeaderboardKind {
  const k = (raw || 'xp').toLowerCase();
  if (k !== 'xp' && k !== 'coins' && k !== 'rank') {
    throw new BadRequestException('type must be "xp", "coins" or "rank"');
  }
  return k as LeaderboardKind;
}

@ApiTags('leveling')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class LevelingController {
  constructor(private readonly leveling: LevelingService) {}

  @Get('users/me/level')
  @ApiOperation({ summary: 'My level + XP progress' })
  async myLevel(@CurrentUser() user: AuthUser) {
    return this.leveling.getProgress(user.id);
  }

  @Get('users/:id/level')
  @ApiOperation({ summary: "A user's level + XP progress" })
  async userLevel(@Param('id') id: string) {
    return this.leveling.getProgress(id);
  }

  @Get('users/me/rank')
  @ApiOperation({ summary: 'My rank (tier/division from RP, independent of XP)' })
  async myRankTier(@CurrentUser() user: AuthUser) {
    return this.leveling.getRank(user.id);
  }

  @Get('users/:id/rank')
  @ApiOperation({ summary: "A user's rank tier/division" })
  async userRank(@Param('id') id: string) {
    return this.leveling.getRank(id);
  }

  @Get('leaderboard')
  @ApiOperation({ summary: 'Leaderboard by XP/level, coins, or rank' })
  @ApiQuery({ name: 'type', enum: ['xp', 'coins', 'rank'], required: false })
  async leaderboard(
    @Query('type') type?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
  ) {
    return this.leveling.leaderboard(parseKind(type), limit);
  }

  @Get('leaderboard/both')
  @ApiOperation({ summary: 'All leaderboards (xp + coins + rank) in one call' })
  async both(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
  ) {
    const [xp, coins, rank] = await Promise.all([
      this.leveling.leaderboard('xp', limit),
      this.leveling.leaderboard('coins', limit),
      this.leveling.leaderboard('rank', limit),
    ]);
    return { xp, coins, rank };
  }

  @Get('leaderboard/me')
  @ApiOperation({ summary: 'My rank on a leaderboard' })
  @ApiQuery({ name: 'type', enum: ['xp', 'coins', 'rank'], required: false })
  async myRank(@CurrentUser() user: AuthUser, @Query('type') type?: string) {
    return this.leveling.myRank(user.id, parseKind(type));
  }
}
