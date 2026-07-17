import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1778000000000 implements MigrationInterface {
  name = 'CreateVideos1778000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'failed')`,
    );
    await queryRunner.query(`
      CREATE TABLE "videos" (
        "id" uuid NOT NULL,
        "public_id" character varying(21) NOT NULL,
        "channel_id" uuid NOT NULL,
        "title" character varying(200) NOT NULL,
        "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft',
        "storage_key" character varying NOT NULL,
        "thumbnail_key" character varying,
        "content_type" character varying NOT NULL,
        "size_bytes" bigint NOT NULL,
        "duration_seconds" double precision,
        "metadata" jsonb,
        "multipart_upload_id" character varying,
        "failure_reason" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_videos_public_id" UNIQUE ("public_id"),
        CONSTRAINT "PK_videos_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_videos_channel_id" FOREIGN KEY ("channel_id")
          REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_channel_status" ON "videos" ("channel_id", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_videos_channel_status"`);
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
