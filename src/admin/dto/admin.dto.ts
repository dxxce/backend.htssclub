import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { AccountStatus } from '../../common/enums';

export class SetStatusDto {
  @ApiProperty({ enum: AccountStatus })
  @IsEnum(AccountStatus)
  status: AccountStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(256)
  reason?: string;
}

export class AdjustBalanceDto {
  @ApiProperty({ description: 'positive = credit, negative = debit' })
  @IsInt()
  amount: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  reason: string;
}
