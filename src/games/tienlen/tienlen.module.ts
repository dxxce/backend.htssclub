import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../../auth/auth.module';
import { UsersModule } from '../../users/users.module';
import { LevelingModule } from '../../leveling/leveling.module';
import { GamesCommonModule } from '../common/games-common.module';
import {
  TienLenGame,
  TienLenGameSchema,
} from './schemas/tienlen-game.schema';
import { TienLenController } from './tienlen.controller';
import { TienLenService } from './tienlen.service';
import { TienLenGateway } from './tienlen.gateway';
import { TienLenMatchmakingService } from './tienlen-matchmaking.service';

@Module({
  imports: [
    AuthModule,
    UsersModule,
    LevelingModule,
    GamesCommonModule,
    MongooseModule.forFeature([
      { name: TienLenGame.name, schema: TienLenGameSchema },
    ]),
  ],
  controllers: [TienLenController],
  providers: [TienLenService, TienLenGateway, TienLenMatchmakingService],
  exports: [TienLenService],
})
export class TienLenModule {}
