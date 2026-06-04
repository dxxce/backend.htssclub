import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class DmAttachmentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  url: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  type: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  size: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;
}

export class SendDmDto {
  @ApiProperty({ description: 'Recipient user id' })
  @IsMongoId()
  toUserId: string;

  @ApiPropertyOptional({
    description: 'Message text (optional if attachments are provided)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  content?: string;

  @ApiPropertyOptional({ type: [DmAttachmentDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => DmAttachmentDto)
  attachments?: DmAttachmentDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  replyToId?: string;
}

export class EditDmDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  content: string;
}

export class DmHistoryDto {
  @ApiPropertyOptional({ description: 'Return messages before this id' })
  @IsOptional()
  @IsMongoId()
  before?: string;

  @ApiPropertyOptional({ default: 30, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit = 30;
}
