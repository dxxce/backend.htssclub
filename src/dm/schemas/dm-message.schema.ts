import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { applyToJsonTransform } from '../../common/schema-transform';

export type DmMessageDocument = HydratedDocument<DmMessage>;

export interface DmAttachment {
  url: string;
  type: string;
  name: string;
  size: number;
  category?: string;
}

/**
 * A direct message, Discord-style: transport over TLS, stored encrypted at
 * rest (AES-256-GCM). The server CAN read content (for search/moderation);
 * `content` holds the encrypted blob and is decrypted in the service layer
 * before being returned to clients.
 */
@Schema({ timestamps: true, collection: 'dm_messages' })
export class DmMessage {
  @Prop({
    type: Types.ObjectId,
    ref: 'DmConversation',
    required: true,
    index: true,
  })
  conversationId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  senderId: Types.ObjectId;

  // Encrypted-at-rest message text (base64 AES-256-GCM blob). May be empty
  // if the message only carries attachments.
  @Prop({ default: '' })
  content: string;

  @Prop({ type: [Object] })
  attachments?: DmAttachment[];

  @Prop({ type: Types.ObjectId, ref: 'DmMessage' })
  replyToId?: Types.ObjectId;

  @Prop()
  editedAt?: Date;
}

export const DmMessageSchema = SchemaFactory.createForClass(DmMessage);
DmMessageSchema.index({ conversationId: 1, _id: -1 });
applyToJsonTransform(DmMessageSchema);
