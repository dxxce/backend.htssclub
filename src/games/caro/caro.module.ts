import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../../auth/auth.module';
import { UsersModule } from '../../users/users.module';
import { LevelingModule } from '../../leveling/leveling.module';
import { GamesCommonModule } from '../common/games-common.module';
import { CaroGame, CaroGameSchema } from './schemas/caro-game.schema';
import { CaroController } from './caro.controller';
import { CaroService } from './caro.service';
import { CaroGateway } from './caro.gateway';
import { CaroMatchmakingService } from './caro-matchmaking.service';

@Module({
  imports: [
    AuthModule,
    UsersModule,
    LevelingModule,
    GamesCommonModule,
    MongooseModule.forFeature([
      { name: CaroGame.name, schema: CaroGameSchema },
    ]),
  ],
  controllers: [CaroController],
  providers: [CaroService, CaroGateway, CaroMatchmakingService],
  exports: [CaroService],
})
export class CaroModule {}
