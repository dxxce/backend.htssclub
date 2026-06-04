import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChannelsModule } from '../channels/channels.module';
import { MessagesModule } from '../messages/messages.module';
import { ServersModule } from '../servers/servers.module';
import { UsersModule } from '../users/users.module';
import { DmModule } from '../dm/dm.module';
import { ChatGateway } from './chat.gateway';

@Module({
  imports: [
    AuthModule,
    UsersModule,
    ServersModule,
    ChannelsModule,
    MessagesModule,
    DmModule,
  ],
  providers: [ChatGateway],
})
export class ChatModule {}
