/*
  Warnings:

  - You are about to drop the column `jupiter` on the `user_configs` table. All the data in the column will be lost.
  - You are about to drop the column `jupiterApiKeyEnc` on the `user_secrets` table. All the data in the column will be lost.
  - You are about to drop the column `jupiterReferralAccount` on the `user_secrets` table. All the data in the column will be lost.
  - You are about to drop the column `jupiterReferralFeeBps` on the `user_secrets` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "user_configs" DROP COLUMN "jupiter";

-- AlterTable
ALTER TABLE "user_secrets" DROP COLUMN "jupiterApiKeyEnc",
DROP COLUMN "jupiterReferralAccount",
DROP COLUMN "jupiterReferralFeeBps";
