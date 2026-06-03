import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { applyToJsonTransform } from '../../common/schema-transform';

export type ServerDocument = HydratedDocument<Server>;

@Schema({ timestamps: true, collection: 'servers' })
export class Server {
  @Prop({ required: true })
  name: string;

  @Prop()
  iconUrl?: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  ownerId: Types.ObjectId;

  @Prop()
  inviteCode?: string;

  // The platform default server: every new user auto-joins it and members
  // cannot leave; it cannot be deleted.
  @Prop({ default: false, index: true })
  isDefault: boolean;
}

export const ServerSchema = SchemaFactory.createForClass(Server);
ServerSchema.index({ inviteCode: 1 }, { unique: true, sparse: true });
applyToJsonTransform(ServerSchema);
