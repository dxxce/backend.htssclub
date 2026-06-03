import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersModule } from '../users/users.module';
import { Server, ServerSchema } from './schemas/server.schema';
import {
  ServerMember,
  ServerMemberSchema,
} from './schemas/server-member.schema';
import { ServerBan, ServerBanSchema } from './schemas/server-ban.schema';
import { ServersController } from './servers.controller';
import { ServersService } from './servers.service';

@Module({
  imports: [
    UsersModule,
    MongooseModule.forFeature([
      { name: Server.name, schema: ServerSchema },
      { name: ServerMember.name, schema: ServerMemberSchema },
      { name: ServerBan.name, schema: ServerBanSchema },
    ]),
  ],
  controllers: [ServersController],
  providers: [ServersService],
  exports: [ServersService],
})
export class ServersModule {}
