import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { AttachmentCategory } from '../../common/enums';

export class AttachmentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  url: string;

  @ApiProperty({ description: 'MIME type, e.g. image/png, video/mp4' })
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

  @ApiPropertyOptional({ enum: AttachmentCategory })
  @IsOptional()
  @IsEnum(AttachmentCategory)
  category?: AttachmentCategory;
}

export class CreateMessageDto {
  @ApiPropertyOptional({
    example: 'Hello world',
    description: 'Optional when at least one attachment is provided',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  content?: string;

  @ApiPropertyOptional({ type: [AttachmentDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  replyToId?: string;
}

export class UpdateMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  content: string;
}

export class MessageHistoryDto {
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

export class ReactionDto {
  @ApiProperty({ example: '👍', description: 'A single emoji, max 32 chars' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  emoji: string;
}
