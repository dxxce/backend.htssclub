import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { AttachmentCategory } from '../../common/enums';
import { applyToJsonTransform } from '../../common/schema-transform';

export type MessageDocument = HydratedDocument<Message>;

export interface MessageAttachment {
  url: string;
  type: string;
  name: string;
  size: number;
  category?: AttachmentCategory;
}

@Schema({ timestamps: true, collection: 'messages' })
export class Message {
  @Prop({ type: Types.ObjectId, ref: 'Channel', required: true, index: true })
  channelId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  authorId: Types.ObjectId;

  // Optional: a message may contain only attachments (empty content).
  @Prop({ default: '' })
  content: string;

  @Prop({ type: [Object] })
  attachments?: MessageAttachment[];

  @Prop({ type: Types.ObjectId, ref: 'Message' })
  replyToId?: Types.ObjectId;

  @Prop()
  editedAt?: Date;
}

export const MessageSchema = SchemaFactory.createForClass(Message);
// History pagination by _id (newest -> oldest) scoped to a channel
MessageSchema.index({ channelId: 1, _id: -1 });
applyToJsonTransform(MessageSchema);
