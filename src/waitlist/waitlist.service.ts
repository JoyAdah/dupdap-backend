import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Waitlist } from './entities/waitlist.entity';
import { JoinWaitlistDto } from './dto/join-waitlist.dto';

@Injectable()
export class WaitlistService {
  constructor(
    @InjectRepository(Waitlist)
    private readonly waitlistRepo: Repository<Waitlist>,
  ) {}

  async join(dto: JoinWaitlistDto) {
    const existing = await this.waitlistRepo.findOne({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Email already on waitlist');

    if (dto.username) {
      const existingUsername = await this.waitlistRepo.findOne({
        where: { username: dto.username },
      });
      if (existingUsername) throw new ConflictException('Username already taken');
    }

    const entry = this.waitlistRepo.create(dto);
    return this.waitlistRepo.save(entry);
  }
}
