import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

export class TopupDto {
  @ApiProperty({ example: 1000, description: 'amount in coins (integer)' })
  @IsInt()
  @IsPositive()
  amount: number;

  @ApiProperty({ example: 'vnpay' })
  @IsString()
  @IsNotEmpty()
  method: string;
}

export class SpendDto {
  @ApiProperty({ example: 100 })
  @IsInt()
  @IsPositive()
  amount: number;

  @ApiProperty({ example: 'Buy item X' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  reason: string;

  @ApiPropertyOptional({ example: 'order_123' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  refId?: string;
}

export class TransferDto {
  @ApiProperty()
  @IsMongoId()
  toUserId: string;

  @ApiProperty({ example: 50 })
  @IsInt()
  @IsPositive()
  amount: number;

  @ApiPropertyOptional({ example: 'thanks!' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  note?: string;
}
