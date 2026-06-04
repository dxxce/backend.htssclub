import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthUser } from '../common/types/jwt-payload';
import { SpendDto, TopupDto, TransferDto } from './dto/wallet.dto';
import { WalletService } from './wallet.service';

@ApiTags('wallet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('balance')
  @ApiOperation({ summary: 'Get current balance' })
  async balance(@CurrentUser() user: AuthUser) {
    const balance = await this.wallet.getBalance(user.id);
    return { balance };
  }

  @Get('transactions')
  @ApiOperation({ summary: 'List transaction history' })
  async transactions(
    @CurrentUser() user: AuthUser,
    @Query() q: PaginationQueryDto,
  ) {
    return this.wallet.listTransactions(user.id, q.page, q.limit);
  }

  @Post('topup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create a top-up request' })
  async topup(@CurrentUser() user: AuthUser, @Body() dto: TopupDto) {
    return this.wallet.createTopup(user.id, dto);
  }

  @Post('spend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Spend coins (atomic, sufficient-funds guard)' })
  async spend(@CurrentUser() user: AuthUser, @Body() dto: SpendDto) {
    return this.wallet.spend(user.id, dto);
  }

  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transfer coins to another user (atomic)' })
  async transfer(@CurrentUser() user: AuthUser, @Body() dto: TransferDto) {
    return this.wallet.transfer(user.id, dto);
  }

  @Get('transfers/:transferId')
  @ApiOperation({
    summary: 'Get a transfer detail (participants only; own balance only)',
  })
  async transferDetail(
    @CurrentUser() user: AuthUser,
    @Param('transferId') transferId: string,
  ) {
    return this.wallet.getTransferDetail(user.id, transferId);
  }
}
