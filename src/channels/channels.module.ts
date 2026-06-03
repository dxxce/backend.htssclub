import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ServersModule } from '../servers/servers.module';
import { VoicePresenceModule } from '../voice-gateway/voice-presence.module';
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
    ]),
  ],
  controllers: [ServerChannelsController, ChannelsController],
  providers: [ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
