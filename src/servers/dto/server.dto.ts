import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MemberRole } from '../../common/enums';

export class CreateServerDto {
  @ApiProperty({ example: 'HTSS Club' })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  iconUrl?: string;
}

export class UpdateServerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  iconUrl?: string;
}

export class JoinServerDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  inviteCode: string;
}

export class UpdateMemberRoleDto {
  @ApiProperty({ enum: [MemberRole.ADMIN, MemberRole.MEMBER] })
  @IsEnum(MemberRole)
  role: MemberRole;
}

export class TransferOwnershipDto {
  @ApiProperty({ description: 'User id of the new owner (must be a member)' })
  @IsString()
  @IsNotEmpty()
  newOwnerId: string;
}

export class BanMemberDto {
  @ApiPropertyOptional({ example: 'Spamming' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  reason?: string;
}

export class SetNicknameDto {
  @ApiPropertyOptional({ example: 'Capatain', description: 'empty to clear' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  nickname?: string;
}

export class ServerAnnouncementDto {
  @ApiProperty({ example: 'Server maintenance at 10pm' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  message: string;
}
