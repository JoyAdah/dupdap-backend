import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDbPoolExhaustedAlertType1772400000001 implements MigrationInterface {
  name = 'AddDbPoolExhaustedAlertType1772400000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const enumExistsResult = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'admin_alerts_type_enum'
          AND n.nspname = 'public'
      ) AS "exists"
    `);

    const enumExists = Boolean(enumExistsResult?.[0]?.exists);
    if (!enumExists) {
      return;
    }

    await queryRunner.query(
      `ALTER TYPE "public"."admin_alerts_type_enum" ADD VALUE IF NOT EXISTS 'db_pool_exhausted'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL does not support removing enum values; down is a no-op
  }
}
