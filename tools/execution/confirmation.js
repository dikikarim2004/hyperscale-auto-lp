function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Konfirmasi signature sampai confirmed/finalized, dengan timeout terkontrol.
 * Tidak melempar error untuk status timeout/failed agar caller bisa tentukan fallback.
 */
export async function confirmTransaction(
  connection,
  signature,
  {
    timeoutMs = 60_000,
    requireFinalized = false,
    pollIntervalMs = 2_000,
  } = {},
) {
  if (!connection) throw new Error("confirmTransaction: connection is required");
  if (!signature) throw new Error("confirmTransaction: signature is required");

  const startedAt = Date.now();
  const safeTimeoutMs = Math.max(5_000, Number(timeoutMs) || 60_000);
  const safePollMs = Math.max(500, Number(pollIntervalMs) || 2_000);
  let lastStatus = null;

  while (Date.now() - startedAt < safeTimeoutMs) {
    try {
      const response = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const status = response?.value?.[0] || null;
      lastStatus = status;

      if (status?.err) {
        return {
          status: "failed",
          signature,
          err: status.err,
          confirmationStatus: status.confirmationStatus || null,
          slot: status.slot || null,
        };
      }

      const confirmationStatus = status?.confirmationStatus || null;
      if (confirmationStatus === "finalized") {
        return {
          status: "finalized",
          signature,
          confirmationStatus,
          slot: status?.slot || null,
        };
      }
      if (!requireFinalized && confirmationStatus === "confirmed") {
        return {
          status: "confirmed",
          signature,
          confirmationStatus,
          slot: status?.slot || null,
        };
      }
    } catch (error) {
      // Non-fatal; lanjut polling sampai timeout.
      lastStatus = {
        err: String(error?.message || error),
        confirmationStatus: null,
        slot: null,
      };
    }

    await sleep(safePollMs);
  }

  return {
    status: "timeout",
    signature,
    confirmationStatus: lastStatus?.confirmationStatus || null,
    slot: lastStatus?.slot || null,
    err: lastStatus?.err || null,
  };
}
