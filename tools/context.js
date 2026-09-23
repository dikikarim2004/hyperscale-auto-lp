/**
 * Per-user execution context — built once per request/cycle and passed into
 * every tools/* function. Bundles this telegramId's resolved config, secrets,
 * decrypted wallet Keypair, and a cached Solana Connection so tools never
 * touch global config.js / process.env for anything user-specific.
 */

import { Connection } from "@solana/web3.js";
import { getUser, getUserConfig, getUserSecrets, getWalletKeypair } from "../user-config-service.js";
import { log } from "../logger.js";

export async function buildUserContext(telegramId) {
  const id = String(telegramId);
  const [user, config, secrets] = await Promise.all([
    getUser(id),
    getUserConfig(id),
    getUserSecrets(id),
  ]);
  if (!user) throw new Error(`User ${id} is not registered`);

  let wallet = null;
  try {
    wallet = await getWalletKeypair(id);
  } catch (error) {
    log("context_warn", `[${id}] Wallet unavailable: ${error.message}`);
  }

  return {
    telegramId: id,
    user,
    dryRun: !!user.dryRun,
    config,
    secrets,
    wallet,
    _connection: null,
  };
}

/** Lazily create (and cache on the context) this user's RPC Connection. */
export function getConnection(ctx) {
  if (ctx._connection) return ctx._connection;
  if (!ctx.secrets?.rpcUrl) throw new Error("RPC_URL not configured — set it via /config in the bot");
  ctx._connection = new Connection(ctx.secrets.rpcUrl, "confirmed");
  return ctx._connection;
}

/** Throws a clear, user-facing error if the wallet isn't set up yet. */
export function requireWallet(ctx) {
  if (!ctx.wallet) throw new Error("Wallet not available for this user");
  return ctx.wallet;
}
