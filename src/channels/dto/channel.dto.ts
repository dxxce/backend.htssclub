import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ChannelType } from '../../common/enums';

export class CreateChannelDto {
  @ApiProperty({ example: 'general' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name: string;

  @ApiProperty({ enum: ChannelType, default: ChannelType.TEXT })
  @IsEnum(ChannelType)
  type: ChannelType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(256)
  topic?: string;

  @ApiPropertyOptional({ description: 'VOICE only; 0/undefined = unlimited' })
  @IsOptional()
  @IsInt()
  @Min(0)
  userLimit?: number;
}

export class UpdateChannelDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(256)
  topic?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  position?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  userLimit?: number;
}
