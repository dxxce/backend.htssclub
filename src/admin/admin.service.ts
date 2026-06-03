import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AccountStatus, PresenceStatus } from '../common/enums';
import { AuthService } from '../auth/auth.service';
import { Message, MessageDocument } from '../messages/schemas/message.schema';
import { RealtimeService } from '../realtime/realtime.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { WalletService } from '../wallet/wallet.service';
import { AdjustBalanceDto, SetStatusDto } from './dto/admin.dto';

@Injectable()
export class AdminService {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly wallet: WalletService,
    private readonly realtime: RealtimeService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Message.name)
    private readonly messageModel: Model<MessageDocument>,
  ) {}

  async setStatus(targetUserId: string, dto: SetStatusDto) {
    const user = await this.users.setStatus(targetUserId, dto.status);
    if (
      dto.status === AccountStatus.BANNED ||
      dto.status === AccountStatus.SUSPENDED
    ) {
      // Revoke all sessions and disconnect live sockets.
      await this.auth.logoutAll(targetUserId);
      this.realtime.disconnectUser(targetUserId);
    }
    return { id: user._id.toString(), status: user.status, reason: dto.reason };
  }

  async adjustBalance(targetUserId: string, dto: AdjustBalanceDto) {
    return this.wallet.adminAdjust(targetUserId, dto.amount, dto.reason);
  }

  async stats() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [totalUsers, online, messagesToday] = await Promise.all([
      this.userModel.countDocuments().exec(),
      this.userModel
        .countDocuments({ presence: { $ne: PresenceStatus.OFFLINE } })
        .exec(),
      this.messageModel
        .countDocuments({ createdAt: { $gte: since } })
        .exec(),
    ]);
    return { totalUsers, online, messagesToday };
  }
}
