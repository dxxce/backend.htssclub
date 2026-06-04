import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../../auth/auth.module';
import { UsersModule } from '../../users/users.module';
import { LevelingModule } from '../../leveling/leveling.module';
import { GamesCommonModule } from '../common/games-common.module';
import {
  BombermanGame,
  BombermanGameSchema,
} from './schemas/bomberman-game.schema';
import { BombermanController } from './bomberman.controller';
import { BombermanService } from './bomberman.service';
import { BombermanGateway } from './bomberman.gateway';
import { BombermanMatchmakingService } from './bomberman-matchmaking.service';

@Module({
  imports: [
    AuthModule,
    UsersModule,
    LevelingModule,
    GamesCommonModule,
    MongooseModule.forFeature([
      { name: BombermanGame.name, schema: BombermanGameSchema },
    ]),
  ],
  controllers: [BombermanController],
  providers: [BombermanService, BombermanGateway, BombermanMatchmakingService],
  exports: [BombermanService],
})
export class BombermanModule {}
