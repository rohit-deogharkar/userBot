import { formatUnits } from "viem";
import { c, encodeKey } from "zodiac-roles-sdk";
import { ADDRESSES, TOKENS, config } from "./config.js";

// These rules are the whole security model. They are stored on-chain in each user's
// Roles module and checked by the blockchain on every bot transaction.

export const ROLE_KEY = encodeKey("dexbot-trader");

// One daily allowance per token, metering how much of it the bot may sell.
export const ALLOWANCE_KEYS = Object.fromEntries(
  Object.keys(TOKENS).map((symbol) => [symbol, encodeKey(`${symbol.toLowerCase()}-daily`)]),
);

export const ALLOWANCE_PERIOD_SECONDS = 86_400n;

const SWAP_PARAMS =
  "(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)";

export function tradePermissions() {
  const router = ADDRESSES.swapRouter;
  const fee = config.rules.poolFee;
  const { DEOD, USDT } = TOKENS;

  return [
    // The bot may approve DEOD and USDT, but only for the PancakeSwap router.
    ...[DEOD, USDT].map((token) => ({
      targetAddress: token.address,
      signature: "approve(address,uint256)",
      condition: c.calldataMatches([router], ["address", "uint256"]),
    })),

    // The bot may swap DEOD for USDT or USDT for DEOD in one pool only.
    // The output must go back to the bot wallet itself, and the amount sold counts against a daily limit.
    {
      targetAddress: router,
      signature: "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
      condition: c.calldataMatches(
        [
          c.or(
            { tokenIn: DEOD.address, tokenOut: USDT.address, fee, recipient: c.avatar, amountIn: c.withinAllowance(ALLOWANCE_KEYS.DEOD) },
            { tokenIn: USDT.address, tokenOut: DEOD.address, fee, recipient: c.avatar, amountIn: c.withinAllowance(ALLOWANCE_KEYS.USDT) },
          ),
        ],
        [SWAP_PARAMS],
      ),
    },
  ];
}

const amount = (value, decimals) => Number(formatUnits(value, decimals)).toLocaleString("en-US");

/** Plain-language version of the rules, shown to users before they enable the bot. */
export function rulesSummary() {
  const { poolFee, dailyLimits } = config.rules;
  const { DEOD, USDT } = TOKENS;
  return {
    allowed: [
      `Swap between DEOD and USDT on PancakeSwap, in the ${poolFee / 10_000}% fee pool only.`,
      "Every swap sends its output back to your bot wallet.",
      "Approve DEOD and USDT for the PancakeSwap router only.",
      `Sell at most ${amount(dailyLimits.DEOD, DEOD.decimals)} DEOD and ${amount(dailyLimits.USDT, USDT.decimals)} USDT per day.`,
    ],
    blocked: [
      "Withdraw or transfer funds to any address.",
      "Trade any other token, or use any other exchange or pool.",
      "Change these rules, add modules or change the wallet owner.",
    ],
  };
}
