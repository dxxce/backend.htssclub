import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { MemberRole } from '../../common/enums';
import { applyToJsonTransform } from '../../common/schema-transform';

export type ServerMemberDocument = HydratedDocument<ServerMember>;

@Schema({ timestamps: true, collection: 'server_members' })
export class ServerMember {
  @Prop({ type: Types.ObjectId, ref: 'Server', required: true, index: true })
  serverId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ enum: MemberRole, default: MemberRole.MEMBER })
  role: MemberRole;

  // Optional per-server display name override set by the user or an admin.
  @Prop()
  nickname?: string;

  @Prop({ default: () => new Date() })
  joinedAt: Date;
}

export const ServerMemberSchema = SchemaFactory.createForClass(ServerMember);
ServerMemberSchema.index({ serverId: 1, userId: 1 }, { unique: true });
applyToJsonTransform(ServerMemberSchema);
