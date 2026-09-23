import { log } from "../../logger.js";
import { getGmgnSmartMoneyFlow, getGmgnTokenIntel } from "../gmgn.js";

const holderSnapshot = new Map();

export async function evaluateOnChainEntrySignal(ctx, { mint } = {}) {
  const cfg = ctx.config.onChainIntelligence || {};
  if (!cfg.enabled || !mint) {
    return {
      enabled: false,
      passed: true,
      score_bonus: 0,
      reason: "onChainIntelligence disabled or mint missing",
    };
  }

  const intel = await getGmgnTokenIntel(ctx, mint);
  const smartMoney = await getGmgnSmartMoneyFlow(ctx, mint, {
    timeWindowMinutes: cfg.smartMoney?.timeWindowMinutes,
  });
  if (smartMoney?.available) {
    log(
      "onchain_intel",
      `entry ${String(mint).slice(0, 8)} net_buy=${smartMoney.netBuyUsd} net_sell=${smartMoney.netSellUsd} source=${smartMoney.source || "unknown"}`
    );
  } else {
    log("onchain_intel", `entry ${String(mint).slice(0, 8)} unavailable: ${smartMoney?.reason || "unknown"}`);
  }

  const reasons = [];
  let passed = true;
  let scoreBonus = 0;

  const top10 = Number(intel?.top10ConcentrationPct);
  const top50 = Number(intel?.top50ConcentrationPct);
  const devHoldings = Number(intel?.devHoldingsPct);
  const maxTop10 = Number(cfg.holderConcentration?.maxTop10Pct ?? 60);
  const maxTop50 = Number(cfg.holderConcentration?.maxTop50Pct ?? 80);
  const maxDevHoldings = Number(cfg.devWallet?.maxDevHoldingsPct ?? 10);

  if (Number.isFinite(top10) && top10 > maxTop10) {
    passed = false;
    reasons.push(`top10 ${top10}% > max ${maxTop10}%`);
  }
  if (Number.isFinite(top50) && top50 > maxTop50) {
    passed = false;
    reasons.push(`top50 ${top50}% > max ${maxTop50}%`);
  }
  if (Number.isFinite(devHoldings) && devHoldings > maxDevHoldings) {
    passed = false;
    reasons.push(`dev holdings ${devHoldings}% > max ${maxDevHoldings}%`);
  }

  const requireSmartMoney = cfg.smartMoney?.requireSmartMoneyForDeploy === true;
  if (!smartMoney?.available) {
    if (requireSmartMoney) {
      passed = false;
      reasons.push("smart money data required for deploy but unavailable");
    }
  } else {
    const netBuyUsd = Number(smartMoney.netBuyUsd);
    const netSellUsd = Number(smartMoney.netSellUsd);
    const minNetBuyUsd = Number(cfg.smartMoney?.minNetBuyUsd ?? 50000);
    if (Number.isFinite(netBuyUsd) && Number.isFinite(netSellUsd) && (netBuyUsd - netSellUsd) < 0) {
      passed = false;
      reasons.push(`smart money net flow negative (buy ${netBuyUsd} - sell ${netSellUsd})`);
    } else if (Number.isFinite(netBuyUsd) && netBuyUsd >= minNetBuyUsd) {
      scoreBonus += 10;
      reasons.push(`smart money net buy ${netBuyUsd} >= ${minNetBuyUsd}`);
    }
  }

  return {
    enabled: true,
    passed,
    score_bonus: scoreBonus,
    reason: reasons.join("; ") || "on-chain checks passed",
    intel,
    smart_money: smartMoney,
  };
}

export async function evaluateOnChainExitSignal(ctx, { mint } = {}) {
  const cfg = ctx.config.onChainIntelligence || {};
  if (!cfg.enabled || !mint) {
    return {
      enabled: false,
      should_close: false,
      reason: "onChainIntelligence disabled or mint missing",
    };
  }

  const intel = await getGmgnTokenIntel(ctx, mint);
  const smartMoney = await getGmgnSmartMoneyFlow(ctx, mint, {
    timeWindowMinutes: cfg.smartMoney?.timeWindowMinutes,
  });
  if (smartMoney?.available) {
    log(
      "onchain_intel",
      `exit ${String(mint).slice(0, 8)} net_buy=${smartMoney.netBuyUsd} net_sell=${smartMoney.netSellUsd} source=${smartMoney.source || "unknown"}`
    );
  } else {
    log("onchain_intel", `exit ${String(mint).slice(0, 8)} unavailable: ${smartMoney?.reason || "unknown"}`);
  }

  const reasons = [];
  const maxNetSellUsd = Number(cfg.smartMoney?.maxNetSellUsd ?? 30000);
  const netSellUsd = Number(smartMoney?.netSellUsd);
  if (Number.isFinite(netSellUsd) && netSellUsd >= maxNetSellUsd) {
    reasons.push(`smart money net sell ${netSellUsd} >= ${maxNetSellUsd}`);
  }

  const alertWhaleDump = cfg.holderConcentration?.alertWhaleDump !== false;
  const whaleDumpThreshold = Number(cfg.holderConcentration?.whaleDumpThresholdPct ?? 5);
  const currentTop10 = Number(intel?.top10ConcentrationPct);
  const prev = holderSnapshot.get(mint);
  if (Number.isFinite(currentTop10)) {
    holderSnapshot.set(mint, { top10: currentTop10, at: Date.now() });
  }
  if (
    alertWhaleDump &&
    Number.isFinite(currentTop10) &&
    Number.isFinite(prev?.top10) &&
    prev.top10 - currentTop10 >= whaleDumpThreshold
  ) {
    reasons.push(`top10 concentration drop ${Number((prev.top10 - currentTop10).toFixed(2))}% >= ${whaleDumpThreshold}%`);
  }

  return {
    enabled: true,
    should_close: reasons.length > 0,
    reason: reasons.join("; ") || "no on-chain exit signal",
    intel,
    smart_money: smartMoney,
  };
}
