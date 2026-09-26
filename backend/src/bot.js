import { encodeFunctionData, formatUnits, maxUint256 } from "viem";
import { erc20Abi, quoterV2Abi, rolesAbi, swapRouterAbi } from "./abis.js";
import { botClient, botQueue, feeCollector, publicClient, sendAndConfirm } from "./chain.js";
import { ADDRESSES, TOKENS, config } from "./config.js";
import { HttpError } from "./errors.js";
import { ROLE_KEY } from "./permissions.js";
import { feeRemainingToday } from "./roles.js";

/**
 * Sends one call from the user's bot wallet through the Roles module.
 * The Roles module checks it against the user's rules and reverts if it breaks any of them.
 */
export async function execWithRole(roles, to, data) {
  const receipt = await sendAndConfirm(botClient, botQueue, {
    address: roles,
    abi: rolesAbi,
    functionName: "execTransactionWithRole",
    args: [to, 0n, data, 0, ROLE_KEY, true],
  });
  return receipt.transactionHash;
}

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

const usdt = (value) => `${formatUnits(value, TOKENS.USDT.decimals)} USDT`;

/** Takes the flat network fee in USDT from the bot wallet. The rules cap it per day. */
async function takeFee(roles, fee) {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [feeCollector, fee] });
  return execWithRole(roles, TOKENS.USDT.address, data);
}

/**
 * Swaps tokenIn for tokenOut inside the user's bot wallet. Output always lands back in the same wallet.
 * The user pays the bot's gas through a flat USDT fee per trade, taken from the same wallet.
 */
export async function executeSwap({ safe, roles, tokenIn, tokenOut, amountIn }) {
  const router = ADDRESSES.swapRouter;
  const fee = config.rules.tradeFee;
  const sellingUsdt = tokenIn.symbol === TOKENS.USDT.symbol;
  const txHashes = [];

  const quotedOut = await quoteSwap(tokenIn, tokenOut, amountIn);
  const minOut = (quotedOut * (10_000n - config.rules.slippageBps)) / 10_000n;

  // Check the fee can be paid before trading, so the bot never trades without charging it.
  if (fee > 0n) {
    if ((await feeRemainingToday(roles)) < fee) {
      throw new HttpError(400, "Today's network fee budget is used up. The bot will trade again tomorrow.");
    }
    const usdtBalance = await balanceOf(TOKENS.USDT, safe);
    const usdtAvailable = sellingUsdt ? usdtBalance - amountIn : usdtBalance + minOut;
    if (usdtAvailable < fee) {
      throw new HttpError(400, `The bot wallet needs ${usdt(fee)} for the network fee on top of this trade.`);
    }
  }

  const allowance = await publicClient.readContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: [safe, router],
  });
  if (allowance < amountIn) {
    const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, maxUint256] });
    txHashes.push(await execWithRole(roles, tokenIn.address, approveData));
  }

  const before = await balanceOf(tokenOut, safe);
  const swapData = encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        fee: config.rules.poolFee,
        recipient: safe,
        amountIn,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const swapTxHash = await execWithRole(roles, router, swapData);
  txHashes.push(swapTxHash);
  const after = await balanceOf(tokenOut, safe);

  if (fee > 0n) txHashes.push(await takeFee(roles, fee));

  return { txHashes, swapTxHash, quotedOut, minOut, amountOut: after - before, fee };
}
