/**
 * Token blacklist — mints a user's agent should never deploy into.
 * Per-user (telegramId-scoped), persisted in Postgres via Prisma.
 *
 * Agent can blacklist via Telegram ("blacklist this token, it rugged").
 * Screening filters blacklisted tokens before passing pools to the LLM.
 */

import { prisma } from "./db/client.js";
import { log } from "./logger.js";

// ─── Check ─────────────────────────────────────────────────────

/**
 * Returns true if the mint is on this user's blacklist.
 * Used in screening.js before returning pools to the LLM.
 */
export async function isBlacklisted(telegramId, mint) {
  if (!mint) return false;
  const entry = await prisma.tokenBlacklistEntry.findUnique({
    where: { telegramId_mint: { telegramId, mint } },
  });
  return !!entry;
}

// ─── Tool Handlers ─────────────────────────────────────────────

/**
 * Tool handler: add_to_blacklist
 */
export async function addToBlacklist(telegramId, { mint, symbol, reason }) {
  if (!mint) return { error: "mint required" };

  const existing = await prisma.tokenBlacklistEntry.findUnique({
    where: { telegramId_mint: { telegramId, mint } },
  });
  if (existing) {
    return { already_blacklisted: true, mint, symbol: existing.symbol, reason: existing.reason };
  }

  await prisma.tokenBlacklistEntry.create({
    data: { telegramId, mint, symbol: symbol || "UNKNOWN", reason: reason || "no reason provided", addedBy: "agent" },
  });
  log("blacklist", `[${telegramId}] Blacklisted ${symbol || mint}: ${reason}`);
  return { blacklisted: true, mint, symbol, reason };
}

/**
 * Tool handler: remove_from_blacklist
 */
export async function removeFromBlacklist(telegramId, { mint }) {
  if (!mint) return { error: "mint required" };

  const entry = await prisma.tokenBlacklistEntry.findUnique({
    where: { telegramId_mint: { telegramId, mint } },
  });
  if (!entry) return { error: `Mint ${mint} not found on blacklist` };

  await prisma.tokenBlacklistEntry.delete({ where: { telegramId_mint: { telegramId, mint } } });
  log("blacklist", `[${telegramId}] Removed ${entry.symbol || mint} from blacklist`);
  return { removed: true, mint, was: entry };
}

/**
 * Tool handler: list_blacklist
 */
export async function listBlacklist(telegramId) {
  const entries = await prisma.tokenBlacklistEntry.findMany({ where: { telegramId }, orderBy: { addedAt: "desc" } });
  return {
    count: entries.length,
    blacklist: entries.map((e) => ({ mint: e.mint, symbol: e.symbol, reason: e.reason, added_at: e.addedAt.toISOString(), added_by: e.addedBy })),
  };
}

