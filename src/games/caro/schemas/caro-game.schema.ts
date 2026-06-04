import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { GameMode } from '../../../common/enums';
import { applyToJsonTransform } from '../../../common/schema-transform';

export type CaroGameDocument = HydratedDocument<CaroGame>;

export enum CaroStatus {
  ACTIVE = 'ACTIVE',
  FINISHED = 'FINISHED',
  ABORTED = 'ABORTED',
}

export enum CaroEndReason {
  WIN = 'WIN', // 5 in a row
  RESIGN = 'RESIGN',
  TIMEOUT = 'TIMEOUT', // move/turn clock expired
  DISCONNECT = 'DISCONNECT', // left and did not return in time
  DRAW = 'DRAW', // board full
  ABORTED = 'ABORTED', // no moves played / cancelled
}

export interface CaroMove {
  by: number; // mark 1 or 2
  row: number;
  col: number;
  at: Date;
}

/**
 * A ranked (or casual) 1v1 Caro match. The live board also lives in Redis
 * for fast play; this document is the durable record + reconnection source.
 */
@Schema({ timestamps: true, collection: 'caro_games' })
export class CaroGame {
  // playerX moves first (mark 1), playerO second (mark 2).
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  playerX: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  playerO: Types.ObjectId;

  @Prop({ default: true })
  ranked: boolean;

  // Game mode: RANKED (RP), WAGER (coin pot), or CASUAL (nothing at stake).
  @Prop({ enum: GameMode, default: GameMode.RANKED, index: true })
  mode: GameMode;

  // WAGER mode: each player's stake and the total pot the winner takes.
  @Prop({ default: 0, min: 0 })
  betAmount: number;

  @Prop({ default: 0, min: 0 })
  pot: number;

  // Links back to the lobby room (WAGER/custom rooms). Null for quick-match.
  @Prop({ type: Types.ObjectId })
  roomId?: Types.ObjectId;

  @Prop({ enum: CaroStatus, default: CaroStatus.ACTIVE, index: true })
  status: CaroStatus;

  // Flat board snapshot (length 225). Authoritative copy is Redis while ACTIVE.
  @Prop({ type: [Number], default: [] })
  board: number[];

  @Prop({ type: [Object], default: [] })
  moves: CaroMove[];

  // Whose turn: 1 (X) or 2 (O).
  @Prop({ default: 1 })
  turn: number;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  winner?: Types.ObjectId; // null on draw/abort

  @Prop({ enum: CaroEndReason })
  endReason?: CaroEndReason;

  @Prop({ type: [Number] })
  winningLine?: number[];

  // RP applied at game end, keyed by userId string.
  @Prop({ type: Object })
  rpChange?: Record<string, number>;

  @Prop()
  endedAt?: Date;
}

export const CaroGameSchema = SchemaFactory.createForClass(CaroGame);
CaroGameSchema.index({ status: 1, _id: -1 });
applyToJsonTransform(CaroGameSchema);
