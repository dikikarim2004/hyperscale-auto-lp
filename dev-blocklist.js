/**
 * Dev (deployer) blocklist — deployer wallet addresses a user's agent should
 * never deploy into. Per-user (telegramId-scoped), persisted via Prisma.
 *
 * Agent/user can add deployers via Telegram ("block this deployer").
 * Screening hard-filters any pool whose base token was deployed by a blocked wallet
 * before the pool list reaches the LLM.
 */

import { prisma } from "./db/client.js";
import { log } from "./logger.js";

export async function isDevBlocked(telegramId, devWallet) {
  if (!devWallet) return false;
  const entry = await prisma.devBlocklistEntry.findUnique({
    where: { telegramId_wallet: { telegramId, wallet: devWallet } },
  });
  return !!entry;
}

export async function getBlockedDevs(telegramId) {
  const entries = await prisma.devBlocklistEntry.findMany({ where: { telegramId } });
  return Object.fromEntries(entries.map((e) => [e.wallet, { label: e.label, reason: e.reason, added_at: e.addedAt.toISOString() }]));
}

export async function blockDev(telegramId, { wallet, reason, label }) {
  if (!wallet) return { error: "wallet required" };
  const existing = await prisma.devBlocklistEntry.findUnique({
    where: { telegramId_wallet: { telegramId, wallet } },
  });
  if (existing) return { already_blocked: true, wallet, label: existing.label, reason: existing.reason };

  await prisma.devBlocklistEntry.create({
    data: { telegramId, wallet, label: label || "unknown", reason: reason || "no reason provided" },
  });
  log("dev_blocklist", `[${telegramId}] Blocked deployer ${label || wallet}: ${reason}`);
  return { blocked: true, wallet, label, reason };
}

export async function unblockDev(telegramId, { wallet }) {
  if (!wallet) return { error: "wallet required" };
  const entry = await prisma.devBlocklistEntry.findUnique({
    where: { telegramId_wallet: { telegramId, wallet } },
  });
  if (!entry) return { error: `Wallet ${wallet} not on dev blocklist` };

  await prisma.devBlocklistEntry.delete({ where: { telegramId_wallet: { telegramId, wallet } } });
  log("dev_blocklist", `[${telegramId}] Removed deployer ${entry.label || wallet} from blocklist`);
  return { unblocked: true, wallet, was: entry };
}

export async function listBlockedDevs(telegramId) {
  const entries = await prisma.devBlocklistEntry.findMany({ where: { telegramId }, orderBy: { addedAt: "desc" } });
  return {
    count: entries.length,
    blocked_devs: entries.map((e) => ({ wallet: e.wallet, label: e.label, reason: e.reason, added_at: e.addedAt.toISOString() })),
  };
}

