import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { AccountStatus, PresenceStatus } from '../../common/enums';
import { applyToJsonTransform } from '../../common/schema-transform';

export type UserDocument = HydratedDocument<User>;

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({ required: true, unique: true, index: true })
  username: string;

  @Prop({ required: true, unique: true, index: true })
  email: string;

  @Prop({ required: true })
  passwordHash: string;

  @Prop()
  displayName?: string;

  @Prop()
  avatarUrl?: string;

  // Short profile description.
  @Prop({ maxlength: 300 })
  bio?: string;

  // Custom status line / quote shown next to the user (not AccountStatus).
  @Prop({ maxlength: 128 })
  statusMessage?: string;

  @Prop({ default: 0, min: 0 })
  balance: number;

  // Leveling: total accumulated XP and the derived level (denormalized for
  // fast leaderboard sorting). `level` is kept in sync with `xp`.
  @Prop({ default: 0, min: 0, index: true })
  xp: number;

  @Prop({ default: 1, min: 1, index: true })
  level: number;

  // Ranking: INDEPENDENT from XP/level. Rank tier/division derive from these
  // Rank Points. Indexed for the rank leaderboard.
  @Prop({ default: 0, min: 0, index: true })
  rankPoints: number;

  @Prop({ enum: AccountStatus, default: AccountStatus.ACTIVE })
  status: AccountStatus;

  @Prop({ enum: PresenceStatus, default: PresenceStatus.OFFLINE })
  presence: PresenceStatus;

  // The presence the user explicitly chose (ONLINE/IDLE/DND/OFFLINE).
  // Restored on reconnect so a manual IDLE/DND is not reset to ONLINE.
  @Prop({ enum: PresenceStatus, default: PresenceStatus.ONLINE })
  desiredPresence: PresenceStatus;

  @Prop()
  lastSeenAt?: Date;

  @Prop({ default: false })
  isAdmin: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);
applyToJsonTransform(UserSchema);
