/**
 * Strategy Library — persistent store of LP strategies.
 *
 * Users paste a tweet or description via Telegram.
 * The agent extracts structured criteria and saves it here.
 * During screening, the active strategy's criteria guide token selection and position config.
 */

import { prisma } from "./db/client.js";
import { log } from "./logger.js";

// ─── Default Strategies ─────────────────────────────────────────
const DEFAULT_STRATEGIES = {
  custom_ratio_spot: {
    id: "custom_ratio_spot",
    name: "Custom Ratio Spot",
    author: "meridian",
    lp_strategy: "spot",
    token_criteria: { notes: "Any token. Ratio expresses directional bias." },
    entry: { condition: "Directional view on token", single_side: null, notes: "75% token = bullish (sell on pump out of range). 75% SOL = bearish/DCA-in (buy on dip). Set bins_below:bins_above proportional to ratio." },
    range: { type: "custom", notes: "bins_below:bins_above ratio matches token:SOL ratio. E.g., 75% token → ~52 bins below, ~17 bins above." },
    exit: { take_profit_pct: 10, notes: "Close when OOR or TP hit. Re-deploy with updated ratio based on new momentum signals." },
    best_for: "Expressing directional bias while earning fees both ways",
  },
  single_sided_reseed: {
    id: "single_sided_reseed",
    name: "Single-Sided Bid-Ask + Re-seed",
    author: "meridian",
    lp_strategy: "bid_ask",
    token_criteria: { notes: "Volatile tokens with strong narrative. Must have active volume." },
    entry: { condition: "Deploy token-only (amount_x only, amount_y=0) bid-ask, bins below active bin only", single_side: "token", notes: "As price drops through bins, token sold for SOL. Bid-ask concentrates at bottom edge." },
    range: { type: "default", bins_below_pct: 100, notes: "All bins below active bin. bins_above=0." },
    exit: { notes: "When OOR downside: close_position(skip_swap=true) → redeploy token-only bid-ask at new lower price. Do NOT swap to SOL. Full close only when token dead or after N re-seeds with declining performance." },
    best_for: "Riding volatile tokens down without cutting losses. DCA out via LP.",
  },
  fee_compounding: {
    id: "fee_compounding",
    name: "Fee Compounding",
    author: "meridian",
    lp_strategy: "any",
    token_criteria: { notes: "Stable volume pools with consistent fee generation." },
    entry: { condition: "Deploy normally with any shape", notes: "Strategy is about management, not entry shape." },
    range: { type: "default", notes: "Standard range for the pair." },
    exit: { notes: "When unclaimed fees > $5 AND in range: claim_fees → add_liquidity back into same position. Normal close rules otherwise." },
    best_for: "Maximizing yield on stable, range-bound pools via compounding",
  },
  multi_layer: {
    id: "multi_layer",
    name: "Multi-Layer",
    author: "meridian",
    lp_strategy: "mixed",
    token_criteria: { notes: "High volume pools. Layer multiple shapes into ONE position via addLiquidityByStrategy to sculpt a composite distribution." },
    entry: {
      condition: "Create ONE position, then layer additional shapes onto it with add-liquidity. Each layer adds a different strategy/shape to the same position, compositing them.",
      notes: "Step 1: deploy (creates position with first shape). Step 2+: add-liquidity to same position with different shapes. All layers share the same bin range but different distribution curves stack on top of each other.",
      example_patterns: {
        smooth_edge: "Deploy Bid-Ask (edges) → add-liquidity Spot (fills the middle gap). 2 layers, 1 position.",
        full_composite: "Deploy Bid-Ask (edges) → add-liquidity Spot (middle) → add-liquidity Curve (center boost). 3 layers, 1 position.",
        edge_heavy: "Deploy Bid-Ask → add-liquidity Bid-Ask again (double edge weight). 2 layers, 1 position.",
      },
    },
    range: { type: "custom", notes: "All layers share the position's bin range (set at deploy). Choose range wide enough for the widest layer needed." },
    exit: { notes: "Single position — one close, one claim. The composite shape means fees earned reflect ALL layers combined." },
    best_for: "Creating custom liquidity distributions by stacking shapes in one position. Single position to manage.",
  },
  partial_harvest: {
    id: "partial_harvest",
    name: "Partial Harvest",
    author: "meridian",
    lp_strategy: "any",
    token_criteria: { notes: "High fee pools where taking profit incrementally is preferred." },
    entry: { condition: "Deploy normally", notes: "Strategy is about progressive profit-taking, not entry." },
    range: { type: "default", notes: "Standard range." },
    exit: { take_profit_pct: 10, notes: "When total return >= 10% of deployed capital: withdraw_liquidity(bps=5000) to take 50% off. Remaining 50% keeps running. Repeat at next threshold." },
    best_for: "Locking in profits without fully exiting winning positions",
  },
};

/** Preload the default strategy set for a newly-registered user. Idempotent. */
export async function ensureDefaultStrategies(telegramId) {
  const existingCount = await prisma.strategy.count({ where: { telegramId } });
  if (existingCount > 0) return;

  await prisma.$transaction(
    Object.values(DEFAULT_STRATEGIES).map((s, i) => prisma.strategy.create({
      data: {
        telegramId,
        strategyKey: s.id,
        name: s.name,
        author: s.author,
        lpStrategy: s.lp_strategy,
        tokenCriteria: s.token_criteria,
        entry: s.entry,
        range: s.range,
        exit: s.exit,
        bestFor: s.best_for,
        isActive: i === 0, // custom_ratio_spot is first -> default active
      },
    })),
  );
  log("strategy", `[${telegramId}] Preloaded default strategies`);
}

function toApiShape(row) {
  return {
    id: row.strategyKey,
    name: row.name,
    author: row.author,
    lp_strategy: row.lpStrategy,
    token_criteria: row.tokenCriteria,
    entry: row.entry,
    range: row.range,
    exit: row.exit,
    best_for: row.bestFor,
    raw: row.raw,
    added_at: row.addedAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// ─── Tool Handlers ─────────────────────────────────────────────

/**
 * Add or update a strategy.
 * The agent parses the raw tweet/text and fills in the structured fields.
 */
export async function addStrategy(telegramId, {
  id,
  name,
  author = "unknown",
  lp_strategy = "bid_ask",       // "bid_ask" | "spot" | "curve"
  token_criteria = {},           // { min_mcap, min_age_days, requires_kol, notes }
  entry = {},                    // { condition, price_change_threshold_pct, single_side }
  range = {},                    // { type, bins_below_pct, notes }
  exit = {},                     // { take_profit_pct, notes }
  best_for = "",                 // short description of ideal conditions
  raw = "",                      // original tweet/text
}) {
  if (!id || !name) return { error: "id and name are required" };

  const slug = id.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  const existingActive = await prisma.strategy.findFirst({ where: { telegramId, isActive: true } });

  await prisma.strategy.upsert({
    where: { telegramId_strategyKey: { telegramId, strategyKey: slug } },
    update: { name, author, lpStrategy: lp_strategy, tokenCriteria: token_criteria, entry, range, exit, bestFor: best_for, raw },
    create: {
      telegramId, strategyKey: slug, name, author, lpStrategy: lp_strategy,
      tokenCriteria: token_criteria, entry, range, exit, bestFor: best_for, raw,
      isActive: !existingActive, // auto-activate the user's very first strategy
    },
  });

  log("strategy", `[${telegramId}] Strategy saved: ${name} (${slug})`);
  return { saved: true, id: slug, name, active: !existingActive || existingActive.strategyKey === slug };
}

/**
 * List all strategies with a summary.
 */
export async function listStrategies(telegramId) {
  await ensureDefaultStrategies(telegramId);
  const rows = await prisma.strategy.findMany({ where: { telegramId }, orderBy: { addedAt: "asc" } });
  const active = rows.find((s) => s.isActive)?.strategyKey || null;
  const strategies = rows.map((s) => ({
    id: s.strategyKey,
    name: s.name,
    author: s.author,
    lp_strategy: s.lpStrategy,
    best_for: s.bestFor,
    active: s.isActive,
    added_at: s.addedAt.toISOString().slice(0, 10),
  }));
  return { active, count: strategies.length, strategies };
}

/**
 * Get full details of a strategy including raw text and all criteria.
 */
export async function getStrategy(telegramId, { id }) {
  if (!id) return { error: "id required" };
  const row = await prisma.strategy.findUnique({ where: { telegramId_strategyKey: { telegramId, strategyKey: id } } });
  if (!row) {
    const all = await prisma.strategy.findMany({ where: { telegramId }, select: { strategyKey: true } });
    return { error: `Strategy "${id}" not found`, available: all.map((s) => s.strategyKey) };
  }
  return { ...toApiShape(row), is_active: row.isActive };
}

/**
 * Set the active strategy used during screening cycles.
 */
export async function setActiveStrategy(telegramId, { id }) {
  if (!id) return { error: "id required" };
  const row = await prisma.strategy.findUnique({ where: { telegramId_strategyKey: { telegramId, strategyKey: id } } });
  if (!row) {
    const all = await prisma.strategy.findMany({ where: { telegramId }, select: { strategyKey: true } });
    return { error: `Strategy "${id}" not found`, available: all.map((s) => s.strategyKey) };
  }
  await prisma.$transaction([
    prisma.strategy.updateMany({ where: { telegramId }, data: { isActive: false } }),
    prisma.strategy.update({ where: { telegramId_strategyKey: { telegramId, strategyKey: id } }, data: { isActive: true } }),
  ]);
  log("strategy", `[${telegramId}] Active strategy set to: ${row.name}`);
  return { active: id, name: row.name };
}

/**
 * Remove a strategy.
 */
export async function removeStrategy(telegramId, { id }) {
  if (!id) return { error: "id required" };
  const row = await prisma.strategy.findUnique({ where: { telegramId_strategyKey: { telegramId, strategyKey: id } } });
  if (!row) return { error: `Strategy "${id}" not found` };

  await prisma.strategy.delete({ where: { telegramId_strategyKey: { telegramId, strategyKey: id } } });

  let newActive = null;
  if (row.isActive) {
    const next = await prisma.strategy.findFirst({ where: { telegramId }, orderBy: { addedAt: "asc" } });
    if (next) {
      await prisma.strategy.update({ where: { telegramId_strategyKey: { telegramId, strategyKey: next.strategyKey } }, data: { isActive: true } });
      newActive = next.strategyKey;
    }
  }

  log("strategy", `[${telegramId}] Strategy removed: ${row.name}`);
  return { removed: true, id, name: row.name, new_active: newActive };
}

/**
 * Get the currently active strategy — used by screening cycle.
 */
export async function getActiveStrategy(telegramId) {
  const row = await prisma.strategy.findFirst({ where: { telegramId, isActive: true } });
  return row ? toApiShape(row) : null;
}

