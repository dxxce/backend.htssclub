import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { DmMessageType } from '../../common/enums';
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
 *
 * SYSTEM messages (e.g. coin transfers) are server-generated, not encrypted,
 * and cannot be edited or deleted by users.
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

  @Prop({ enum: DmMessageType, default: DmMessageType.USER })
  type: DmMessageType;

  // Encrypted-at-rest message text (base64 AES-256-GCM blob) for USER
  // messages. Empty for attachment-only or SYSTEM messages.
  @Prop({ default: '' })
  content: string;

  // Plain structured payload for SYSTEM messages (e.g. transfer details).
  // Not encrypted: it is server-generated, non-sensitive display data.
  @Prop({ type: Object })
  systemData?: Record<string, any>;

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
