import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { applyToJsonTransform } from '../../common/schema-transform';

export type DmConversationDocument = HydratedDocument<DmConversation>;

/**
 * A 1:1 direct-message conversation. `participants` is always stored sorted
 * so the pair maps to exactly one conversation regardless of who starts it.
 */
@Schema({ timestamps: true, collection: 'dm_conversations' })
export class DmConversation {
  @Prop({ type: [Types.ObjectId], ref: 'User', required: true, index: true })
  participants: Types.ObjectId[];

  // Denormalized for fast inbox sorting / preview.
  @Prop()
  lastMessageAt?: Date;

  // Per-user unread counters keyed by userId string.
  @Prop({ type: Object, default: {} })
  unread: Record<string, number>;
}

export const DmConversationSchema =
  SchemaFactory.createForClass(DmConversation);
applyToJsonTransform(DmConversationSchema);
