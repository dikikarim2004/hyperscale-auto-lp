/*
  Warnings:

  - The `notes` column on the `pool_memories` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "pool_memories" ADD COLUMN     "snapshots" JSONB NOT NULL DEFAULT '[]',
DROP COLUMN "notes",
ADD COLUMN     "notes" JSONB NOT NULL DEFAULT '[]';
