import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { TxType } from '../common/enums';
import {
  buildPaginated,
  PaginatedResult,
} from '../common/dto/pagination.dto';
import { TransactionService } from '../database/transaction.util';
import { RealtimeService } from '../realtime/realtime.service';
import { DmService } from '../dm/dm.service';
import { UsersService } from '../users/users.service';
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
    private readonly dm: DmService,
    private readonly users: UsersService,
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
    transferId?: string,
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
            transferId,
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
    transferId?: string,
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
            transferId,
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
    const transferId = `tf_${randomUUID()}`;
    const result = await this.txService.withTransaction(async (session) => {
      const debited = await this.debit(
        fromUserId,
        dto.amount,
        TxType.TRANSFER,
        dto.note || `Transfer to ${dto.toUserId}`,
        dto.toUserId,
        session,
        transferId,
      );
      const credited = await this.credit(
        dto.toUserId,
        dto.amount,
        TxType.TRANSFER,
        dto.note || `Transfer from ${fromUserId}`,
        fromUserId,
        session,
        transferId,
      );
      return {
        from: { userId: fromUserId, balanceAfter: debited.balanceAfter, transaction: debited.transaction },
        to: { userId: dto.toUserId, balanceAfter: credited.balanceAfter, transaction: credited.transaction },
        amount: dto.amount,
      };
    });
    // Emit to both parties after the transaction commits (each sees only
    // their OWN new balance in the wallet:transaction event).
    this.emitWalletEvent(fromUserId, result.from.balanceAfter, result.from.transaction);
    this.emitWalletEvent(dto.toUserId, result.to.balanceAfter, result.to.transaction);
    // Post a non-deletable SYSTEM message into their DM recording the transfer.
    // The user's note (lời nhắn) is used as the message content; amount/details
    // live in systemData for the client to render the transfer card.
    await this.dm.postSystemMessage(
      fromUserId,
      dto.toUserId,
      (dto.note ?? '').trim(),
      {
        kind: 'COIN_TRANSFER',
        transferId,
        fromUserId,
        toUserId: dto.toUserId,
        amount: dto.amount,
        note: dto.note,
      },
    );
    // Hide both parties' balances from the response; return only an id +
    // public summary. Use GET /wallet/transfers/:transferId for detail.
    return {
      transferId,
      fromUserId,
      toUserId: dto.toUserId,
      amount: dto.amount,
      note: dto.note,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Returns the full detail of a transfer. Only the sender or recipient may
   * view it. Each caller sees their OWN balanceAfter only (never the other
   * party's balance).
   */
  async getTransferDetail(viewerId: string, transferId: string) {
    const records = await this.txModel
      .find({ transferId })
      .sort({ amount: 1 }) // debit (negative) first, credit (positive) second
      .exec();
    if (records.length === 0) {
      throw new NotFoundException('Transfer not found');
    }
    const debit = records.find((r) => r.amount < 0);
    const credit = records.find((r) => r.amount > 0);
    const fromUserId = debit?.userId.toString();
    const toUserId = credit?.userId.toString();
    if (viewerId !== fromUserId && viewerId !== toUserId) {
      throw new ForbiddenException('Not a participant of this transfer');
    }
    const amount = credit ? credit.amount : Math.abs(debit?.amount ?? 0);
    const cards = await this.users.getCards(
      [fromUserId, toUserId].filter(Boolean) as string[],
    );
    // The viewer's own transaction (so they can see their own balanceAfter).
    const mine = records.find((r) => r.userId.toString() === viewerId);
    return {
      transferId,
      amount,
      note: (debit ?? credit)?.reason,
      from: fromUserId
        ? cards.get(fromUserId) ?? { id: fromUserId, username: 'unknown' }
        : null,
      to: toUserId
        ? cards.get(toUserId) ?? { id: toUserId, username: 'unknown' }
        : null,
      direction: viewerId === fromUserId ? 'OUT' : 'IN',
      myBalanceAfter: mine?.balanceAfter ?? null,
      myTransactionId: mine?._id.toString() ?? null,
      createdAt: (mine ?? debit ?? credit)?.get('createdAt'),
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
