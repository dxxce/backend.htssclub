import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { TxType } from '../common/enums';
import { TransactionService } from '../database/transaction.util';
import { RealtimeService } from '../realtime/realtime.service';
import { DmService } from '../dm/dm.service';
import { User } from '../users/schemas/user.schema';
import { Transaction } from './schemas/transaction.schema';
import { WalletService } from './wallet.service';

describe('WalletService', () => {
  let service: WalletService;
  let userModel: any;
  let txModel: any;

  beforeEach(async () => {
    userModel = {
      findOneAndUpdate: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      exists: jest.fn(),
    };
    txModel = {
      create: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: getModelToken(User.name), useValue: userModel },
        { provide: getModelToken(Transaction.name), useValue: txModel },
        {
          provide: TransactionService,
          // Run the work callback immediately with a fake session.
          useValue: {
            withTransaction: (work: any) => work({ id: 'session' }),
          },
        },
        {
          provide: RealtimeService,
          useValue: { emitToUser: jest.fn() },
        },
        {
          provide: DmService,
          useValue: { postSystemMessage: jest.fn() },
        },
      ],
    }).compile();

    service = moduleRef.get(WalletService);
  });

  it('debits when funds are sufficient', async () => {
    userModel.findOneAndUpdate.mockReturnValue({
      exec: () =>
        Promise.resolve({ _id: new Types.ObjectId(), balance: 50 }),
    });
    txModel.create.mockResolvedValue([
      { toJSON: () => ({ amount: -50, balanceAfter: 50 }) },
    ]);

    const result = await service.debit(
      new Types.ObjectId().toString(),
      50,
      TxType.SPEND,
      'buy',
    );

    expect(result.balanceAfter).toBe(50);
    // The atomic guard must require balance >= amount.
    const filter = userModel.findOneAndUpdate.mock.calls[0][0];
    expect(filter.balance).toEqual({ $gte: 50 });
  });

  it('throws on insufficient funds', async () => {
    userModel.findOneAndUpdate.mockReturnValue({
      exec: () => Promise.resolve(null),
    });
    userModel.exists.mockResolvedValue({ _id: 'x' });

    await expect(
      service.debit(new Types.ObjectId().toString(), 999, TxType.SPEND),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws NotFound when the user does not exist on debit', async () => {
    userModel.findOneAndUpdate.mockReturnValue({
      exec: () => Promise.resolve(null),
    });
    userModel.exists.mockResolvedValue(null);

    await expect(
      service.debit(new Types.ObjectId().toString(), 10, TxType.SPEND),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects non-positive debit amounts', async () => {
    await expect(
      service.debit(new Types.ObjectId().toString(), 0, TxType.SPEND),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('credits a positive amount', async () => {
    userModel.findByIdAndUpdate.mockReturnValue({
      exec: () =>
        Promise.resolve({ _id: new Types.ObjectId(), balance: 150 }),
    });
    txModel.create.mockResolvedValue([
      { toJSON: () => ({ amount: 100, balanceAfter: 150 }) },
    ]);

    const result = await service.credit(
      new Types.ObjectId().toString(),
      100,
      TxType.TOPUP,
    );
    expect(result.balanceAfter).toBe(150);
  });
});
