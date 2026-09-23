import {
  trackPosition, markOutOfRange, markInRange, minutesOutOfRange, recordClaim, recordClose,
  setPositionInstruction, confirmPeak, registerExitSignal, getTrackedPositions, getTrackedPosition,
  getStateSummary, updatePnlAndCheckExits, getLastBriefingDate, setLastBriefingDate, syncOpenPositions,
} from "../state.js";
import { ensureUser, getUserConfig } from "../user-config-service.js";
import { prisma } from "../db/client.js";

const tgId = "test_state_" + Date.now();
await ensureUser(tgId);
const cfg = await getUserConfig(tgId);

const posAddr = "Pos" + Date.now();
await trackPosition(tgId, {
  position: posAddr, pool: "PoolX", pool_name: "X/SOL", strategy: "bid_ask",
  amount_sol: 1, active_bin: 100, bin_step: 100, volatility: 1, fee_tvl_ratio: 0.1,
  organic_score: 80, initial_value_usd: 100,
});

let pos = await getTrackedPosition(tgId, posAddr);
console.log("tracked position exists:", !!pos, "closed:", pos.closed);

await markOutOfRange(tgId, posAddr);
console.log("minutes OOR (should be ~0):", await minutesOutOfRange(tgId, posAddr));
await markInRange(tgId, posAddr);

// peak confirmation: needs 2 confirming ticks
console.log("confirmPeak tick1 (expect false):", await confirmPeak(tgId, posAddr, 5, 2));
console.log("confirmPeak tick2 same value (expect true):", await confirmPeak(tgId, posAddr, 5, 2));

// exit signal confirmation
console.log("registerExitSignal tick1 (expect fire=false):", (await registerExitSignal(tgId, posAddr, "STOP_LOSS", 2)).fire);
console.log("registerExitSignal tick2 (expect fire=true):", (await registerExitSignal(tgId, posAddr, "STOP_LOSS", 2)).fire);

await setPositionInstruction(tgId, posAddr, "hold until 10% profit");
pos = await getTrackedPosition(tgId, posAddr);
console.log("instruction set:", pos.instruction);

const exit = await updatePnlAndCheckExits(tgId, posAddr, { pnl_pct: -10, in_range: true }, cfg.management);
console.log("exit check (stopLossPct default -5, pnl -10 -> expect STOP_LOSS):", exit?.action);

await recordClaim(tgId, posAddr, 3.5);
await recordClose(tgId, posAddr, "manual close test");
pos = await getTrackedPosition(tgId, posAddr);
console.log("closed:", pos.closed, "notes:", pos.notes);

const summary = await getStateSummary(tgId);
console.log("summary open/closed:", summary.open_positions, summary.closed_positions, "recent_events:", summary.recent_events.map(e => e.action));

console.log("last briefing date (expect null):", await getLastBriefingDate(tgId));
await setLastBriefingDate(tgId);
console.log("last briefing date after set:", await getLastBriefingDate(tgId));

// syncOpenPositions: re-open position artificially then sync with empty active list -> should stay open due to grace period? Position closedAt was already true, so skip test on closed one.
const posAddr2 = "Pos2_" + Date.now();
await trackPosition(tgId, { position: posAddr2, pool: "PoolY", pool_name: "Y/SOL", strategy: "spot", amount_sol: 1 });
await prisma.position.update({ where: { telegramId_positionAddress: { telegramId: tgId, positionAddress: posAddr2 } }, data: { deployedAt: new Date(Date.now() - 20 * 60_000) } });
await syncOpenPositions(tgId, []); // not in active list, deployed 20 min ago -> should auto-close
const pos2 = await getTrackedPosition(tgId, posAddr2);
console.log("pos2 auto-closed by sync (expect true):", pos2.closed);

await prisma.user.delete({ where: { telegramId: tgId } });
console.log("cleanup ok");
await prisma.$disconnect();
