import { randomUUID } from "node:crypto";
import { formatUnits, getAddress, parseUnits } from "viem";
import { erc20Abi } from "./abis.js";
import { executeSwap } from "./bot.js";
import { botAccount, publicClient } from "./chain.js";
import { TOKENS, config, otherToken } from "./config.js";
import { toJson, trades, users, walletActions } from "./db.js";
import { HttpError, describeError } from "./errors.js";
import {
  MM,
  accountOwner,
  buildBotDelegation,
  buildCreateAccountTx,
  buildOwnerDelegation,
  delegationHash,
  delegationTypedData,
  gasBudgetLeftToday,
  isBotDelegationLive,
  isDeployed,
  isValidDelegationSignature,
  ownerActionTx,
  predictAccount,
  sameAddress,
  stopBotExecution,
  withdrawExecution,
} from "./metamask.js";

const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const asJson = (value) => JSON.parse(toJson(value));

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
  if (!user?.account || !user?.ownerDelegation) return null;
  const account = getAddress(user.account);
  // A restarted local fork forgets accounts the database still remembers. Treat those as not created yet;
  // creating again redeploys them at the same address.
  if (!(await isDeployed(account))) return null;

  const botDelegation = user.botDelegation?.delegation ?? null;
  const [balances, botEnabled] = await Promise.all([
    getBalances(account),
    botDelegation ? isBotDelegationLive(account, botDelegation) : false,
  ]);
  const remainingToday = {};
  for (const symbol of Object.keys(TOKENS)) {
    const sold = await trades.soldInLastDay(user.address, symbol);
    const limit = config.rules.dailyLimits[symbol];
    remainingToday[symbol] = sold >= limit ? 0n : limit - sold;
  }
  return {
    account,
    botEnabled,
    balances,
    remainingToday,
    perTradeLimits: config.rules.perTradeLimits,
    gasBudgetLeftToday: botEnabled ? await gasBudgetLeftToday(botDelegation) : 0n,
  };
}

/**
 * Step 1 of creating the smart account: the MetaMask transaction that deploys it, plus the owner
 * delegation the user signs so they can later withdraw and stop the bot from MetaMask.
 */
export async function prepareCreateWallet(owner) {
  const { account, tx } = await buildCreateAccountTx(owner);
  const ownerDelegation = buildOwnerDelegation(owner, account);
  return asJson({ account, tx, ownerDelegation, typedData: delegationTypedData(ownerDelegation) });
}

/** Step 2: once the account exists, check the owner delegation's signature on-chain and record both. */
export async function syncBotWallet(owner, signature) {
  const { address: account } = await predictAccount(owner);
  if (!(await isDeployed(account))) {
    throw new HttpError(400, "Your smart account is not on the blockchain yet. Confirm the MetaMask transaction first.");
  }
  if (!sameAddress(await accountOwner(account), owner)) throw new HttpError(400, "That smart account has a different owner.");

  const existing = await users.get(owner);
  if (!signature) {
    if (existing?.ownerDelegation && sameAddress(existing.account, account)) return existing;
    throw new HttpError(400, "Sign the owner permission in MetaMask to finish setting up your smart account.");
  }
  const ownerDelegation = buildOwnerDelegation(owner, account);
  if (!(await isValidDelegationSignature(ownerDelegation, signature))) {
    throw new HttpError(400, "That signature is not from the smart account's owner.");
  }
  return users.saveAccount(owner, account, { ...ownerDelegation, signature });
}

async function requireAccount(owner) {
  const user = await users.get(owner);
  if (!user?.account || !user?.ownerDelegation || !(await isDeployed(getAddress(user.account)))) {
    throw new HttpError(400, "Create your smart account first.");
  }
  return { user, account: getAddress(user.account) };
}

/** Builds the bot's trade-only permission for the user to sign once in MetaMask. Signing is free. */
export async function prepareEnableBot(owner) {
  const { user, account } = await requireAccount(owner);
  const info = await getWalletInfo(user);
  if (info.botEnabled) throw new HttpError(400, "The bot is already enabled.");
  const delegation = await buildBotDelegation(account, botAccount.address);
  const id = randomUUID();
  const summary = "Give the bot its trade-only permission";
  await walletActions.create({ id, owner, account, kind: "enable-bot", summary, delegation: asJson(delegation) });
  return asJson({ id, kind: "enable-bot", summary, delegation, typedData: delegationTypedData(delegation) });
}

/** Stores the signed bot permission after the smart account itself confirms the signature is valid. */
export async function confirmEnableBot(owner, id, signature) {
  const action = await walletActions.claimForConfirm(id, owner);
  if (!action || action.kind !== "enable-bot") {
    const existing = await walletActions.find(id, owner);
    if (!existing) throw new HttpError(404, "Permission request not found.");
    throw new HttpError(400, `This request is already ${existing.status}.`);
  }
  try {
    if (!(await isValidDelegationSignature(action.delegation, signature))) {
      throw new HttpError(400, "That signature is not from the smart account's owner.");
    }
    const signed = { ...action.delegation, signature };
    await users.setBotDelegation(owner, { delegation: signed, hash: delegationHash(signed), createdAt: new Date() });
    await walletActions.finish(id, "executed");
    return { ok: true };
  } catch (error) {
    await walletActions.finish(id, "failed", { error: describeError(error).message });
    throw error;
  }
}

/**
 * Builds a transaction the user sends from MetaMask through their owner delegation. The user pays its gas.
 * The browser checks its contents before MetaMask opens.
 */
export async function prepareWalletAction(owner, { kind, token, amount }) {
  const { user, account } = await requireAccount(owner);
  const info = await getWalletInfo(user);
  let execution;
  let summary;

  if (kind === "stop-bot") {
    if (!info.botEnabled) throw new HttpError(400, "The bot is already stopped.");
    execution = stopBotExecution();
    summary = "Stop the bot";
  } else if (kind === "withdraw") {
    const asset = token === config.nativeSymbol ? { symbol: config.nativeSymbol, decimals: 18 } : TOKENS[token];
    if (!asset) throw new HttpError(400, `Choose ${[...Object.keys(TOKENS), config.nativeSymbol].join(", ")} to withdraw.`);
    const balance = info.balances[asset.symbol];
    const value = amount === "max" ? balance : parseUnits(String(amount ?? ""), asset.decimals);
    if (value <= 0n) throw new HttpError(400, "Enter an amount greater than zero.");
    if (value > balance) throw new HttpError(400, `The smart account only holds ${formatUnits(balance, asset.decimals)} ${asset.symbol}.`);
    // Withdrawals always go to the owner's MetaMask. The backend never offers any other recipient.
    execution = withdrawExecution(owner, asset, value);
    summary = `Withdraw ${formatUnits(value, asset.decimals)} ${asset.symbol} to ${short(owner)}`;
  } else {
    throw new HttpError(400, `Unknown wallet action "${kind}".`);
  }

  const tx = ownerActionTx(user.ownerDelegation, execution);
  const id = randomUUID();
  await walletActions.create({ id, owner, account, kind, summary, tx });
  return asJson({ id, kind, summary, tx });
}

/** Records a wallet action the user sent from MetaMask, after checking the transaction on-chain. */
export async function confirmWalletAction(owner, id, txHash) {
  const action = await walletActions.claimForConfirm(id, owner);
  if (!action || !action.tx) {
    const existing = await walletActions.find(id, owner);
    if (!existing) throw new HttpError(404, "Wallet action not found.");
    throw new HttpError(400, `This action is already ${existing.status}.`);
  }
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    const transaction = await publicClient.getTransaction({ hash: txHash });
    if (receipt.status !== "success") throw new HttpError(400, "That transaction failed on the blockchain.");
    if (!sameAddress(transaction.from, owner)) throw new HttpError(400, "That transaction was not sent by the account owner.");
    if (!transaction.to || !sameAddress(transaction.to, MM.delegationManager) || transaction.input.toLowerCase() !== action.tx.data.toLowerCase()) {
      throw new HttpError(400, "That transaction does not match this wallet action.");
    }
    if (action.kind === "stop-bot") await users.setBotDelegation(owner, null);
    await walletActions.finish(id, "executed", { txHash });
    return { txHash };
  } catch (error) {
    await walletActions.finish(id, "failed", { error: describeError(error).message });
    throw error;
  }
}

/** Runs one swap for a user and records the result. Used by the strategy runner and by test trades. */
export async function tradeForUser(owner, { sell, amountIn, source }) {
  const { user, account } = await requireAccount(owner);
  const tokenIn = TOKENS[sell];
  if (!tokenIn) throw new HttpError(400, `The bot can only sell ${Object.keys(TOKENS).join(" or ")}.`);
  const tokenOut = otherToken(tokenIn.symbol);
  const delegation = user.botDelegation?.delegation;
  if (!delegation || !(await isBotDelegationLive(account, delegation))) throw new HttpError(400, "The bot is not enabled.");

  const base = { owner, account, tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol, amountIn, source };
  try {
    const soldToday = await trades.soldInLastDay(owner, tokenIn.symbol);
    const result = await executeSwap({ account, delegation, tokenIn, tokenOut, amountIn, soldToday });
    await trades.record({ ...base, minOut: result.minOut, amountOut: result.amountOut, gasFee: result.gasFee, txHash: result.txHash, status: "success" });
    return { ...result, tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol };
  } catch (error) {
    await trades.record({ ...base, status: "failed", error: describeError(error).message });
    throw error;
  }
}
