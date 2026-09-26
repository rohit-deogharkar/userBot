import { randomUUID } from "node:crypto";
import { encodeFunctionData, formatUnits, getAddress, parseUnits } from "viem";
import { erc20Abi } from "./abis.js";
import { executeSwap } from "./bot.js";
import { publicClient } from "./chain.js";
import { TOKENS, config, otherToken } from "./config.js";
import { toJson, trades, users, walletActions } from "./db.js";
import { HttpError, describeError } from "./errors.js";
import { buildEnableBotCalls, buildStopBotCall, deployRoles, getRolesState } from "./roles.js";
import { buildSafeTx, deploySafe, encodeMultiSend, executeSafeTx, isDeployed, safeTxTypedData } from "./safe.js";

const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** Balances of the trading pair tokens plus the chain's native coin (BNB), keyed by symbol. */
export async function getBalances(address) {
  const tokens = Object.values(TOKENS);
  const [native, ...tokenBalances] = await Promise.all([
    publicClient.getBalance({ address }),
    ...tokens.map((t) => publicClient.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [address] })),
  ]);
  return Object.fromEntries([...tokens.map((t, i) => [t.symbol, tokenBalances[i]]), [config.nativeSymbol, native]]);
}

export async function getWalletInfo(user) {
  if (!user?.safeAddress) return null;
  const safe = getAddress(user.safeAddress);
  // A restarted local fork forgets wallets the database still remembers. Treat those as not created yet;
  // creating again redeploys them at the same address.
  if (!(await isDeployed(safe))) return null;
  const [balances, rolesState] = await Promise.all([
    getBalances(safe),
    getRolesState(safe, user.rolesAddress && getAddress(user.rolesAddress)),
  ]);
  return {
    safeAddress: safe,
    rolesAddress: user.rolesAddress ? getAddress(user.rolesAddress) : null,
    botEnabled: rolesState.botEnabled,
    balances,
    remainingToday: rolesState.remainingToday,
  };
}

// Stops a double click from sending two wallet deployments at once.
const creating = new Map();

/** Creates the user's bot wallet and its (switched off) Roles module. Safe to call more than once. */
export async function createBotWallet(owner) {
  const key = owner.toLowerCase();
  if (!creating.has(key)) {
    creating.set(
      key,
      (async () => {
        const safe = await deploySafe(owner);
        const roles = await deployRoles(safe);
        return users.upsertWallet(owner, safe, roles);
      })().finally(() => creating.delete(key)),
    );
  }
  return creating.get(key);
}

async function requireWallet(owner) {
  const user = await users.get(owner);
  if (!user?.safeAddress || !user?.rolesAddress || !(await isDeployed(getAddress(user.safeAddress)))) {
    throw new HttpError(400, "Create your bot wallet first.");
  }
  return { user, safe: getAddress(user.safeAddress), roles: getAddress(user.rolesAddress) };
}

/**
 * Builds a wallet action for the user to sign in MetaMask.
 * The backend decides the contents, the user's signature approves them, and nobody can change them afterwards.
 */
export async function prepareWalletAction(owner, { kind, token, amount }) {
  const { user, safe, roles } = await requireWallet(owner);
  const info = await getWalletInfo(user);
  let call;
  let summary;

  if (kind === "enable-bot") {
    if (info.botEnabled) throw new HttpError(400, "The bot is already enabled.");
    call = encodeMultiSend(await buildEnableBotCalls(safe, roles));
    summary = "Enable the bot with trade-only rules";
  } else if (kind === "stop-bot") {
    const stop = await buildStopBotCall(safe, roles);
    if (!stop) throw new HttpError(400, "The bot is already stopped.");
    call = { ...stop, value: 0n, operation: 0 };
    summary = "Stop the bot";
  } else if (kind === "withdraw") {
    const asset = token === config.nativeSymbol ? { symbol: config.nativeSymbol, decimals: 18 } : TOKENS[token];
    if (!asset) throw new HttpError(400, `Choose ${[...Object.keys(TOKENS), config.nativeSymbol].join(", ")} to withdraw.`);
    const balance = info.balances[asset.symbol];
    const value = amount === "max" ? balance : parseUnits(String(amount ?? ""), asset.decimals);
    if (value <= 0n) throw new HttpError(400, "Enter an amount greater than zero.");
    if (value > balance) throw new HttpError(400, `The bot wallet only holds ${formatUnits(balance, asset.decimals)} ${asset.symbol}.`);
    // Withdrawals always go to the owner's MetaMask. The backend never offers any other recipient.
    call =
      asset.symbol === config.nativeSymbol
        ? { to: owner, value, data: "0x", operation: 0 }
        : {
            to: asset.address,
            value: 0n,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [owner, value] }),
            operation: 0,
          };
    summary = `Withdraw ${formatUnits(value, asset.decimals)} ${asset.symbol} to ${short(owner)}`;
  } else {
    throw new HttpError(400, `Unknown wallet action "${kind}".`);
  }

  const safeTx = await buildSafeTx(safe, call);
  const id = randomUUID();
  await walletActions.create({ id, owner, safeAddress: safe, kind, summary, safeTx });
  return { id, kind, summary, typedData: JSON.parse(toJson(safeTxTypedData(safe, safeTx))) };
}

export async function executeWalletAction(owner, id, signature) {
  const action = await walletActions.claimForSubmit(id, owner);
  if (!action) {
    const existing = await walletActions.find(id, owner);
    if (!existing) throw new HttpError(404, "Wallet action not found.");
    throw new HttpError(400, `This action is already ${existing.status}.`);
  }
  try {
    const txHash = await executeSafeTx(getAddress(action.safeAddress), owner, action.safeTx, signature);
    await walletActions.finish(id, "executed", { txHash });
    return { txHash };
  } catch (error) {
    await walletActions.finish(id, error.status === 409 ? "expired" : "failed", { error: describeError(error).message });
    throw error;
  }
}

/** Runs one swap for a user and records the result. Used by the strategy runner and by test trades. */
export async function tradeForUser(owner, { sell, amountIn, source }) {
  const { safe, roles } = await requireWallet(owner);
  const tokenIn = TOKENS[sell];
  if (!tokenIn) throw new HttpError(400, `The bot can only sell ${Object.keys(TOKENS).join(" or ")}.`);
  const tokenOut = otherToken(tokenIn.symbol);
  const base = { owner, safeAddress: safe, tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol, amountIn, source };
  try {
    const result = await executeSwap({ safe, roles, tokenIn, tokenOut, amountIn });
    await trades.record({ ...base, minOut: result.minOut, amountOut: result.amountOut, txHash: result.txHashes.at(-1), status: "success" });
    return { ...result, tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol };
  } catch (error) {
    await trades.record({ ...base, status: "failed", error: describeError(error).message });
    throw error;
  }
}
