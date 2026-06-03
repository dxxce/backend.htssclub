import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ServersModule } from '../servers/servers.module';
import { VoicePresenceModule } from '../voice-gateway/voice-presence.module';
import { Message, MessageSchema } from '../messages/schemas/message.schema';
import { Channel, ChannelSchema } from './schemas/channel.schema';
import {
  ChannelsController,
  ServerChannelsController,
} from './channels.controller';
import { ChannelsService } from './channels.service';

@Module({
  imports: [
    ServersModule,
    VoicePresenceModule,
    MongooseModule.forFeature([
      { name: Channel.name, schema: ChannelSchema },
      { name: Message.name, schema: MessageSchema },
    ]),
  ],
  controllers: [ServerChannelsController, ChannelsController],
  providers: [ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
