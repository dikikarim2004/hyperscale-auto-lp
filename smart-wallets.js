import { prisma } from "./db/client.js";
import { log } from "./logger.js";
import { getUserConfig, getUserSecrets } from "./user-config-service.js";

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function addSmartWallet(telegramId, { name, address, category = "alpha", type = "lp" }) {
  if (!SOLANA_PUBKEY_RE.test(address)) {
    return { success: false, error: "Invalid Solana address format" };
  }
  const existing = await prisma.smartWallet.findUnique({ where: { telegramId_address: { telegramId, address } } });
  if (existing) {
    return { success: false, error: `Already tracked as "${existing.name}"` };
  }
  await prisma.smartWallet.create({ data: { telegramId, name, address, category, type } });
  log("smart_wallets", `[${telegramId}] Added wallet: ${name} (${category}, type=${type})`);
  return { success: true, wallet: { name, address, category, type } };
}

export async function removeSmartWallet(telegramId, { address }) {
  const wallet = await prisma.smartWallet.findUnique({ where: { telegramId_address: { telegramId, address } } });
  if (!wallet) return { success: false, error: "Wallet not found" };
  await prisma.smartWallet.delete({ where: { telegramId_address: { telegramId, address } } });
  log("smart_wallets", `[${telegramId}] Removed wallet: ${wallet.name}`);
  return { success: true, removed: wallet.name };
}

export async function listSmartWallets(telegramId) {
  const wallets = await prisma.smartWallet.findMany({ where: { telegramId }, orderBy: { addedAt: "desc" } });
  return { total: wallets.length, wallets };
}

// Cache wallet positions for 5 minutes to avoid hammering RPC
const _cache = new Map(); // address -> { positions, fetchedAt }
const CACHE_TTL = 5 * 60 * 1000;

export async function checkSmartWalletsOnPool(telegramId, { pool_address, base_mint }) {
  const allWallets = await prisma.smartWallet.findMany({ where: { telegramId } });
  // Only check LP-type wallets — holder wallets don't have positions
  const wallets = allWallets.filter((w) => !w.type || w.type === "lp");

  let inPool = [];
  if (wallets.length > 0) {
    const { getWalletPositions } = await import("./tools/dlmm.js");
    const roCtx = { telegramId, config: await getUserConfig(telegramId), secrets: await getUserSecrets(telegramId) };

    const results = await Promise.all(
      wallets.map(async (wallet) => {
        try {
          const cached = _cache.get(wallet.address);
          if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
            return { wallet, positions: cached.positions };
          }
          const { positions } = await getWalletPositions(roCtx, { wallet_address: wallet.address });
          _cache.set(wallet.address, { positions: positions || [], fetchedAt: Date.now() });
          return { wallet, positions: positions || [] };
        } catch {
          return { wallet, positions: [] };
        }
      })
    );

    inPool = results
      .filter((r) => r.positions.some((p) => p.pool === pool_address))
      .map((r) => ({ name: r.wallet.name, category: r.wallet.category, address: r.wallet.address }));
  }

  // Auto-fill from GMGN smart money for this token — no manual tracking required.
  let gmgnWallets = [];
  if (base_mint) {
    try {
      const { getGmgnSmartMoneyWallets, hasGmgnApiKey } = await import("./tools/gmgn.js");
      const gmgnCtx = { config: await getUserConfig(telegramId), secrets: await getUserSecrets(telegramId) };
      if (hasGmgnApiKey(gmgnCtx)) {
        const gmgnResult = await getGmgnSmartMoneyWallets(gmgnCtx, base_mint).catch(() => null);
        if (gmgnResult?.available) {
          gmgnWallets = gmgnResult.wallets.map((w) => ({
            name: `gmgn:${w.address.slice(0, 6)}`,
            category: "gmgn_smart_degen",
            address: w.address,
            net_buy_usd: w.netBuyUsd,
            net_sell_usd: w.netSellUsd,
          }));
        }
      }
    } catch {
      // GMGN unavailable — fall back silently to the manually tracked list only
    }
  }

  const combined = [...inPool, ...gmgnWallets];
  const totalTracked = wallets.length + gmgnWallets.length;

  if (totalTracked === 0) {
    return {
      pool: pool_address,
      tracked_wallets: 0,
      in_pool: [],
      confidence_boost: false,
      signal: "No smart wallets tracked yet — neutral signal",
    };
  }

  return {
    pool: pool_address,
    tracked_wallets: totalTracked,
    in_pool: combined,
    confidence_boost: combined.length > 0,
    signal: combined.length > 0
      ? `${combined.length}/${totalTracked} smart wallet(s) detected on this pool: ${combined.map((w) => w.name).join(", ")} — STRONG signal`
      : `0/${totalTracked} smart wallets in this pool — neutral, rely on fundamentals`,
  };
}

