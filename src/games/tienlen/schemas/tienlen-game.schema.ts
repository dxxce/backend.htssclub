import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { GameMode } from '../../../common/enums';
import { applyToJsonTransform } from '../../../common/schema-transform';

export type TienLenGameDocument = HydratedDocument<TienLenGame>;

export enum TienLenStatus {
  ACTIVE = 'ACTIVE',
  FINISHED = 'FINISHED',
  ABORTED = 'ABORTED',
}

export interface TienLenSeat {
  userId: Types.ObjectId;
  seat: number; // 0..n-1, turn order
  hand: number[]; // remaining cards (server-only; redacted in public view)
  handCount: number; // # cards left (public)
  finishedRank: number; // 0 = still playing, 1=first out, 2=second...
  passed: boolean; // passed in the current trick
  connected: boolean;
}

export interface TienLenPlay {
  seat: number;
  userId: Types.ObjectId;
  cards: number[]; // [] means a pass
  comboType?: string;
  at: Date;
}

/**
 * A 2–4 player Tiến Lên match. Mode RANKED (RP by finishing place), WAGER
 * (winner takes the coin pot) or CASUAL. Server-authoritative.
 */
@Schema({ timestamps: true, collection: 'tienlen_games' })
export class TienLenGame {
  @Prop({ type: Types.ObjectId, index: true })
  roomId?: Types.ObjectId;

  @Prop({ enum: GameMode, default: GameMode.CASUAL, index: true })
  mode: GameMode;

  @Prop({ default: 0, min: 0 })
  betAmount: number;

  @Prop({ default: 0, min: 0 })
  pot: number;

  @Prop({ enum: TienLenStatus, default: TienLenStatus.ACTIVE, index: true })
  status: TienLenStatus;

  @Prop({ type: [Object], default: [] })
  seats: TienLenSeat[];

  // Seat index whose turn it is.
  @Prop({ default: 0 })
  turn: number;

  // The lowest dealt card; the opening play must contain it (it determines who
  // leads). Usually 3♠ in a 4-player game, but a higher card with <4 players.
  @Prop({ default: 0 })
  openingCard: number;

  // The combo currently on the table that must be beaten ([] = free lead).
  @Prop({ type: [Number], default: [] })
  currentCombo: number[];

  @Prop()
  currentComboType?: string;

  // Seat that played the current combo (when everyone else passes, they lead).
  @Prop({ default: -1 })
  leadSeat: number;

  @Prop({ type: [Object], default: [] })
  history: TienLenPlay[];

  // Finishing order of seats (seat indexes), first place first.
  @Prop({ type: [Number], default: [] })
  finishOrder: number[];

  // Seats that resigned/forfeited, in the order they resigned. They are placed
  // at the BOTTOM of the final ranking (earliest resigner = very last).
  @Prop({ type: [Number], default: [] })
  resignedSeats: number[];

  // RP applied at end keyed by userId string (RANKED).
  @Prop({ type: Object })
  rpChange?: Record<string, number>;

  // Coin deltas applied at end keyed by userId (WAGER).
  @Prop({ type: Object })
  coinChange?: Record<string, number>;

  // Chop ("chặt heo") events during the game, for client display + audit.
  @Prop({ type: [Object], default: [] })
  chops: Array<{
    chopper: string; // userId who chopped
    victim: string; // userId whose heo was chopped
    heoCount: number; // total # of 2s chopped (1 or 2)
    black: number; // # of black heo (♠/♣)
    red: number; // # of red heo (♦/♥) — priced double
    at: Date;
  }>;

  // Set when the game ended immediately on deal ("tới trắng").
  @Prop()
  instantWinUserId?: string;

  @Prop()
  instantWinKind?: string;

  @Prop()
  endedAt?: Date;
}

export const TienLenGameSchema = SchemaFactory.createForClass(TienLenGame);
TienLenGameSchema.index({ status: 1, _id: -1 });
applyToJsonTransform(TienLenGameSchema);
