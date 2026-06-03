import { Schema } from 'mongoose';

/**
 * Applies the standard toJSON transform to a Mongoose schema:
 * `_id` -> `id`, removes `__v`, `passwordHash`, `refreshHash`.
 */
export function applyToJsonTransform(schema: Schema): void {
  schema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: (_doc, ret: Record<string, any>) => {
      ret.id = ret._id?.toString?.() ?? ret._id;
      delete ret._id;
      delete ret.__v;
      delete ret.passwordHash;
      delete ret.refreshHash;
      return ret;
    },
  });
  schema.set('toObject', { virtuals: true });
}
