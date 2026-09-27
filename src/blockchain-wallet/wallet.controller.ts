import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BlockchainWalletService } from './blockchain-wallet.service';
import { WalletResponseDto } from './dto/wallet-response.dto';

@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly walletService: BlockchainWalletService) {}

  @Get()
  async getWallet(@Req() req: any): Promise<WalletResponseDto> {
    const wallet = await this.walletService.getWallet(req.user.merchantId);
    return WalletResponseDto.from(wallet);
  }

  @Get('balance')
  async getBalance(@Req() req: any): Promise<WalletResponseDto> {
    const wallet = await this.walletService.syncBalance(req.user.merchantId);
    return WalletResponseDto.from(wallet);
  }
}
