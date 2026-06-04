import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { GameMode, GameType, RoomStatus } from '../../../common/enums';
import { applyToJsonTransform } from '../../../common/schema-transform';

export type GameRoomDocument = HydratedDocument<GameRoom>;

export interface RoomMember {
  userId: Types.ObjectId;
  staked: boolean; // whether the bet has been collected into the pot
  ready: boolean;
  joinedAt: Date;
}

/**
 * A lobby for a game (Caro or Tien Len). Players join, the host starts, then
 * a concrete game document (CaroGame / TienLenGame) is created and linked via
 * `gameId`. Supports WAGER (coin pot) and RANKED/CASUAL modes.
 */
@Schema({ timestamps: true, collection: 'game_rooms' })
export class GameRoom {
  @Prop({ enum: GameType, required: true, index: true })
  game: GameType;

  @Prop({ enum: GameMode, required: true })
  mode: GameMode;

  // Short human-friendly join code (e.g. "CR-7K2Q").
  @Prop({ required: true, unique: true, index: true })
  code: string;

  @Prop({ required: true, default: false })
  isPrivate: boolean;

  @Prop()
  name?: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  hostId: Types.ObjectId;

  // Coins each player must stake (WAGER mode). 0 for ranked/casual.
  @Prop({ default: 0, min: 0 })
  betAmount: number;

  // Min/max players. Caro fixes both to 2; Tien Len allows 2..4.
  @Prop({ required: true })
  minPlayers: number;

  @Prop({ required: true })
  maxPlayers: number;

  @Prop({ type: [Object], default: [] })
  members: RoomMember[];

  @Prop({ enum: RoomStatus, default: RoomStatus.WAITING, index: true })
  status: RoomStatus;

  // Total coins currently escrowed (sum of staked members' bets).
  @Prop({ default: 0, min: 0 })
  pot: number;

  // The concrete game document id once started.
  @Prop({ type: Types.ObjectId })
  gameId?: Types.ObjectId;

  @Prop()
  startedAt?: Date;

  @Prop()
  closedAt?: Date;
}

export const GameRoomSchema = SchemaFactory.createForClass(GameRoom);
GameRoomSchema.index({ game: 1, status: 1, isPrivate: 1, _id: -1 });
applyToJsonTransform(GameRoomSchema);
