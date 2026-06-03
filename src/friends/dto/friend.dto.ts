import { ApiProperty } from '@nestjs/swagger';
import { IsMongoId } from 'class-validator';

export class TargetUserDto {
  @ApiProperty()
  @IsMongoId()
  userId: string;
}

export class RequestIdDto {
  @ApiProperty()
  @IsMongoId()
  requestId: string;
}
