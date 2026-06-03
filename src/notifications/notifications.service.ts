import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  buildPaginated,
  PaginatedResult,
} from '../common/dto/pagination.dto';
import { RealtimeService } from '../realtime/realtime.service';
import {
  Notification,
  NotificationDocument,
} from './schemas/notification.schema';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(Notification.name)
    private readonly model: Model<NotificationDocument>,
    private readonly realtime: RealtimeService,
  ) {}

  /** Persists a notification and pushes it to the user's realtime room. */
  async create(
    userId: string | Types.ObjectId,
    type: string,
    payload: Record<string, any> = {},
  ): Promise<NotificationDocument> {
    const doc = await this.model.create({
      userId: new Types.ObjectId(userId),
      type,
      payload,
    });
    this.realtime.emitToUser(userId.toString(), 'notification:new', doc.toJSON());
    return doc;
  }

  async list(
    userId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<any>> {
    const filter = { userId: new Types.ObjectId(userId) };
    const [items, total] = await Promise.all([
      this.model
        .find(filter)
        .sort({ _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.model.countDocuments(filter).exec(),
    ]);
    return buildPaginated(
      items.map((i) => i.toJSON()),
      total,
      page,
      limit,
    );
  }

  async unreadCount(userId: string): Promise<number> {
    return this.model
      .countDocuments({
        userId: new Types.ObjectId(userId),
        readAt: { $exists: false },
      })
      .exec();
  }

  async markRead(userId: string, id: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) return;
    await this.model
      .updateOne(
        { _id: id, userId: new Types.ObjectId(userId) },
        { readAt: new Date() },
      )
      .exec();
  }

  async markAllRead(userId: string): Promise<void> {
    await this.model
      .updateMany(
        { userId: new Types.ObjectId(userId), readAt: { $exists: false } },
        { readAt: new Date() },
      )
      .exec();
  }
}
