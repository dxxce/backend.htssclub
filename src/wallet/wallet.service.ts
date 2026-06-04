import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { TxType } from '../common/enums';
import {
  buildPaginated,
  PaginatedResult,
} from '../common/dto/pagination.dto';
import { TransactionService } from '../database/transaction.util';
import { RealtimeService } from '../realtime/realtime.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import {
  Transaction,
  TransactionDocument,
} from './schemas/transaction.schema';
import { SpendDto, TopupDto, TransferDto } from './dto/wallet.dto';

@Injectable()
export class WalletService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Transaction.name)
    private readonly txModel: Model<TransactionDocument>,
    private readonly txService: TransactionService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Pushes a balance update + the transaction to the user's personal room. */
  private emitWalletEvent(
    userId: string | Types.ObjectId,
    balanceAfter: number,
    transaction: any,
  ): void {
    this.realtime.emitToUser(userId.toString(), 'wallet:transaction', {
      balance: balanceAfter,
      transaction,
    });
  }

  async getBalance(userId: string): Promise<number> {
    const user = await this.userModel.findById(userId, { balance: 1 }).exec();
    if (!user) throw new NotFoundException('User not found');
    return user.balance;
  }

  async listTransactions(
    userId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<any>> {
    const filter = { userId: new Types.ObjectId(userId) };
    const [items, total] = await Promise.all([
      this.txModel
        .find(filter)
        .sort({ _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.txModel.countDocuments(filter).exec(),
    ]);
    return buildPaginated(
      items.map((t) => t.toJSON()),
      total,
      page,
      limit,
    );
  }

  /**
   * Credits a user's balance atomically and records a Transaction.
   * Used by topup confirmation, rewards, refunds.
   */
  async credit(
    userId: string | Types.ObjectId,
    amount: number,
    type: TxType,
    reason?: string,
    refId?: string,
    existingSession?: ClientSession,
  ): Promise<{ balanceAfter: number; transaction: any }> {
    if (amount <= 0) {
      throw new BadRequestException('amount must be positive');
    }
    const run = async (session: ClientSession) => {
      const user = await this.userModel
        .findByIdAndUpdate(
          userId,
          { $inc: { balance: amount } },
          { new: true, session },
        )
        .exec();
      if (!user) throw new NotFoundException('User not found');
      const [tx] = await this.txModel.create(
        [
          {
            userId: new Types.ObjectId(userId),
            type,
            amount,
            balanceAfter: user.balance,
            reason,
            refId,
          },
        ],
        { session },
      );
      return { balanceAfter: user.balance, transaction: tx.toJSON() };
    };
    if (existingSession) {
      return run(existingSession);
    }
    const result = await this.txService.withTransaction(run);
    // Owns the transaction -> safe to emit after commit.
    this.emitWalletEvent(userId, result.balanceAfter, result.transaction);
    return result;
  }

  /**
   * Debits a user's balance atomically with a sufficient-funds guard.
   * The `$inc` only applies when `balance >= amount`, preventing races
   * and negative balances.
   */
  async debit(
    userId: string | Types.ObjectId,
    amount: number,
    type: TxType,
    reason?: string,
    refId?: string,
    existingSession?: ClientSession,
  ): Promise<{ balanceAfter: number; transaction: any }> {
    if (amount <= 0) {
      throw new BadRequestException('amount must be positive');
    }
    const run = async (session: ClientSession) => {
      const user = await this.userModel
        .findOneAndUpdate(
          { _id: userId, balance: { $gte: amount } },
          { $inc: { balance: -amount } },
          { new: true, session },
        )
        .exec();
      if (!user) {
        // Either the user doesn't exist or has insufficient funds.
        const exists = await this.userModel.exists({ _id: userId });
        if (!exists) throw new NotFoundException('User not found');
        throw new BadRequestException('Insufficient balance');
      }
      const [tx] = await this.txModel.create(
        [
          {
            userId: new Types.ObjectId(userId),
            type,
            amount: -amount,
            balanceAfter: user.balance,
            reason,
            refId,
          },
        ],
        { session },
      );
      return { balanceAfter: user.balance, transaction: tx.toJSON() };
    };
    if (existingSession) {
      return run(existingSession);
    }
    const result = await this.txService.withTransaction(run);
    this.emitWalletEvent(userId, result.balanceAfter, result.transaction);
    return result;
  }

  async spend(userId: string, dto: SpendDto) {
    return this.debit(userId, dto.amount, TxType.SPEND, dto.reason, dto.refId);
  }

  /**
   * Creates a pending top-up request. Real money is confirmed via the
   * payment gateway webhook (confirmTopup). Here we only register intent.
   */
  async createTopup(userId: string, dto: TopupDto) {
    // In a real integration this returns a payment URL / order id.
    const refId = `topup_${Date.now()}_${userId.slice(-6)}`;
    return {
      pending: true,
      amount: dto.amount,
      method: dto.method,
      refId,
      message: 'Top-up request created. Awaiting payment confirmation.',
    };
  }

  /** Called by payment webhook after a successful payment. */
  async confirmTopup(userId: string, amount: number, refId: string) {
    return this.credit(userId, amount, TxType.TOPUP, 'Top-up', refId);
  }

  async transfer(fromUserId: string, dto: TransferDto) {
    if (fromUserId === dto.toUserId) {
      throw new BadRequestException('Cannot transfer to yourself');
    }
    const result = await this.txService.withTransaction(async (session) => {
      const debited = await this.debit(
        fromUserId,
        dto.amount,
        TxType.TRANSFER,
        dto.note || `Transfer to ${dto.toUserId}`,
        dto.toUserId,
        session,
      );
      const credited = await this.credit(
        dto.toUserId,
        dto.amount,
        TxType.TRANSFER,
        dto.note || `Transfer from ${fromUserId}`,
        fromUserId,
        session,
      );
      return {
        from: { userId: fromUserId, balanceAfter: debited.balanceAfter, transaction: debited.transaction },
        to: { userId: dto.toUserId, balanceAfter: credited.balanceAfter, transaction: credited.transaction },
        amount: dto.amount,
      };
    });
    // Emit to both parties after the transaction commits.
    this.emitWalletEvent(fromUserId, result.from.balanceAfter, result.from.transaction);
    this.emitWalletEvent(dto.toUserId, result.to.balanceAfter, result.to.transaction);
    return {
      from: { userId: result.from.userId, balanceAfter: result.from.balanceAfter },
      to: { userId: result.to.userId, balanceAfter: result.to.balanceAfter },
      amount: result.amount,
    };
  }

  /** Admin manual adjustment (positive credit or negative debit). */
  async adminAdjust(userId: string, amount: number, reason: string) {
    if (amount === 0) {
      throw new BadRequestException('amount cannot be zero');
    }
    if (amount > 0) {
      return this.credit(userId, amount, TxType.REWARD, reason);
    }
    return this.debit(userId, Math.abs(amount), TxType.REFUND, reason);
  }
}
