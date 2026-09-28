import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum EmailStatus {
  QUEUED = 'queued',
  SENT = 'sent',
  FAILED = 'failed',
}

@Entity('email_logs')
@Index('IDX_email_logs_status', ['status'])
@Index('IDX_email_logs_user_id', ['userId'])
export class EmailLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  userId: string;

  @Column()
  to: string;

  @Column()
  templateAlias: string;

  @Column()
  subject: string;

  @Column({ type: 'enum', enum: EmailStatus, default: EmailStatus.QUEUED })
  status: EmailStatus;

  @Column({ nullable: true })
  providerMessageId: string;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @Column({ default: 0 })
  attemptCount: number;

  @Column({ nullable: true })
  sentAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
