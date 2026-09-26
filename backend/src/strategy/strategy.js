/**
 * The trading strategy goes here. It is intentionally empty for now.
 *
 * It is called once per user with the bot enabled, every STRATEGY_INTERVAL_MS.
 * Return null to do nothing, or { sell: "DEOD" | "USDT", amountIn: bigint } to make one swap.
 * Amounts use 18 decimals for both tokens, so 1 USDT is 10n ** 18n.
 *
 * The strategy never touches keys. It only returns a decision, and the user's
 * Roles module still checks every trade against their on-chain rules.
 *
 * @param {object} context
 * @param {string} context.owner              The user's MetaMask address
 * @param {string} context.safeAddress        Their bot wallet
 * @param {{DEOD: bigint, USDT: bigint, BNB: bigint}} context.balances
 * @param {{DEOD: bigint, USDT: bigint}} context.remainingToday   What the daily limits still allow
 */
export async function decide(context) {
  return null;
}
