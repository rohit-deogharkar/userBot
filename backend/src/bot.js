import { encodeFunctionData, maxUint256 } from "viem";
import { erc20Abi, quoterV2Abi, rolesAbi, swapRouterAbi } from "./abis.js";
import { botClient, botQueue, publicClient, sendAndConfirm } from "./chain.js";
import { ADDRESSES, config } from "./config.js";
import { ROLE_KEY } from "./permissions.js";

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

/** Swaps tokenIn for tokenOut inside the user's bot wallet. Output always lands back in the same wallet. */
export async function executeSwap({ safe, roles, tokenIn, tokenOut, amountIn }) {
  const router = ADDRESSES.swapRouter;
  const txHashes = [];

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

  const quotedOut = await quoteSwap(tokenIn, tokenOut, amountIn);
  const minOut = (quotedOut * (10_000n - config.rules.slippageBps)) / 10_000n;

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
  txHashes.push(await execWithRole(roles, router, swapData));
  const after = await balanceOf(tokenOut, safe);

  return { txHashes, quotedOut, minOut, amountOut: after - before };
}
