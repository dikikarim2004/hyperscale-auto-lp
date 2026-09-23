/**
 * App-operator-level settings — sourced ONLY from this server's .env, NEVER
 * per-user. Jupiter Ultra referral fee is the application's own revenue
 * stream, so it must always route to the operator's wallet regardless of
 * which telegramId is trading. Do not expose these in /config or UserSecret.
 */

export const jupiterAppConfig = {
  apiKey: process.env.JUPITER_API_KEY ?? "",
  referralAccount:
    process.env.JUPITER_REFERRAL_ACCOUNT ??
    "BRbthXbSFKbndyVnRicDz91wUiH113p62sipFfd47ZVt",
  referralFeeBps: Number(
    process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
  ),
};
