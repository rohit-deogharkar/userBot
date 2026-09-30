import { parseUnits } from "viem";

/**
 * TEST STRATEGY: random trades, for trying the system out on testnet. Replace it with the real strategy.
 * Because it's random, the runner never runs it on BNB Chain mainnet (see `testOnly`).
 *
 * The runner calls `decide` once per user with the bot enabled, every STRATEGY_INTERVAL_MS, but only
 * when their smart account holds enough BNB for the gas and today's gas budget allows a trade.
 * Return null to do nothing, or { sell: "DEOD" | "USDT", amountIn: bigint } to make one swap.
 * Selling USDT buys DEOD. Amounts use 18 decimals for both tokens, so 1 USDT is 10n ** 18n.
 *
 * The strategy never touches keys. It only returns a decision, and the permission the user
 * signed still limits every trade on-chain.
 *
 * @param {object} context
 * @param {string} context.owner              The user's MetaMask address
 * @param {string} context.account            Their MetaMask smart account
 * @param {{DEOD: bigint, USDT: bigint}} context.balances           What the smart account holds (also BNB, under its own symbol)
 * @param {{DEOD: bigint, USDT: bigint}} context.remainingToday     What the daily sell limits still allow
 * @param {{DEOD: bigint, USDT: bigint}} context.perTradeLimits     The most one trade may sell
 */
export async function decide({ balances, remainingToday, perTradeLimits }) {
  // Buy or sell, 50/50. If the account can't do that side, it tries the other one.
  const sides = Math.random() < 0.5 ? ["USDT", "DEOD"] : ["DEOD", "USDT"];
  for (const sell of sides) {
    const [min, max] = TRADE_SIZE[sell];
    const most = [balances[sell], remainingToday[sell], perTradeLimits[sell]].reduce((a, b) => (b < a ? b : a));
    if (most < tokens(min)) continue;
    const amountIn = tokens(min + Math.floor(Math.random() * (max - min + 1)));
    return { sell, amountIn: amountIn < most ? amountIn : most };
  }
  return null;
}

/** Never run on BNB Chain mainnet. */
export const testOnly = true;

/** Shown to users and in the server log. */
export const description = "a random buy or sell of DEOD";

// Each trade sells a random whole amount in this range. 1 USDT is worth about 50 DEOD in the testnet pool.
const TRADE_SIZE = { DEOD: [50, 500], USDT: [1, 10] };

const tokens = (whole) => parseUnits(String(whole), 18);
