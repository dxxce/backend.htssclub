import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { TxType } from '../../common/enums';
import { applyToJsonTransform } from '../../common/schema-transform';

export type TransactionDocument = HydratedDocument<Transaction>;

@Schema({ timestamps: true, collection: 'transactions' })
export class Transaction {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ enum: TxType, required: true })
  type: TxType;

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true })
  balanceAfter: number;

  @Prop()
  reason?: string;

  @Prop()
  refId?: string;

  // Links the debit + credit records of one transfer together.
  @Prop({ index: true })
  transferId?: string;
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);
TransactionSchema.index({ userId: 1, _id: -1 });
applyToJsonTransform(TransactionSchema);
