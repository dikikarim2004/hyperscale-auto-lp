-- Add the new identifier as nullable first so existing generated wallets survive.
ALTER TABLE "wallets" ADD COLUMN "id" TEXT;

UPDATE "wallets"
SET "id" = md5("telegramId" || ':' || "publicKey")
WHERE "id" IS NULL;

ALTER TABLE "wallets"
  ALTER COLUMN "id" SET NOT NULL,
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT false;

-- The old single wallet was the user's active wallet by definition.
WITH ranked AS (
  SELECT ctid, row_number() OVER (PARTITION BY "telegramId" ORDER BY "createdAt", "id") AS rank
  FROM "wallets"
)
UPDATE "wallets" AS wallet
SET "isActive" = ranked.rank = 1
FROM ranked
WHERE wallet.ctid = ranked.ctid;

ALTER TABLE "wallets" DROP CONSTRAINT "wallets_pkey",
ADD CONSTRAINT "wallets_pkey" PRIMARY KEY ("id");

-- CreateIndex
CREATE INDEX "wallets_telegramId_isActive_idx" ON "wallets"("telegramId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_telegramId_publicKey_key" ON "wallets"("telegramId", "publicKey");
