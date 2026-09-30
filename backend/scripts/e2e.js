// End-to-end proof on a local anvil node: a copy of BNB Chain (npm run e2e) or of BNB testnet
// after testnet setup (npm run e2e:testnet with RPC_URL pointing at the local copy).
//
// It plays a user through the whole flow over the real HTTP API, with the user sending and paying for
// every transaction from their own account. Then it uses the bot key directly to try to take money
// from the user's MetaMask smart account, and checks every attempt is blocked on-chain.
import assert from "node:assert/strict";
import { createExecution } from "@metamask/smart-accounts-kit";
import { encodeFunctionData, formatUnits, maxUint256, parseEther, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { erc20Abi, swapRouterAbi } from "../src/abis.js";
import { ADDRESSES, TOKENS, config } from "../src/config.js";
import { describeRevert } from "../src/errors.js";
import { GROUP, MM, accountOwner, encodeRedeem, withGroup } from "../src/metamask.js";
import { fundAddress, isLocalNode, publicClient, walletFor } from "./test-funds.js";

if (!(await isLocalNode())) {
  console.error(`The end-to-end proof only runs against a local anvil node. ${config.rpcUrl} is not one.`);
  process.exit(1);
}
// Any address that is not DEOD or USDT. The permission rejects it before the swap is even attempted.
const UNLISTED_TOKEN = "0x000000000000000000000000000000000000dEaD";

const API = process.env.API_URL || `http://localhost:${config.port}/api`;
const { DEOD, USDT } = TOKENS;
const BNB = config.nativeSymbol;
const { dailyGasCap: GAS_CAP, perTradeLimits, dailyLimits } = config.rules;
const results = [];
const fmt = (amount, digits = 4) => Number(formatUnits(BigInt(amount), 18)).toLocaleString("en-US", { maximumFractionDigits: digits });

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ""}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

let token;
async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json.error}`);
  return json;
}
const errorText = (error) => error.message.split(": ").slice(1).join(": ");

// The API sends bigints as strings. Signing needs the delegation salt back as a bigint.
const revive = (typedData) => ({ ...typedData, message: { ...typedData.message, salt: BigInt(typedData.message.salt) } });

const user = privateKeyToAccount(generatePrivateKey());
const userWallet = walletFor(user);
const bot = privateKeyToAccount(config.botPrivateKey);
const stranger = privateKeyToAccount(generatePrivateKey());

const balance = (tokenInfo, address) =>
  publicClient.readContract({ address: tokenInfo.address, abi: erc20Abi, functionName: "balanceOf", args: [address] });
const bnbOf = (address) => publicClient.getBalance({ address });

/** The user sends a wallet action from their own account, then the backend confirms it. */
let lastSent;
async function sendAction(body) {
  const action = await api("POST", "/wallet/actions", body);
  assert.equal(action.tx.to.toLowerCase(), MM.delegationManager.toLowerCase());
  const hash = await userWallet.sendTransaction({ to: action.tx.to, data: action.tx.data, value: BigInt(action.tx.value) });
  await publicClient.waitForTransactionReceipt({ hash });
  lastSent = { id: action.id, hash, tx: action.tx };
  return api("POST", `/wallet/actions/${action.id}/confirm`, { txHash: hash });
}

/** Simulates a DelegationManager call from `from` without changing anything. Returns why it was blocked, or throws if allowed. */
async function expectBlocked(items, from = bot.address) {
  try {
    await publicClient.call({ account: from, to: MM.delegationManager, data: encodeRedeem(items) });
  } catch (error) {
    return describeRevert(error) ?? error.shortMessage?.split("\n")[0];
  }
  throw new Error("This went through. It should have been blocked.");
}
async function expectAllowed(items) {
  await publicClient.call({ account: bot.address, to: MM.delegationManager, data: encodeRedeem(items) });
}

const swapExec = (overrides) =>
  createExecution({
    target: ADDRESSES.swapRouter,
    callData: encodeFunctionData({
      abi: swapRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: USDT.address,
          tokenOut: DEOD.address,
          fee: config.rules.poolFee,
          recipient: account,
          amountIn: parseUnits("1", 18),
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
          ...overrides,
        },
      ],
    }),
  });
const transferExec = (tokenInfo, to, amount) =>
  createExecution({ target: tokenInfo.address, callData: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) });
const approveExec = (tokenInfo, spender) =>
  createExecution({ target: tokenInfo.address, callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] }) });
const bnbExec = (to, value, callData = "0x") => createExecution({ target: to, value, callData });

let account;
let botDelegation;
let ownerDelegation;
let gasPaid = 0n;

/** Runs a test trade and checks the user's smart account paid its gas to the bot, in the same transaction. */
async function tradeAndCheckGas(sell, amount) {
  const [accountBefore, botBefore] = await Promise.all([bnbOf(account), bnbOf(bot.address)]);
  const r = await api("POST", "/bot/test-trade", { sell, amount });
  const receipt = await publicClient.getTransactionReceipt({ hash: r.txHash });
  const botSpent = receipt.gasUsed * receipt.effectiveGasPrice;
  const userPaid = accountBefore - (await bnbOf(account));
  const botKept = (await bnbOf(bot.address)) - botBefore;
  assert.ok(BigInt(r.amountOut) > 0n);
  assert.equal(userPaid, BigInt(r.gasFee), "the smart account should pay exactly the gas fee the bot reported");
  assert.equal(botKept, userPaid - botSpent);
  assert.ok(botKept >= 0n, "the bot should be paid back at least the gas it spent");
  gasPaid += userPaid;
  const other = sell === "USDT" ? "DEOD" : "USDT";
  return `got ${fmt(r.amountOut)} ${other}; user paid ${fmt(userPaid, 8)} ${BNB} for ${receipt.gasUsed} gas, bot spent ${fmt(botSpent, 8)} and was repaid in full`;
}

console.log(`Test user ${user.address}, bot ${bot.address}, API ${API}\n`);

await step(`Backend is running on ${config.chain.name}`, async () => {
  const cfg = await api("GET", "/config");
  assert.equal(cfg.network, config.networkName);
  assert.equal(cfg.botAddress, bot.address);
  assert.deepEqual(Object.keys(cfg.tokens), ["DEOD", "USDT"]);
});

await step("Fund the test user with BNB, USDT and DEOD", async () => {
  const b = await fundAddress(user.address);
  return `${fmt(b.USDT)} USDT, ${fmt(b.DEOD)} DEOD`;
});

await step("Sign in with Ethereum", async () => {
  const { nonce } = await api("GET", "/auth/nonce");
  const message = createSiweMessage({
    address: user.address,
    chainId: config.chain.id,
    domain: config.appDomain,
    nonce,
    uri: config.appOrigin,
    version: "1",
    statement: "Sign in to userDexBot.",
  });
  ({ token } = await api("POST", "/auth/verify", { message, signature: await user.signMessage({ message }) }));
  assert.ok(token);
});

await step("User creates their MetaMask smart account, pays the gas, and signs the owner permission", async () => {
  const bnbBefore = await publicClient.getBalance({ address: user.address });
  const created = await api("POST", "/wallet/create-tx");
  assert.equal(created.tx.to.toLowerCase(), MM.factory.toLowerCase());
  const hash = await userWallet.sendTransaction({ to: created.tx.to, data: created.tx.data });
  await publicClient.waitForTransactionReceipt({ hash });
  const signature = await user.signTypedData(revive(created.typedData));
  ownerDelegation = { ...created.ownerDelegation, signature };
  const { wallet } = await api("POST", "/wallet", { signature });
  account = wallet.account;
  assert.equal(account, created.account);
  assert.equal(await accountOwner(account), user.address);
  assert.equal(wallet.botEnabled, false);
  const paid = bnbBefore - (await publicClient.getBalance({ address: user.address }));
  assert.ok(paid > 0n, "the user should have paid gas");
  return `account ${account}, user paid ${fmt(paid)} BNB gas`;
});

await step("Recording the account again returns the same account", async () => {
  const again = await api("POST", "/wallet");
  assert.equal(again.wallet.account, account);
});

await step(`User deposits 500 USDT, 5,000 DEOD and 0.05 ${BNB} for gas`, async () => {
  for (const [tokenInfo, amount] of [[USDT, "500"], [DEOD, "5000"]]) {
    const hash = await userWallet.writeContract({
      address: tokenInfo.address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [account, parseUnits(amount, tokenInfo.decimals)],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  const hash = await userWallet.sendTransaction({ to: account, value: parseEther("0.05") });
  await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(await balance(USDT, account), parseUnits("500", 18));
  assert.equal(await bnbOf(account), parseEther("0.05"));
});

await step("A bot permission signed by a stranger is rejected", async () => {
  const request = await api("POST", "/bot/permission");
  const signature = await stranger.signTypedData(revive(request.typedData));
  try {
    await api("POST", `/bot/permission/${request.id}`, { signature });
  } catch (error) {
    return errorText(error);
  }
  throw new Error("A stranger's signature was accepted.");
});

await step("User enables the bot with one free signature, no transaction", async () => {
  const bnbBefore = await publicClient.getBalance({ address: user.address });
  const request = await api("POST", "/bot/permission");
  const signature = await user.signTypedData(revive(request.typedData));
  await api("POST", `/bot/permission/${request.id}`, { signature });
  botDelegation = { ...request.delegation, signature };
  const me = await api("GET", "/me");
  assert.equal(me.wallet.botEnabled, true);
  assert.equal(BigInt(me.wallet.gasBudgetLeftToday), GAS_CAP);
  assert.equal(await publicClient.getBalance({ address: user.address }), bnbBefore, "enabling should cost the user nothing");
  lastSent = { id: request.id, signature };
});

await step("Submitting the same permission twice is refused", async () => {
  try {
    await api("POST", `/bot/permission/${lastSent.id}`, { signature: lastSent.signature });
  } catch (error) {
    return errorText(error);
  }
  throw new Error("The same permission was accepted twice.");
});

await step(`Bot buys DEOD with 20 USDT, and the user's ${BNB} pays the gas in the same transaction`, () => tradeAndCheckGas("USDT", "20"));

await step(`Bot sells 1,000 DEOD for USDT, and the user's ${BNB} pays the gas`, () => tradeAndCheckGas("DEOD", "1000"));

await step("Gas budget and daily limits went down by exactly what was used", async () => {
  const me = await api("GET", "/me");
  assert.equal(BigInt(me.wallet.gasBudgetLeftToday), GAS_CAP - gasPaid);
  assert.equal(BigInt(me.wallet.remainingToday.USDT), dailyLimits.USDT - parseUnits("20", 18));
  assert.equal(BigInt(me.wallet.remainingToday.DEOD), dailyLimits.DEOD - parseUnits("1000", 18));
});

await step("The bot's own per-trade limit refuses an oversized trade (MetaMask rules can't cap trade size)", async () => {
  try {
    await api("POST", "/bot/test-trade", { sell: "USDT", amount: formatUnits(perTradeLimits.USDT + 1n, 18) });
  } catch (error) {
    return errorText(error);
  }
  throw new Error("The bot accepted an oversized trade.");
});

console.log("\nAttacks with the bot key directly, all of which must be blocked on-chain:");

await step(`Attack: send ${BNB} to anyone other than the bot`, () =>
  expectBlocked([{ delegation: withGroup(botDelegation, GROUP.GAS), execution: bnbExec(stranger.address, 1n) }]),
);

await step(`Attack: take more ${BNB} than is left in today's gas budget`, async () => {
  const left = GAS_CAP - gasPaid;
  assert.ok((await bnbOf(account)) > left, "the account must hold more than the budget, so only the permission can block it");
  await expectAllowed([{ delegation: withGroup(botDelegation, GROUP.GAS), execution: bnbExec(bot.address, left) }]);
  const reason = await expectBlocked([{ delegation: withGroup(botDelegation, GROUP.GAS), execution: bnbExec(bot.address, left + 1n) }]);
  return `the rest of the budget is allowed, 1 wei more: ${reason}`;
});

await step("Attack: use the gas rule to call a contract instead of a plain transfer", () =>
  expectBlocked([{ delegation: withGroup(botDelegation, GROUP.GAS), execution: bnbExec(bot.address, 1n, "0x12345678") }]),
);

await step("Attack: send USDT or DEOD anywhere", async () => {
  const reasons = [];
  for (const tokenInfo of [USDT, DEOD]) {
    for (const group of [GROUP.GAS, GROUP.APPROVE]) {
      reasons.push(await expectBlocked([{ delegation: withGroup(botDelegation, group), execution: transferExec(tokenInfo, bot.address, 1n) }]));
    }
  }
  return [...new Set(reasons)].join(" / ");
});

await step("Attack: approve someone other than the router", () =>
  expectBlocked([{ delegation: withGroup(botDelegation, GROUP.APPROVE), execution: approveExec(USDT, stranger.address) }]),
);

await step("Attack: swap with the output sent elsewhere", () =>
  expectBlocked([{ delegation: withGroup(botDelegation, GROUP.SELL_USDT), execution: swapExec({ recipient: stranger.address }) }]),
);

await step("Attack: swap through a different pool fee tier", () =>
  expectBlocked([{ delegation: withGroup(botDelegation, GROUP.SELL_USDT), execution: swapExec({ fee: 2500 }) }]),
);

await step("Attack: swap into a token that is not DEOD", () =>
  expectBlocked([{ delegation: withGroup(botDelegation, GROUP.SELL_USDT), execution: swapExec({ tokenOut: UNLISTED_TOKEN }) }]),
);

await step("Attack: swap using the approval permission group", () =>
  expectBlocked([{ delegation: withGroup(botDelegation, GROUP.APPROVE), execution: swapExec({}) }]),
);

await step("Attack: bot uses the owner's own permission", () =>
  expectBlocked([{ delegation: ownerDelegation, execution: transferExec(USDT, bot.address, 1n) }]),
);

await step("Attack: a stranger uses the bot's permission", () =>
  expectBlocked([{ delegation: withGroup(botDelegation, GROUP.GAS), execution: bnbExec(stranger.address, 1n) }], stranger.address),
);

console.log("\nUser controls:");

await step("User withdraws all USDT back to MetaMask and pays the gas", async () => {
  const before = await balance(USDT, user.address);
  const inAccount = await balance(USDT, account);
  await sendAction({ kind: "withdraw", token: "USDT", amount: "max" });
  assert.equal(await balance(USDT, account), 0n);
  assert.equal(await balance(USDT, user.address), before + inAccount);
  return `${fmt(inAccount)} USDT`;
});

await step("Confirming the same wallet action twice is refused", async () => {
  try {
    await api("POST", `/wallet/actions/${lastSent.id}/confirm`, { txHash: lastSent.hash });
  } catch (error) {
    return errorText(error);
  }
  throw new Error("The same action was confirmed twice.");
});

await step("A stranger cannot send the owner's withdrawal", async () => {
  try {
    await publicClient.call({ account: stranger.address, to: lastSent.tx.to, data: lastSent.tx.data });
  } catch (error) {
    return describeRevert(error) ?? error.shortMessage?.split("\n")[0];
  }
  throw new Error("A stranger was able to use the owner's permission.");
});

await step(`User withdraws all ${BNB} back to MetaMask`, async () => {
  const inAccount = await bnbOf(account);
  await sendAction({ kind: "withdraw", token: BNB, amount: "max" });
  assert.equal(await bnbOf(account), 0n);
  return `${fmt(inAccount, 6)} ${BNB}`;
});

await step(`Bot refuses to trade when the account has no ${BNB} for gas`, async () => {
  try {
    await api("POST", "/bot/test-trade", { sell: "DEOD", amount: "1" });
  } catch (error) {
    return errorText(error);
  }
  throw new Error("The bot traded without the user paying its gas.");
});

await step("User stops the bot with one transaction", async () => {
  await sendAction({ kind: "stop-bot" });
  const me = await api("GET", "/me");
  assert.equal(me.wallet.botEnabled, false);
});

await step("The bot's permission no longer works after being stopped", () =>
  expectBlocked([{ delegation: withGroup(botDelegation, GROUP.SELL_DEOD), execution: swapExec({ tokenIn: DEOD.address, tokenOut: USDT.address, amountIn: 1n }) }]),
);

await step("User withdraws all DEOD after stopping the bot", async () => {
  const inAccount = await balance(DEOD, account);
  await sendAction({ kind: "withdraw", token: "DEOD", amount: "max" });
  assert.equal(await balance(DEOD, account), 0n);
  return `${fmt(inAccount)} DEOD`;
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
