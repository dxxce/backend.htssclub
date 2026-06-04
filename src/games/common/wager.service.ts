import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TxType } from '../../common/enums';
import { WalletService } from '../../wallet/wallet.service';

/**
 * Handles coin escrow for wager games. Each player's stake is debited when
 * they lock into a room (held by the house) and the whole pot is paid to the
 * winner(s) at the end. If a game is cancelled before it starts, every
 * collected stake is refunded.
 *
 * We don't keep a separate "house" account: debiting all players and crediting
 * the winner the total pot is conservation-of-coins equivalent.
 */
@Injectable()
export class WagerService {
  private readonly logger = new Logger(WagerService.name);

  constructor(private readonly wallet: WalletService) {}

  /** Pulls `amount` from the user into escrow. Throws if insufficient funds. */
  async collectStake(
    userId: string,
    amount: number,
    refId: string,
  ): Promise<void> {
    if (amount <= 0) throw new BadRequestException('Bet amount must be > 0');
    await this.wallet.debit(
      userId,
      amount,
      TxType.GAME_STAKE,
      `Game stake (${refId})`,
      refId,
    );
  }

  /** Pays `amount` to the winner from the pot. */
  async payout(userId: string, amount: number, refId: string): Promise<void> {
    if (amount <= 0) return;
    await this.wallet.credit(
      userId,
      amount,
      TxType.GAME_PAYOUT,
      `Game payout (${refId})`,
      refId,
    );
  }

  /** Refunds a previously collected stake (e.g. room cancelled). */
  async refund(userId: string, amount: number, refId: string): Promise<void> {
    if (amount <= 0) return;
    await this.wallet.credit(
      userId,
      amount,
      TxType.GAME_REFUND,
      `Game refund (${refId})`,
      refId,
    );
  }

  /** Best-effort refund for many users; never throws. */
  async refundMany(
    userIds: string[],
    amount: number,
    refId: string,
  ): Promise<void> {
    await Promise.all(
      userIds.map((id) =>
        this.refund(id, amount, refId).catch((e) =>
          this.logger.warn(
            `refund failed for ${id} (${refId}): ${(e as Error).message}`,
          ),
        ),
      ),
    );
  }
}
