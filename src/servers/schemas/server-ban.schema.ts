import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { applyToJsonTransform } from '../../common/schema-transform';

export type ServerBanDocument = HydratedDocument<ServerBan>;

@Schema({ timestamps: true, collection: 'server_bans' })
export class ServerBan {
  @Prop({ type: Types.ObjectId, ref: 'Server', required: true, index: true })
  serverId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  bannedBy: Types.ObjectId;

  @Prop()
  reason?: string;
}

export const ServerBanSchema = SchemaFactory.createForClass(ServerBan);
ServerBanSchema.index({ serverId: 1, userId: 1 }, { unique: true });
applyToJsonTransform(ServerBanSchema);
