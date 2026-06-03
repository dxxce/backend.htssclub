import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminOnly } from '../common/decorators/admin.decorator';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminService } from './admin.service';
import { AdjustBalanceDto, SetStatusDto } from './dto/admin.dto';

@ApiTags('admin')
@ApiBearerAuth()
@AdminOnly()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Patch('users/:id/status')
  @ApiOperation({ summary: 'Set account status (ACTIVE/BANNED/SUSPENDED)' })
  async setStatus(@Param('id') id: string, @Body() dto: SetStatusDto) {
    return this.admin.setStatus(id, dto);
  }

  @Post('users/:id/balance')
  @ApiOperation({ summary: 'Manually adjust a user balance' })
  async adjustBalance(
    @Param('id') id: string,
    @Body() dto: AdjustBalanceDto,
  ) {
    return this.admin.adjustBalance(id, dto);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Platform statistics' })
  async stats() {
    return this.admin.stats();
  }
}
