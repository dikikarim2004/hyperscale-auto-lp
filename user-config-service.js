/**
 * Per-user configuration & wallet service — the multi-tenant replacement for
 * the old singleton config.js (user-config.json) and tools/wallet.js keypair
 * loading. Every function is keyed by `telegramId` (string).
 */

import { prisma } from "./db/client.js";
import {
  generateWallet,
  importWallet,
  encryptWalletSecretKey,
  decryptWalletSecretKey,
  decryptWalletKeypair,
  encryptUserSecret,
  decryptUserSecret,
} from "./crypto/wallet-vault.js";
import {
  DEFAULT_CONFIG_SECTIONS,
  DEFAULT_SECRET_DEFAULTS,
  CONFIG_SECTION_KEYS,
  MIN_SAFE_BINS_BELOW,
} from "./config-defaults.js";
import { ensureDefaultStrategies } from "./strategy-library.js";

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** Deep-merge `override` onto `base`. Arrays and primitives are replaced, not merged. */
function mergeDeep(base, override) {
  if (!isPlainObject(base)) return override ?? base;
  if (!isPlainObject(override)) return base;
  const result = { ...base };
  for (const key of Object.keys(override)) {
    result[key] = isPlainObject(base[key]) && isPlainObject(override[key])
      ? mergeDeep(base[key], override[key])
      : override[key];
  }
  return result;
}

function clampStrategyBins(strategy) {
  const min = Math.max(MIN_SAFE_BINS_BELOW, Math.round(Number(strategy.minBinsBelow) || MIN_SAFE_BINS_BELOW));
  const max = Math.max(min, Math.round(Number(strategy.maxBinsBelow) || min));
  const def = Math.max(min, Math.min(max, Math.round(Number(strategy.defaultBinsBelow) || max)));
  return { ...strategy, minBinsBelow: min, maxBinsBelow: max, defaultBinsBelow: def };
}

// ─── User lifecycle ────────────────────────────────────────────────────

/**
 * Register (or fetch) a Telegram user. Creates the wallet, default config,
 * secrets row, and auxiliary per-user tables on first contact.
 */
export async function ensureUser(telegramId, profile = {}) {
  const id = String(telegramId);
  const existing = await prisma.user.findUnique({ where: { telegramId: id } });
  if (existing) {
    return prisma.user.update({
      where: { telegramId: id },
      data: {
        telegramUsername: profile.username ?? existing.telegramUsername,
        firstName: profile.firstName ?? existing.firstName,
        lastName: profile.lastName ?? existing.lastName,
        languageCode: profile.languageCode ?? existing.languageCode,
      },
    });
  }

  const wallet = generateWallet();
  const encryptedPrivateKey = encryptWalletSecretKey(wallet.secretKeyBase58);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        telegramId: id,
        telegramUsername: profile.username ?? null,
        firstName: profile.firstName ?? null,
        lastName: profile.lastName ?? null,
        languageCode: profile.languageCode ?? null,
        onboardedAt: new Date(),
      },
    });
    await tx.wallet.create({
      data: { telegramId: id, publicKey: wallet.publicKey, encryptedPrivateKey, isActive: true },
    });
    await tx.userConfig.create({ data: { telegramId: id } });
    await tx.userSecret.create({ data: { telegramId: id } });
    await tx.signalWeight.create({ data: { telegramId: id, weights: {} } });
    await tx.hiveMindCache.create({ data: { telegramId: id } });
    await tx.briefingState.create({ data: { telegramId: id } });
    return created;
  });
  await ensureDefaultStrategies(id);
  return user;
}

export async function getUser(telegramId) {
  return prisma.user.findUnique({ where: { telegramId: String(telegramId) } });
}

export async function isRegistered(telegramId) {
  const user = await getUser(telegramId);
  return !!user;
}

export async function setAgentEnabled(telegramId, enabled) {
  return prisma.user.update({ where: { telegramId: String(telegramId) }, data: { agentEnabled: !!enabled } });
}

export async function setDryRun(telegramId, dryRun) {
  return prisma.user.update({ where: { telegramId: String(telegramId) }, data: { dryRun: !!dryRun } });
}

export async function listActiveUsers() {
  return prisma.user.findMany({ where: { agentEnabled: true, isBlocked: false } });
}

// ─── Config ──────────────────────────────────────────────────────────────

/** Full merged config object, shaped exactly like the old config.js `config` export. */
export async function getUserConfig(telegramId) {
  const id = String(telegramId);
  const row = await prisma.userConfig.findUnique({ where: { telegramId: id } });
  const stored = row || {};

  const merged = {};
  for (const key of CONFIG_SECTION_KEYS) {
    merged[key] = mergeDeep(DEFAULT_CONFIG_SECTIONS[key], stored[key] || {});
  }
  merged.strategy = clampStrategyBins(merged.strategy);
  merged.tokens = {
    SOL: "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  };
  return merged;
}

/** Merge a patch into one config section (e.g. "management") and persist. */
export async function updateUserConfigSection(telegramId, section, patch) {
  if (!CONFIG_SECTION_KEYS.includes(section)) {
    throw new Error(`Unknown config section: ${section}`);
  }
  const id = String(telegramId);
  const row = await prisma.userConfig.findUnique({ where: { telegramId: id } });
  const current = row?.[section] || {};
  const next = mergeDeep(current, patch);
  await prisma.userConfig.update({ where: { telegramId: id }, data: { [section]: next } });
  return next;
}

/**
 * Compute the optimal deploy amount for a wallet balance (per-user version of
 * config.js's computeDeployAmount).
 */
export function computeDeployAmount(userConfig, walletSol) {
  const reserve = userConfig.management.gasReserve ?? 0.2;
  const pct = userConfig.management.positionSizePct ?? 0.35;
  const floor = userConfig.management.deployAmountSol;
  const ceil = userConfig.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic = deployable * pct;
  const result = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

// ─── Secrets (API keys / RPC URLs) ─────────────────────────────────────
// NOTE: Jupiter apiKey/referralAccount/referralFeeBps are deliberately NOT
// here — those are app-operator revenue settings sourced from this server's
// .env (see app-config.js), never per-user.

const SECRET_FIELDS = [
  "rpcUrl", "pnlRpcUrl", "heliusApiKey", "llmBaseUrl", "llmApiKey", "openrouterApiKey",
  "gmgnApiKey", "lpAgentApiKey", "hiveMindApiKey", "publicApiKey",
];
// Plain (non-encrypted) fields stored as-is.
const PLAIN_SECRET_FIELDS = ["agentMeridianApiUrl"];

const HELIUS_RPC_URL = "https://mainnet.helius-rpc.com/";
const HELIUS_PNL_RPC_URL = "https://pump.helius-rpc.com/";

function buildHeliusRpcUrl(baseUrl, apiKey) {
  const url = new URL(baseUrl);
  url.searchParams.set("api-key", apiKey);
  return url.toString();
}

/** Decrypted secrets, with public shared defaults applied where the user hasn't set their own. */
export async function getUserSecrets(telegramId) {
  const id = String(telegramId);
  const row = await prisma.userSecret.findUnique({ where: { telegramId: id } });
  const out = {};
  for (const field of SECRET_FIELDS) {
    const encField = `${field}Enc`;
    const encrypted = row?.[encField];
    out[field] = encrypted ? decryptUserSecret(encrypted) : (DEFAULT_SECRET_DEFAULTS[field] ?? null);
  }
  for (const field of PLAIN_SECRET_FIELDS) {
    out[field] = row?.[field] ?? DEFAULT_SECRET_DEFAULTS[field] ?? null;
  }
  return out;
}

/** Encrypt + persist a partial set of secret fields (only the ones provided). */
export async function updateUserSecrets(telegramId, patch) {
  const id = String(telegramId);
  const data = {};
  const heliusApiKey = patch.heliusApiKey == null ? null : String(patch.heliusApiKey).trim();
  for (const field of SECRET_FIELDS) {
    if (patch[field] === undefined) continue;
    data[`${field}Enc`] = patch[field] === null ? null : encryptUserSecret(String(patch[field]));
  }
  for (const field of PLAIN_SECRET_FIELDS) {
    if (patch[field] === undefined) continue;
    data[field] = patch[field];
  }

  // Helius supplies both the main RPC and the dedicated Pump/PnL RPC. When a
  // user enters their key, keep both per-user URLs aligned with that key.
  if (heliusApiKey) {
    data.rpcUrlEnc = encryptUserSecret(buildHeliusRpcUrl(HELIUS_RPC_URL, heliusApiKey));
    data.pnlRpcUrlEnc = encryptUserSecret(buildHeliusRpcUrl(HELIUS_PNL_RPC_URL, heliusApiKey));
  }
  await prisma.userSecret.upsert({
    where: { telegramId: id },
    update: data,
    create: { telegramId: id, ...data },
  });
  return getUserSecrets(id);
}

// ─── Wallet ──────────────────────────────────────────────────────────────

export async function getWallet(telegramId) {
  return prisma.wallet.findFirst({
    where: { telegramId: String(telegramId), isActive: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function listWallets(telegramId) {
  return prisma.wallet.findMany({
    where: { telegramId: String(telegramId) },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    select: { id: true, publicKey: true, isActive: true, createdAt: true, lastExportedAt: true, exportCount: true },
  });
}

export async function importUserWallet(telegramId, secretKeyBase58) {
  const id = String(telegramId);
  const wallet = importWallet(secretKeyBase58);
  const existing = await prisma.wallet.findUnique({ where: { publicKey: wallet.publicKey } });
  if (existing) {
    if (existing.telegramId !== id) throw new Error("This wallet is already assigned to another user");
    return { ...existing, imported: false };
  }
  const active = await getWallet(id);
  const created = await prisma.$transaction(async (tx) => {
    if (!active) {
      await tx.wallet.updateMany({ where: { telegramId: id }, data: { isActive: false } });
    }
    return tx.wallet.create({
      data: {
        telegramId: id,
        publicKey: wallet.publicKey,
        encryptedPrivateKey: encryptWalletSecretKey(wallet.secretKeyBase58),
        isActive: !active,
      },
    });
  });
  return { id: created.id, publicKey: created.publicKey, isActive: created.isActive, imported: true };
}

export async function setActiveWallet(telegramId, walletId) {
  const id = String(telegramId);
  const target = await prisma.wallet.findFirst({ where: { id: String(walletId), telegramId: id } });
  if (!target) throw new Error("Wallet not found for this user");
  await prisma.$transaction([
    prisma.wallet.updateMany({ where: { telegramId: id }, data: { isActive: false } }),
    prisma.wallet.update({ where: { id: target.id }, data: { isActive: true } }),
  ]);
  return prisma.wallet.findUnique({ where: { id: target.id } });
}

/** Decrypt straight to a signing Keypair — used by trading tools, never logged. */
export async function getWalletKeypair(telegramId) {
  const wallet = await getWallet(telegramId);
  if (!wallet) throw new Error("Wallet not found for this user");
  return decryptWalletKeypair(wallet.encryptedPrivateKey);
}

/**
 * Export the plaintext private key. ONLY call this from the explicit
 * /exportkey Telegram flow after the user has typed the confirmation phrase —
 * never from any automated/background code path.
 */
export async function exportWalletPrivateKey(telegramId) {
  const id = String(telegramId);
  const wallet = await getWallet(id);
  if (!wallet) throw new Error("Wallet not found for this user");
  const secretKeyBase58 = decryptWalletSecretKey(wallet.encryptedPrivateKey);
  await prisma.wallet.update({
    where: { id: wallet.id },
    data: { lastExportedAt: new Date(), exportCount: { increment: 1 } },
  });
  return { publicKey: wallet.publicKey, secretKeyBase58 };
}
