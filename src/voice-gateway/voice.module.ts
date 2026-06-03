import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChannelsModule } from '../channels/channels.module';
import { SfuService } from './sfu.service';
import { VoiceGateway } from './voice.gateway';
import { VoicePresenceModule } from './voice-presence.module';

@Module({
  imports: [AuthModule, ChannelsModule, VoicePresenceModule],
  providers: [VoiceGateway, SfuService],
  exports: [SfuService],
})
export class VoiceModule {}
