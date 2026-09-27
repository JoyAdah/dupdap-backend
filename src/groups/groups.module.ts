import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Group } from './entities/group.entity';
import { GroupMember } from './entities/group-member.entity';
import { GroupsRepository } from './groups.repository';
import { GroupsService } from './groups.service';
import { GroupsController } from './groups.controller';
import { StellarModule } from '../stellar/stellar.module';
import { BlockchainWalletModule } from '../blockchain-wallet/blockchain-wallet.module';

@Module({
  imports: [TypeOrmModule.forFeature([Group, GroupMember]), StellarModule, BlockchainWalletModule],
  providers: [GroupsRepository, GroupsService],
  controllers: [GroupsController],
  exports: [GroupsService],
})
export class GroupsModule {}
