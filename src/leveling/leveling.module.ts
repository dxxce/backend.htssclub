import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LevelingController } from './leveling.controller';
import { LevelingService } from './leveling.service';

@Module({
  imports: [UsersModule, NotificationsModule],
  controllers: [LevelingController],
  providers: [LevelingService],
  exports: [LevelingService],
})
export class LevelingModule {}
