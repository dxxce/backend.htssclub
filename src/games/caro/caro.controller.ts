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
import { CaroService } from './caro.service';

@ApiTags('caro')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('games/caro')
export class CaroController {
  constructor(
    private readonly caro: CaroService,
    private readonly rooms: RoomsService,
  ) {}

  @Get('rooms')
  @ApiOperation({ summary: 'List open public Caro wager rooms' })
  async openRooms() {
    return this.rooms.listOpen(GameType.CARO);
  }

  @Get('rooms/mine')
  @ApiOperation({ summary: 'My current Caro room (for reconnection)' })
  async myRoom(@CurrentUser() user: AuthUser) {
    return this.rooms.myRoom(GameType.CARO, user.id);
  }

  @Get('rooms/code/:code')
  @ApiOperation({ summary: 'Look up a Caro room by its join code' })
  async roomByCode(@Param('code') code: string) {
    const room = await this.rooms.getByCode(code);
    return this.rooms.publicView(room);
  }

  @Get('rooms/:roomId')
  @ApiOperation({ summary: 'Get a Caro room detail by id' })
  async room(@Param('roomId') roomId: string) {
    const room = await this.rooms.getOrThrow(roomId);
    return this.rooms.publicView(room);
  }

  @Get('active')
  @ApiOperation({ summary: 'My current active Caro game (for reconnection)' })
  async active(@CurrentUser() user: AuthUser) {
    return this.caro.myActiveGame(user.id);
  }

  @Get('history')
  @ApiOperation({ summary: 'My finished Caro games' })
  async history(
    @CurrentUser() user: AuthUser,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    return this.caro.history(user.id, limit);
  }

  @Get(':gameId')
  @ApiOperation({ summary: 'Get a Caro game state by id' })
  async game(@Param('gameId') gameId: string) {
    const game = await this.caro.getGameOrThrow(gameId);
    return this.caro.publicView(game);
  }
}
