import { Global, Module } from '@nestjs/common';
import { TransactionService } from './transaction.util';

@Global()
@Module({
  providers: [TransactionService],
  exports: [TransactionService],
})
export class DatabaseModule {}
