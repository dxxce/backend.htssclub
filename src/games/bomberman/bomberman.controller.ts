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
import { BombermanService } from './bomberman.service';
import { MAPS } from './bomberman.logic';

@ApiTags('bomberman')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('games/bomberman')
export class BombermanController {
  constructor(
    private readonly bomberman: BombermanService,
    private readonly rooms: RoomsService,
  ) {}

  @Get('maps')
  @ApiOperation({ summary: 'List available Bomberman maps' })
  maps() {
    return MAPS.map((m) => ({ id: m.id, name: m.name, cols: m.cols, rows: m.rows }));
  }

  @Get('rooms')
  @ApiOperation({ summary: 'List open public Bomberman rooms' })
  openRooms() {
    return this.rooms.listOpen(GameType.BOMBERMAN);
  }

  @Get('rooms/mine')
  @ApiOperation({ summary: 'My current Bomberman room (for reconnection)' })
  myRoom(@CurrentUser() user: AuthUser) {
    return this.rooms.myRoom(GameType.BOMBERMAN, user.id);
  }

  @Get('rooms/code/:code')
  @ApiOperation({ summary: 'Look up a Bomberman room by join code' })
  async roomByCode(@Param('code') code: string) {
    const room = await this.rooms.getByCode(code);
    return this.rooms.publicView(room);
  }

  @Get('rooms/:roomId')
  @ApiOperation({ summary: 'Get a Bomberman room detail by id' })
  async room(@Param('roomId') roomId: string) {
    const room = await this.rooms.getOrThrow(roomId);
    return this.rooms.publicView(room);
  }

  @Get('active')
  @ApiOperation({ summary: 'My current active Bomberman game (reconnection)' })
  active(@CurrentUser() user: AuthUser) {
    return this.bomberman.myActiveGame(user.id);
  }

  @Get('history')
  @ApiOperation({ summary: 'My finished Bomberman games' })
  history(
    @CurrentUser() user: AuthUser,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    return this.bomberman.history(user.id, limit);
  }
}
