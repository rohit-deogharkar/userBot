import { getAddress } from "viem";
import { config } from "../config.js";
import { users } from "../db.js";
import { describeError } from "../errors.js";
import { getWalletInfo, tradeForUser } from "../wallets.js";
import { decide } from "./strategy.js";

let running = false;

async function tick() {
  if (running) return; // Skip a tick if the previous one is still going.
  running = true;
  try {
    for (const user of await users.withBotPermission()) {
      const owner = getAddress(user.address);
      try {
        const wallet = await getWalletInfo(user);
        if (!wallet?.botEnabled) continue;
        const decision = await decide({ owner, ...wallet });
        if (!decision) continue;
        const result = await tradeForUser(owner, { ...decision, source: "strategy" });
        console.log(`[strategy] ${owner} sold ${decision.amountIn} ${result.tokenIn} for ${result.amountOut} ${result.tokenOut}`);
      } catch (error) {
        console.error(`[strategy] ${owner}: ${describeError(error).message}`);
      }
    }
  } finally {
    running = false;
  }
}

export function startStrategyRunner() {
  if (!config.strategy.enabled) {
    console.log("Strategy runner is off. Set STRATEGY_ENABLED=true to turn it on.");
    return;
  }
  console.log(`Strategy runner checks every ${config.strategy.intervalMs / 1000}s`);
  setInterval(tick, config.strategy.intervalMs);
}
