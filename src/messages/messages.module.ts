import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ChannelsModule } from '../channels/channels.module';
import { ServersModule } from '../servers/servers.module';
import { UsersModule } from '../users/users.module';
import { Message, MessageSchema } from './schemas/message.schema';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

@Module({
  imports: [
    ChannelsModule,
    ServersModule,
    UsersModule,
    MongooseModule.forFeature([
      { name: Message.name, schema: MessageSchema },
    ]),
  ],
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
