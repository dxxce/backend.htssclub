import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/types/jwt-payload';
import { GameType } from '../../common/enums';
import { RoomsService } from '../common/rooms.service';
import { TienLenService } from './tienlen.service';

@ApiTags('tienlen')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('games/tienlen')
export class TienLenController {
  constructor(
    private readonly tienlen: TienLenService,
    private readonly rooms: RoomsService,
  ) {}

  @Get('rooms')
  @ApiOperation({ summary: 'List open public Tiến Lên rooms' })
  async openRooms() {
    return this.rooms.listOpen(GameType.TIENLEN);
  }

  @Get('rooms/mine')
  @ApiOperation({ summary: 'My current Tiến Lên room (for reconnection)' })
  async myRoom(@CurrentUser() user: AuthUser) {
    return this.rooms.myRoom(GameType.TIENLEN, user.id);
  }

  @Get('active')
  @ApiOperation({ summary: 'My current active Tiến Lên game (for reconnection)' })
  async active(@CurrentUser() user: AuthUser) {
    return this.tienlen.myActiveGame(user.id);
  }

  @Get('history')
  @ApiOperation({ summary: 'My finished Tiến Lên games' })
  async history(
    @CurrentUser() user: AuthUser,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    return this.tienlen.history(user.id, limit);
  }

  @Get(':gameId')
  @ApiOperation({ summary: 'Get a Tiến Lên game state by id (hand redacted)' })
  async game(
    @CurrentUser() user: AuthUser,
    @Param('gameId') gameId: string,
  ) {
    const game = await this.tienlen.getGameOrThrow(gameId);
    return this.tienlen.publicView(game, user.id);
  }
}
