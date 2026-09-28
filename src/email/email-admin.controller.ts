import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { NodemailerService, MailSendResult } from './nodemailer.service';
import { TestEmailDto } from './dto/test-email.dto';
import { MerchantRole } from '../merchants/entities/merchant.entity';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@ApiTags('admin/email')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(MerchantRole.ADMIN)
@Controller({ path: 'admin/email', version: '1' })
export class EmailAdminController {
  constructor(private readonly mailer: NodemailerService) {}

  @Post('test')
  @ApiOperation({ summary: 'Send a test email immediately (admin only)' })
  async testSend(
    @Body() dto: TestEmailDto,
  ): Promise<MailSendResult> {
    return this.mailer.send(dto.to, dto.templateAlias, dto.mergeData ?? {});
  }
}
