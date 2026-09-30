import { formatEther, formatUnits, getAddress } from "viem";
import { publicClient } from "../chain.js";
import { TOKENS, config } from "../config.js";
import { users } from "../db.js";
import { describeError } from "../errors.js";
import { getWalletInfo, tradeForUser } from "../wallets.js";
import { decide, description, testOnly } from "./strategy.js";

// A trade uses about 1.2 to 1.7 million gas. A user is skipped until their BNB and gas budget cover this much.
const TRADE_GAS = 2_000_000n;

/** Whether the bot trades by itself, and how often. Also shown to users. */
export const automaticTrading = {
  enabled: config.strategy.enabled && !(testOnly && config.networkName === "bsc"),
  intervalMs: config.strategy.intervalMs,
  description,
};

// Why each user was last skipped, so the log says it once instead of every tick.
const lastSkip = new Map();
function skip(owner, reason) {
  if (lastSkip.get(owner) !== reason) console.log(`[auto] ${owner}: ${reason}`);
  lastSkip.set(owner, reason);
}

const show = (amount, symbol) =>
  `${Number(formatUnits(amount, TOKENS[symbol].decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${symbol}`;

let running = false;

async function tick() {
  if (running) return; // Skip a tick if the previous one is still going.
  running = true;
  try {
    const gasNeeded = TRADE_GAS * (await publicClient.getGasPrice());
    for (const user of await users.withBotPermission()) {
      const owner = getAddress(user.address);
      try {
        const wallet = await getWalletInfo(user);
        // Stopped bots are skipped. "Stop bot" also removes the user from this list.
        if (!wallet?.botEnabled) continue;
        // Wait quietly instead of recording a failed trade every tick.
        if (wallet.balances[config.nativeSymbol] < gasNeeded) {
          skip(owner, `waiting: the smart account needs about ${formatEther(gasNeeded)} ${config.nativeSymbol} for gas`);
          continue;
        }
        if (wallet.gasBudgetLeftToday < gasNeeded) {
          skip(owner, "waiting: today's gas budget is used up");
          continue;
        }
        const decision = await decide({ owner, ...wallet });
        if (!decision) {
          skip(owner, "waiting: not enough DEOD or USDT to trade");
          continue;
        }
        lastSkip.delete(owner);
        const result = await tradeForUser(owner, { ...decision, source: "strategy" });
        console.log(`[auto] ${owner} sold ${show(decision.amountIn, result.tokenIn)} for ${show(result.amountOut, result.tokenOut)}`);
      } catch (error) {
        console.error(`[auto] ${owner}: ${describeError(error).message}`);
      }
    }
  } catch (error) {
    console.error(`[auto] ${describeError(error).message}`);
  } finally {
    running = false;
  }
}

export function startStrategyRunner() {
  if (!config.strategy.enabled) {
    console.log("Automatic trading is off. Set STRATEGY_ENABLED=true to turn it on.");
    return;
  }
  if (!automaticTrading.enabled) {
    console.warn("Automatic trading is off: strategy.js holds the random test strategy, which never runs on BNB Chain mainnet.");
    return;
  }
  console.log(`Automatic trading is on: ${description} every ${config.strategy.intervalMs / 1000}s for each user with the bot enabled`);
  setInterval(tick, config.strategy.intervalMs);
}
