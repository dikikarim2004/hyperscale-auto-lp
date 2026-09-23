import { ComputeBudgetProgram, Transaction } from "@solana/web3.js";

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

export async function calculatePriorityFee(connection, {
  multiplier = 2,
  fallbackMicroLamports = 5_000,
  minMicroLamports = 1_000,
  maxMicroLamports = 2_000_000,
} = {}) {
  const safeFallback = Math.max(0, Number(fallbackMicroLamports) || 0);
  try {
    const fees = await connection.getRecentPrioritizationFees();
    const samples = Array.isArray(fees)
      ? fees
          .map((entry) => Number(entry?.prioritizationFee))
          .filter((value) => Number.isFinite(value) && value > 0)
      : [];

    const med = median(samples);
    if (!Number.isFinite(med) || med <= 0) return safeFallback;

    const boosted = med * (Number.isFinite(Number(multiplier)) ? Number(multiplier) : 2);
    const clamped = Math.min(Math.max(boosted, Number(minMicroLamports) || 1_000), Number(maxMicroLamports) || 2_000_000);
    return Math.round(clamped);
  } catch {
    return safeFallback;
  }
}

export function applyPriorityFeeToTransaction(tx, microLamports) {
  const fee = Math.max(0, Number(microLamports) || 0);
  if (!fee) return { applied: false, reason: "invalid_priority_fee" };
  if (!(tx instanceof Transaction)) {
    return { applied: false, reason: "unsupported_transaction_type" };
  }

  const hasComputeBudgetIx = tx.instructions?.some((ix) => ix?.programId?.equals?.(ComputeBudgetProgram.programId));
  if (hasComputeBudgetIx) {
    return { applied: false, reason: "compute_budget_already_set" };
  }

  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }));
  return { applied: true, microLamports: fee };
}
