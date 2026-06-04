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
  if (k !== 'xp' && k !== 'coins') {
    throw new BadRequestException('type must be "xp" or "coins"');
  }
  return k;
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

  @Get('leaderboard')
  @ApiOperation({ summary: 'Leaderboard by XP/level or coins' })
  @ApiQuery({ name: 'type', enum: ['xp', 'coins'], required: false })
  async leaderboard(
    @Query('type') type?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
  ) {
    return this.leveling.leaderboard(parseKind(type), limit);
  }

  @Get('leaderboard/both')
  @ApiOperation({ summary: 'Both leaderboards (xp + coins) in one call' })
  async both(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
  ) {
    const [xp, coins] = await Promise.all([
      this.leveling.leaderboard('xp', limit),
      this.leveling.leaderboard('coins', limit),
    ]);
    return { xp, coins };
  }

  @Get('leaderboard/me')
  @ApiOperation({ summary: 'My rank on a leaderboard' })
  @ApiQuery({ name: 'type', enum: ['xp', 'coins'], required: false })
  async myRank(@CurrentUser() user: AuthUser, @Query('type') type?: string) {
    return this.leveling.myRank(user.id, parseKind(type));
  }
}
