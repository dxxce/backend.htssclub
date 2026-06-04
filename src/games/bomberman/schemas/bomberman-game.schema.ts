import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { GameMode } from '../../../common/enums';

export enum BombermanStatus {
  ACTIVE = 'ACTIVE',
  FINISHED = 'FINISHED',
  ABORTED = 'ABORTED',
}

// A persisted record of a finished Bomberman match (live state lives in memory
// during play; only the result is stored for history + rank/wallet effects).
@Schema({ timestamps: true })
export class BombermanGame {
  @Prop({ type: [Types.ObjectId], ref: 'User', required: true })
  players: Types.ObjectId[];

  @Prop({ required: true, default: 'classic' })
  mapId: string;

  @Prop({ enum: GameMode, default: GameMode.RANKED })
  mode: GameMode;

  @Prop({ default: 0 })
  betAmount: number;

  @Prop({ default: 0 })
  pot: number;

  @Prop({ type: Types.ObjectId, ref: 'GameRoom' })
  roomId?: Types.ObjectId;

  @Prop({ enum: BombermanStatus, default: BombermanStatus.ACTIVE })
  status: BombermanStatus;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  winner?: Types.ObjectId;

  // seat -> finishing rank (1 = best). Stored as a plain object.
  @Prop({ type: Object, default: {} })
  placements: Record<string, number>;

  // ordered userId list, winner first (for history rendering)
  @Prop({ type: [String], default: [] })
  rankingUserIds: string[];

  @Prop({ type: Object })
  rpChange?: Record<string, number>;

  @Prop({ type: Object })
  coinChange?: Record<string, number>;

  @Prop()
  endedAt?: Date;
}

export type BombermanGameDocument = BombermanGame & Document;
export const BombermanGameSchema = SchemaFactory.createForClass(BombermanGame);
