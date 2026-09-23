import { prisma } from "./db/client.js";

const MAX_DECISIONS = 100;

function sanitize(value, maxLen = 280) {
  if (value == null) return null;
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLen) || null;
}

export async function appendDecision(telegramId, entry) {
  const decision = {
    telegramId,
    type: entry.type || "note",
    actor: entry.actor || "GENERAL",
    pool: entry.pool || null,
    poolName: sanitize(entry.pool_name || entry.pool, 120),
    position: entry.position || null,
    summary: sanitize(entry.summary),
    reason: sanitize(entry.reason, 500),
    risks: Array.isArray(entry.risks) ? entry.risks.map((r) => sanitize(r, 140)).filter(Boolean).slice(0, 6) : [],
    metrics: entry.metrics || {},
    rejected: Array.isArray(entry.rejected) ? entry.rejected.map((r) => sanitize(r, 180)).filter(Boolean).slice(0, 8) : [],
  };
  const created = await prisma.decisionLog.create({ data: decision });

  // Prune oldest rows beyond MAX_DECISIONS for this user.
  const count = await prisma.decisionLog.count({ where: { telegramId } });
  if (count > MAX_DECISIONS) {
    const stale = await prisma.decisionLog.findMany({
      where: { telegramId },
      orderBy: { ts: "asc" },
      take: count - MAX_DECISIONS,
      select: { id: true },
    });
    await prisma.decisionLog.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  }

  return { id: created.id, ts: created.ts.toISOString(), ...decision };
}

export async function getRecentDecisions(telegramId, limit = 10) {
  const rows = await prisma.decisionLog.findMany({
    where: { telegramId },
    orderBy: { ts: "desc" },
    take: limit,
  });
  return rows.map((d) => ({
    id: d.id,
    ts: d.ts.toISOString(),
    type: d.type,
    actor: d.actor,
    pool: d.pool,
    pool_name: d.poolName,
    position: d.position,
    summary: d.summary,
    reason: d.reason,
    risks: d.risks,
    metrics: d.metrics,
    rejected: d.rejected,
  }));
}

export async function getDecisionSummary(telegramId, limit = 6) {
  const decisions = await getRecentDecisions(telegramId, limit);
  if (!decisions.length) return "No recent structured decisions yet.";
  return decisions.map((d, i) => {
    const bits = [
      `${i + 1}. [${d.actor}] ${d.type.toUpperCase()} ${d.pool_name || d.pool || "unknown pool"}`,
      d.summary ? `summary: ${d.summary}` : null,
      d.reason ? `reason: ${d.reason}` : null,
      d.risks?.length ? `risks: ${d.risks.join(", ")}` : null,
      d.rejected?.length ? `rejected: ${d.rejected.join(" | ")}` : null,
    ].filter(Boolean);
    return bits.join(" | ");
  }).join("\n");
}

