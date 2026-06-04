import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersModule } from '../../users/users.module';
import { WalletModule } from '../../wallet/wallet.module';
import { GameRoom, GameRoomSchema } from './schemas/game-room.schema';
import { RoomsService } from './rooms.service';
import { WagerService } from './wager.service';
import { ChallengeService } from './challenge.service';

/**
 * Shared building blocks for all games: coin escrow (WagerService), the
 * generic lobby (RoomsService + GameRoom schema), and 1v1 challenge invites
 * (ChallengeService). Imported by CaroModule and TienLenModule.
 */
@Module({
  imports: [
    UsersModule,
    WalletModule,
    MongooseModule.forFeature([
      { name: GameRoom.name, schema: GameRoomSchema },
    ]),
  ],
  providers: [RoomsService, WagerService, ChallengeService],
  exports: [RoomsService, WagerService, ChallengeService, MongooseModule],
})
export class GamesCommonModule {}
