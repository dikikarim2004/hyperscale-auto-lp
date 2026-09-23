import { prisma } from "./db/client.js";
import { getPerformanceSummary } from "./lessons.js";

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function generateBriefing(telegramId) {
  const id = String(telegramId);
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [openedLast24h, closedLast24h, perfLast24h, lessonsLast24h, openPositions, perfSummary] = await Promise.all([
    prisma.position.count({ where: { telegramId: id, deployedAt: { gt: last24h } } }),
    prisma.position.count({ where: { telegramId: id, closed: true, closedAt: { gt: last24h } } }),
    prisma.performanceRecord.findMany({ where: { telegramId: id, recordedAt: { gt: last24h } } }),
    prisma.lesson.findMany({ where: { telegramId: id, createdAt: { gt: last24h } } }),
    prisma.position.count({ where: { telegramId: id, closed: false } }),
    getPerformanceSummary(id),
  ]);

  const totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnlUsd || 0), 0);
  const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.feesEarnedUsd || 0), 0);

  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${openedLast24h}`,
    `📤 Positions Closed: ${closedLast24h}`,
    "",
    `<b>Performance:</b>`,
    `💰 Net PnL: ${totalPnLUsd >= 0 ? "+" : ""}$${totalPnLUsd.toFixed(2)}`,
    `💎 Fees Earned: $${totalFeesUsd.toFixed(2)}`,
    perfLast24h.length > 0
      ? `📈 Win Rate (24h): ${Math.round((perfLast24h.filter(p => p.pnlUsd > 0).length / perfLast24h.length) * 100)}%`
      : "📈 Win Rate (24h): N/A",
    "",
    `<b>Lessons Learned:</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${escapeHtml(l.rule)}`).join("\n")
      : "• No new lessons recorded overnight.",
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions}`,
    perfSummary
      ? `📊 All-time PnL: $${perfSummary.total_pnl_usd.toFixed(2)} (${perfSummary.win_rate_pct}% win)`
      : "",
    "────────────────"
  ];

  return lines.join("\n");
}
