import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ChannelType } from '../../common/enums';
import { applyToJsonTransform } from '../../common/schema-transform';

export type ChannelDocument = HydratedDocument<Channel>;

@Schema({ timestamps: true, collection: 'channels' })
export class Channel {
  @Prop({ type: Types.ObjectId, ref: 'Server', required: true, index: true })
  serverId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ enum: ChannelType, default: ChannelType.TEXT })
  type: ChannelType;

  @Prop()
  topic?: string;

  @Prop({ default: 0 })
  position: number;

  @Prop()
  userLimit?: number;
}

export const ChannelSchema = SchemaFactory.createForClass(Channel);
applyToJsonTransform(ChannelSchema);
