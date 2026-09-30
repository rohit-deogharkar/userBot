import { encodeFunctionData, formatEther, formatUnits } from "viem";
import { createExecution } from "@metamask/smart-accounts-kit";
import { erc20Abi, quoterV2Abi, swapRouterAbi } from "./abis.js";
import { botClient, botQueue, publicClient } from "./chain.js";
import { ADDRESSES, TOKENS, config } from "./config.js";
import { HttpError, describeError } from "./errors.js";
import { GROUP, MM, approveExecution, encodeRedeem, gasBudgetLeftToday, gasRepayExecution, withGroup } from "./metamask.js";

export async function quoteSwap(tokenIn, tokenOut, amountIn) {
  const { result } = await publicClient.simulateContract({
    address: ADDRESSES.quoter,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn, fee: config.rules.poolFee, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

const balanceOf = (token, owner) =>
  publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [owner] });

const amount = (value, token) => `${formatUnits(value, token.decimals)} ${token.symbol}`;
const bnb = (value) => `${formatEther(value)} ${config.nativeSymbol}`;

/**
 * Sends the trade from the bot, with the user's smart account paying the bot back for the gas in the
 * same transaction. The repayment is the gas estimate times the gas price the transaction pays.
 * Gas estimates for delegation redemptions run tight, so the gas limit has a 30% margin; unused gas isn't charged.
 */
async function sendTrade({ account, delegation, items, gasBudget }) {
  const botAddress = botClient.account.address;
  const repay = (value) => ({ delegation: withGroup(delegation, GROUP.GAS), execution: gasRepayExecution(botAddress, value) });
  return botQueue(async () => {
    const gasPrice = await publicClient.getGasPrice();
    let estimate;
    try {
      // Sending BNB costs the same gas whatever the amount, so a 1 wei placeholder gives the real estimate.
      const data = encodeRedeem([...items, repay(1n)]);
      estimate = await publicClient.estimateGas({ account: botAddress, to: MM.delegationManager, data });
    } catch (error) {
      // The permission or the swap would fail. Explain why without spending gas.
      throw new HttpError(400, describeError(error).message);
    }
    const gasCost = estimate * gasPrice;
    const held = await publicClient.getBalance({ address: account });
    if (gasCost > held) {
      throw new HttpError(400, `This trade's gas costs about ${bnb(gasCost)}, but the smart account holds ${bnb(held)}. Deposit some ${config.nativeSymbol}.`);
    }
    if (gasCost > gasBudget) {
      throw new HttpError(400, `This trade's gas costs about ${bnb(gasCost)}, more than the ${bnb(gasBudget)} left in today's gas budget.`);
    }
    const data = encodeRedeem([...items, repay(gasCost)]);
    const hash = await botClient.sendTransaction({ to: MM.delegationManager, data, gas: (estimate * 13n) / 10n, gasPrice });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
    return { receipt, gasCost };
  });
}

/**
 * Swaps tokenIn for tokenOut inside the user's smart account, using the permission they signed.
 * The approval (if needed), the swap and the gas repayment go out as one transaction, so a trade
 * can never happen without the user paying its gas.
 */
export async function executeSwap({ account, delegation, tokenIn, tokenOut, amountIn, soldToday }) {
  const { perTradeLimits, dailyLimits } = config.rules;

  if (amountIn > perTradeLimits[tokenIn.symbol]) {
    throw new HttpError(400, `One trade can sell at most ${amount(perTradeLimits[tokenIn.symbol], tokenIn)}.`);
  }
  if (soldToday + amountIn > dailyLimits[tokenIn.symbol]) {
    throw new HttpError(400, `This would pass today's limit of ${amount(dailyLimits[tokenIn.symbol], tokenIn)} sold.`);
  }

  const [gasBudget, bnbHeld] = await Promise.all([gasBudgetLeftToday(delegation), publicClient.getBalance({ address: account })]);
  if (bnbHeld === 0n) throw new HttpError(400, `The smart account has no ${config.nativeSymbol} to pay the bot's gas. Deposit a little first.`);
  if (gasBudget === 0n) throw new HttpError(400, "Today's gas budget is used up. The bot will trade again tomorrow.");

  const quotedOut = await quoteSwap(tokenIn, tokenOut, amountIn);
  const minOut = (quotedOut * (10_000n - config.rules.slippageBps)) / 10_000n;

  const items = [];
  const allowance = await publicClient.readContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account, ADDRESSES.swapRouter],
  });
  if (allowance < amountIn) items.push({ delegation: withGroup(delegation, GROUP.APPROVE), execution: approveExecution(tokenIn) });

  const swapGroup = tokenIn.symbol === TOKENS.USDT.symbol ? GROUP.SELL_USDT : GROUP.SELL_DEOD;
  items.push({
    delegation: withGroup(delegation, swapGroup),
    execution: createExecution({
      target: ADDRESSES.swapRouter,
      callData: encodeFunctionData({
        abi: swapRouterAbi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: tokenIn.address,
            tokenOut: tokenOut.address,
            fee: config.rules.poolFee,
            recipient: account,
            amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
    }),
  });

  const before = await balanceOf(tokenOut, account);
  const { receipt, gasCost } = await sendTrade({ account, delegation, items, gasBudget });
  const after = await balanceOf(tokenOut, account);

  return { txHash: receipt.transactionHash, gasUsed: receipt.gasUsed, quotedOut, minOut, amountOut: after - before, gasFee: gasCost };
}
