import { recordPoolDeploy, isPoolOnCooldown, isBaseMintOnCooldown, getPoolMemory, recordPositionSnapshot, recallForPool, addPoolNote } from "../pool-memory.js";
import { ensureUser, getUserConfig } from "../user-config-service.js";
import { prisma } from "../db/client.js";

const tgId = "test_pm_" + Date.now();
await ensureUser(tgId);
const cfg = await getUserConfig(tgId);

const pool = "PoolAddr" + Date.now();
await recordPoolDeploy(tgId, pool, {
  pool_name: "TEST/SOL", base_mint: "Mint123", deployed_at: new Date().toISOString(),
  closed_at: new Date().toISOString(), pnl_pct: 12.5, pnl_usd: 5, close_reason: "take profit", strategy: "bid_ask",
}, cfg);

const mem = await getPoolMemory(tgId, { pool_address: pool });
console.log("pool memory known:", mem.known, "total_deploys:", mem.total_deploys, "avg_pnl:", mem.avg_pnl_pct);

await recordPositionSnapshot(tgId, pool, { position: "posAddr", pnl_pct: 3, in_range: true, age_minutes: 5 });
await recordPositionSnapshot(tgId, pool, { position: "posAddr", pnl_pct: 5, in_range: true, age_minutes: 10 });
const recall = await recallForPool(tgId, pool);
console.log("recall:\n" + recall);

await addPoolNote(tgId, { pool_address: pool, note: "  test note  \n" });
const memAfterNote = await getPoolMemory(tgId, { pool_address: pool });
console.log("notes:", memAfterNote.notes);

console.log("pool on cooldown (expect false):", await isPoolOnCooldown(tgId, pool));
console.log("base mint on cooldown (expect false):", await isBaseMintOnCooldown(tgId, "Mint123"));

await prisma.user.delete({ where: { telegramId: tgId } });
console.log("cleanup ok");
await prisma.$disconnect();
