import { ensureUser, getUserConfig, updateUserConfigSection, getUserSecrets, updateUserSecrets, getWalletKeypair, exportWalletPrivateKey, computeDeployAmount } from "../user-config-service.js";
import { prisma } from "../db/client.js";

const tgId = "test_" + Date.now();
const user = await ensureUser(tgId, { username: "tester", firstName: "Test" });
console.log("user created:", user.telegramId, user.agentEnabled, user.dryRun);

let cfg = await getUserConfig(tgId);
console.log("default maxPositions:", cfg.risk.maxPositions, "strategy bins:", cfg.strategy);

await updateUserConfigSection(tgId, "management", { takeProfitPct: 12.5 });
cfg = await getUserConfig(tgId);
console.log("after patch takeProfitPct:", cfg.management.takeProfitPct, "stopLossPct still default:", cfg.management.stopLossPct);

console.log("deploy amount for 2 SOL wallet:", computeDeployAmount(cfg, 2.0));

let secrets = await getUserSecrets(tgId);
console.log("rpcUrl (default public RPC):", secrets.rpcUrl, "pnlRpcUrl (default PnL RPC):", secrets.pnlRpcUrl, "gmgnApiKey (should be null):", secrets.gmgnApiKey);

await updateUserSecrets(tgId, { heliusApiKey: "SECRETXYZ" });
secrets = await getUserSecrets(tgId);
console.log("rpcUrl after Helius key set:", secrets.rpcUrl);
console.log("pnlRpcUrl after Helius key set:", secrets.pnlRpcUrl);

const kp = await getWalletKeypair(tgId);
console.log("keypair pubkey:", kp.publicKey.toBase58());

const exported = await exportWalletPrivateKey(tgId);
console.log("exported matches wallet pubkey:", exported.publicKey === kp.publicKey.toBase58());

await prisma.user.delete({ where: { telegramId: tgId } });
console.log("cleanup ok");
await prisma.$disconnect();
