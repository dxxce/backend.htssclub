import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
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

export class ReorderItemDto {
  @ApiProperty()
  @IsMongoId()
  channelId: string;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  position: number;
}

export class ReorderChannelsDto {
  @ApiProperty({ type: [ReorderItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  items: ReorderItemDto[];
}
