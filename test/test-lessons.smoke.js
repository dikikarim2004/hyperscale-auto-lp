import { recordPerformance, addLesson, pinLesson, unpinLesson, listLessons, getLessonsForPrompt, getPerformanceHistory, getPerformanceSummary, evolveThresholds, removeLessonsByKeyword, clearAllLessons, clearPerformance } from "../lessons.js";
import { ensureUser, getUserConfig } from "../user-config-service.js";
import { prisma } from "../db/client.js";

const tgId = "test_lessons_" + Date.now();
await ensureUser(tgId);

async function closePosition(i, pnlPct) {
  await recordPerformance(tgId, {
    position: `Pos${i}`, pool: `Pool${i}`, pool_name: `T${i}/SOL`, strategy: "bid_ask",
    bin_range: 40, bin_step: 100, volatility: 2, fee_tvl_ratio: 0.3, organic_score: 85,
    amount_sol: 1, fees_earned_usd: pnlPct > 0 ? 4 : 0.1, final_value_usd: 100 + pnlPct,
    initial_value_usd: 100, minutes_in_range: pnlPct > 0 ? 90 : 10, minutes_held: 100,
    close_reason: pnlPct > 0 ? "take profit" : "stop loss",
  });
}

// 5 closes: 3 winners, 2 losers -> should trigger evolveThresholds + darwin recalc path
for (let i = 1; i <= 5; i++) {
  await closePosition(i, i <= 3 ? 15 : -8);
}

const summary = await getPerformanceSummary(tgId);
console.log("performance summary:", summary);

const history = await getPerformanceHistory(tgId, { hours: 24, limit: 10 });
console.log("history count:", history.count, "win_rate_pct:", history.win_rate_pct);

const lessonsPrompt = await getLessonsForPrompt(tgId, { agentType: "GENERAL" });
console.log("lessons prompt (first 200 chars):", lessonsPrompt?.slice(0, 200));

await addLesson(tgId, "Manual test lesson about oor pools", ["oor"], { pinned: true });
const listed = await listLessons(tgId, { pinned: true });
console.log("pinned lessons:", listed.total, listed.lessons.map(l => l.rule));

const firstPinnedId = listed.lessons[0]?.id;
if (firstPinnedId) {
  const unpinned = await unpinLesson(tgId, firstPinnedId);
  console.log("unpinned:", unpinned.found, unpinned.pinned);
}

const removedCount = await removeLessonsByKeyword(tgId, "oor pools");
console.log("removed by keyword:", removedCount);

const cfg = await getUserConfig(tgId);
console.log("screening minOrganic/minFeeActiveTvlRatio after evolve (may or may not change):", cfg.screening.minOrganic, cfg.screening.minFeeActiveTvlRatio);

const clearedLessons = await clearAllLessons(tgId);
const clearedPerf = await clearPerformance(tgId);
console.log("cleared lessons:", clearedLessons, "cleared perf:", clearedPerf);

await prisma.user.delete({ where: { telegramId: tgId } });
console.log("cleanup ok");
await prisma.$disconnect();
