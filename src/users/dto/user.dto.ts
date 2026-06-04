import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PresenceStatus } from '../../common/enums';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Kratos' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  displayName?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/a.png' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  avatarUrl?: string;

  @ApiPropertyOptional({ example: 'Full-stack dev, thích cà phê.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  bio?: string;

  @ApiPropertyOptional({ example: 'Đã có ngày nắng ráo...' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  statusMessage?: string;
}

export class UpdatePresenceDto {
  @ApiProperty({ enum: PresenceStatus })
  @IsEnum(PresenceStatus)
  status: PresenceStatus;
}

export class SearchUsersDto {
  @ApiProperty({ example: 'kra' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  q: string;
}
