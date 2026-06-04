import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersModule } from '../users/users.module';
import { Friend, FriendSchema } from '../friends/schemas/friend.schema';
import {
  DmConversation,
  DmConversationSchema,
} from './schemas/dm-conversation.schema';
import { DmMessage, DmMessageSchema } from './schemas/dm-message.schema';
import { DmController } from './dm.controller';
import { DmService } from './dm.service';

@Module({
  imports: [
    UsersModule,
    MongooseModule.forFeature([
      { name: DmConversation.name, schema: DmConversationSchema },
      { name: DmMessage.name, schema: DmMessageSchema },
      { name: Friend.name, schema: FriendSchema },
    ]),
  ],
  controllers: [DmController],
  providers: [DmService],
  exports: [DmService],
})
export class DmModule {}
