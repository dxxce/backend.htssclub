import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { FriendState } from '../../common/enums';
import { applyToJsonTransform } from '../../common/schema-transform';

export type FriendDocument = HydratedDocument<Friend>;

@Schema({ timestamps: true, collection: 'friends' })
export class Friend {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  requesterId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  addresseeId: Types.ObjectId;

  @Prop({ enum: FriendState, default: FriendState.PENDING })
  state: FriendState;
}

export const FriendSchema = SchemaFactory.createForClass(Friend);
FriendSchema.index({ requesterId: 1, addresseeId: 1 }, { unique: true });
applyToJsonTransform(FriendSchema);
