// End-to-end proof on a local anvil node: a copy of BNB Chain (npm run e2e) or of BNB testnet
// after testnet setup (npm run e2e:testnet with RPC_URL pointing at the local copy).
//
// It plays a user through the whole flow over the real HTTP API. The user sends every wallet
// transaction from their own account and pays its gas. Then it uses the bot key directly to try
// to take money from the wallet, and checks every attempt is blocked on-chain.
import assert from "node:assert/strict";
import { concat, encodeFunctionData, formatUnits, getAddress, pad, parseUnits, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { erc20Abi, rolesAbi, safeAbi, swapRouterAbi } from "../src/abis.js";
import { feeCollector } from "../src/chain.js";
import { ADDRESSES, TOKENS, config } from "../src/config.js";
import { describeRevert } from "../src/errors.js";
import { ROLE_KEY } from "../src/permissions.js";
import { fundAddress, isLocalNode, publicClient, walletFor } from "./test-funds.js";

if (!(await isLocalNode())) {
  console.error(`The end-to-end proof only runs against a local anvil node. ${config.rpcUrl} is not one.`);
  process.exit(1);
}
// Any address that is not DEOD or USDT. The rules reject it before the swap is even attempted.
const UNLISTED_TOKEN = "0x000000000000000000000000000000000000dEaD";

const API = process.env.API_URL || `http://localhost:${config.port}/api`;
const { DEOD, USDT } = TOKENS;
const FEE = config.rules.tradeFee;
const results = [];
const fmt = (amount) => Number(formatUnits(BigInt(amount), 18)).toLocaleString("en-US", { maximumFractionDigits: 4 });

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

const user = privateKeyToAccount(generatePrivateKey());
const userWallet = walletFor(user);
const bot = privateKeyToAccount(config.botPrivateKey);

// Safe accepts this signature when the owner sends execTransaction themselves.
const ownerSentSignature = (owner) => concat([pad(getAddress(owner)), pad("0x00"), "0x01"]);

/** The user sends a wallet action from their own account, then the backend confirms it. */
let lastSent;
async function sendAction(body, from = user) {
  const action = await api("POST", "/wallet/actions", body);
  const m = action.typedData.message;
  const hash = await walletFor(from).writeContract({
    address: wallet.safeAddress,
    abi: safeAbi,
    functionName: "execTransaction",
    args: [m.to, BigInt(m.value), m.data, Number(m.operation), 0n, 0n, 0n, zeroAddress, zeroAddress, ownerSentSignature(user.address)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  lastSent = { id: action.id, hash };
  return api("POST", `/wallet/actions/${action.id}/confirm`, { txHash: hash });
}

const balance = (tokenInfo, address) =>
  publicClient.readContract({ address: tokenInfo.address, abi: erc20Abi, functionName: "balanceOf", args: [address] });

/** Simulates a call as the bot key through the Roles module, without changing anything on-chain. */
const simulateAsBot = (roles, to, data) =>
  publicClient.simulateContract({
    account: bot,
    address: roles,
    abi: rolesAbi,
    functionName: "execTransactionWithRole",
    args: [to, 0n, data, 0, ROLE_KEY, true],
  });

/** Returns the revert reason, or throws if the bot's call went through. */
async function expectBlocked(roles, to, data) {
  try {
    await simulateAsBot(roles, to, data);
  } catch (error) {
    return describeRevert(error) ?? error.shortMessage;
  }
  throw new Error("The bot was able to do this. It should have been blocked.");
}

const transferData = (to, amount) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });

const swapData = (overrides) =>
  encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: USDT.address,
        tokenOut: DEOD.address,
        fee: config.rules.poolFee,
        recipient: wallet.safeAddress,
        amountIn: parseUnits("10", USDT.decimals),
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
        ...overrides,
      },
    ],
  });

let wallet;

console.log(`Test user ${user.address}, bot ${bot.address}, fee collector ${feeCollector}, API ${API}\n`);

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
  const signature = await user.signMessage({ message });
  ({ token } = await api("POST", "/auth/verify", { message, signature }));
  assert.ok(token);
});

await step("User creates the bot wallet from their own account and pays the gas", async () => {
  const bnbBefore = await publicClient.getBalance({ address: user.address });
  const { tx, safeAddress } = await api("POST", "/wallet/create-tx");
  const hash = await userWallet.sendTransaction({ to: tx.to, data: tx.data });
  await publicClient.waitForTransactionReceipt({ hash });
  ({ wallet } = await api("POST", "/wallet"));
  assert.equal(wallet.safeAddress, safeAddress);
  const [owners, threshold] = await Promise.all([
    publicClient.readContract({ address: wallet.safeAddress, abi: safeAbi, functionName: "getOwners" }),
    publicClient.readContract({ address: wallet.safeAddress, abi: safeAbi, functionName: "getThreshold" }),
  ]);
  assert.deepEqual(owners, [user.address]);
  assert.equal(threshold, 1n);
  assert.equal(wallet.botEnabled, false);
  const paid = bnbBefore - (await publicClient.getBalance({ address: user.address }));
  assert.ok(paid > 0n, "the user should have paid gas");
  return `Safe ${wallet.safeAddress}, user paid ${fmt(paid)} BNB gas`;
});

await step("Recording the wallet again returns the same wallet", async () => {
  const again = await api("POST", "/wallet");
  assert.equal(again.wallet.safeAddress, wallet.safeAddress);
});

await step("User deposits 500 USDT and 5,000 DEOD", async () => {
  for (const [tokenInfo, amount] of [[USDT, "500"], [DEOD, "5000"]]) {
    const hash = await userWallet.writeContract({
      address: tokenInfo.address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [wallet.safeAddress, parseUnits(amount, tokenInfo.decimals)],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  assert.equal(await balance(USDT, wallet.safeAddress), parseUnits("500", 18));
  assert.equal(await balance(DEOD, wallet.safeAddress), parseUnits("5000", 18));
});

await step("The bot has no rules module to act through before the user enables it", async () => {
  const code = await publicClient.getCode({ address: wallet.rolesAddress });
  assert.ok(!code || code === "0x");
});

await step("A stranger cannot send the owner's wallet action", async () => {
  const stranger = privateKeyToAccount(generatePrivateKey());
  const action = await api("POST", "/wallet/actions", { kind: "enable-bot" });
  const m = action.typedData.message;
  try {
    await publicClient.simulateContract({
      account: stranger,
      address: wallet.safeAddress,
      abi: safeAbi,
      functionName: "execTransaction",
      args: [m.to, BigInt(m.value), m.data, Number(m.operation), 0n, 0n, 0n, zeroAddress, zeroAddress, ownerSentSignature(user.address)],
    });
  } catch (error) {
    return describeRevert(error) ?? error.shortMessage?.split("\n")[0];
  }
  throw new Error("A stranger was able to act as the owner.");
});

await step("User enables the bot with one transaction and pays the gas", async () => {
  await sendAction({ kind: "enable-bot" });
  const me = await api("GET", "/me");
  assert.equal(me.wallet.botEnabled, true);
  assert.equal(BigInt(me.wallet.feeRemainingToday), config.rules.dailyFeeCap);
});

await step("Confirming the same action twice is refused", async () => {
  try {
    await api("POST", `/wallet/actions/${lastSent.id}/confirm`, { txHash: lastSent.hash });
  } catch (error) {
    return error.message.split(": ").slice(1).join(": ");
  }
  throw new Error("The same action was confirmed twice.");
});

await step(`Bot buys DEOD with 20 USDT and takes the ${fmt(FEE)} USDT network fee`, async () => {
  const collectorBefore = await balance(USDT, feeCollector);
  const r = await api("POST", "/bot/test-trade", { sell: "USDT", amount: "20" });
  assert.ok(BigInt(r.amountOut) > 0n);
  assert.equal((await balance(USDT, feeCollector)) - collectorBefore, FEE);
  return `got ${fmt(r.amountOut)} DEOD`;
});

await step(`Bot sells 1,000 DEOD for USDT and takes the ${fmt(FEE)} USDT network fee`, async () => {
  const collectorBefore = await balance(USDT, feeCollector);
  const r = await api("POST", "/bot/test-trade", { sell: "DEOD", amount: "1000" });
  assert.ok(BigInt(r.amountOut) > 0n);
  assert.equal((await balance(USDT, feeCollector)) - collectorBefore, FEE);
  return `got ${fmt(r.amountOut)} USDT`;
});

await step("Daily limits and fee budget went down by exactly what was used", async () => {
  const me = await api("GET", "/me");
  assert.equal(BigInt(me.wallet.remainingToday.USDT), config.rules.dailyLimits.USDT - parseUnits("20", 18));
  assert.equal(BigInt(me.wallet.remainingToday.DEOD), config.rules.dailyLimits.DEOD - parseUnits("1000", 18));
  assert.equal(BigInt(me.wallet.feeRemainingToday), config.rules.dailyFeeCap - 2n * FEE);
});

console.log("\nAttacks with the bot key, all of which must be blocked:");

const stranger = privateKeyToAccount(generatePrivateKey()).address;

await step("Attack: send USDT to anyone other than the fee collector", () =>
  expectBlocked(wallet.rolesAddress, USDT.address, transferData(stranger, parseUnits("0.01", 18))),
);

await step("Attack: take more fee than is left in today's fee budget", async () => {
  const left = config.rules.dailyFeeCap - 2n * FEE;
  await simulateAsBot(wallet.rolesAddress, USDT.address, transferData(feeCollector, left));
  const reason = await expectBlocked(wallet.rolesAddress, USDT.address, transferData(feeCollector, left + 1n));
  return `the rest of the budget is allowed, one unit more is ${reason}`;
});

await step("Attack: send DEOD anywhere", () =>
  expectBlocked(wallet.rolesAddress, DEOD.address, transferData(feeCollector, 1n)),
);

await step("Attack: approve someone else to spend USDT", () =>
  expectBlocked(wallet.rolesAddress, USDT.address, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [stranger, parseUnits("1", 18)] })),
);

await step("Attack: swap with the output sent elsewhere", () =>
  expectBlocked(wallet.rolesAddress, ADDRESSES.swapRouter, swapData({ recipient: stranger })),
);

await step("Attack: swap through a different pool fee tier", () =>
  expectBlocked(wallet.rolesAddress, ADDRESSES.swapRouter, swapData({ fee: 2500 })),
);

await step("Attack: swap into a token that is not DEOD or USDT", () =>
  expectBlocked(wallet.rolesAddress, ADDRESSES.swapRouter, swapData({ tokenOut: UNLISTED_TOKEN })),
);

await step("Attack: sell 1 unit more than what is left of the daily USDT limit", async () => {
  const remaining = config.rules.dailyLimits.USDT - parseUnits("20", 18);
  // The wallet holds more USDT than the limit, so only the limit can be what stops this.
  assert.ok((await balance(USDT, wallet.safeAddress)) > remaining + 1n);
  await simulateAsBot(wallet.rolesAddress, ADDRESSES.swapRouter, swapData({ amountIn: remaining }));
  const reason = await expectBlocked(wallet.rolesAddress, ADDRESSES.swapRouter, swapData({ amountIn: remaining + 1n }));
  return `exactly the limit is allowed, one more is ${reason}`;
});

await step("Attack: bot calls the Safe directly as if it were a module", async () => {
  try {
    await publicClient.simulateContract({
      account: bot,
      address: wallet.safeAddress,
      abi: [{ type: "function", name: "execTransactionFromModule", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }], outputs: [{ type: "bool" }] }],
      functionName: "execTransactionFromModule",
      args: [USDT.address, 0n, transferData(bot.address, 1n), 0],
    });
  } catch (error) {
    return describeRevert(error) ?? error.shortMessage?.replace(/\s+/g, " ");
  }
  throw new Error("The bot was able to do this. It should have been blocked.");
});

console.log("\nUser controls:");

await step("User withdraws all USDT back to their account and pays the gas", async () => {
  const before = await balance(USDT, user.address);
  const inWallet = await balance(USDT, wallet.safeAddress);
  await sendAction({ kind: "withdraw", token: "USDT", amount: "max" });
  assert.equal(await balance(USDT, wallet.safeAddress), 0n);
  assert.equal(await balance(USDT, user.address), before + inWallet);
  return `${fmt(inWallet)} USDT`;
});

await step("Bot refuses to sell DEOD when there is no USDT left for the fee", async () => {
  try {
    await api("POST", "/bot/test-trade", { sell: "DEOD", amount: "0.001" });
  } catch (error) {
    return error.message.split(": ").slice(1).join(": ");
  }
  throw new Error("The bot traded without being able to take its fee.");
});

await step("User stops the bot", async () => {
  await sendAction({ kind: "stop-bot" });
  const me = await api("GET", "/me");
  assert.equal(me.wallet.botEnabled, false);
});

await step("Bot cannot trade after being stopped", async () => {
  const reason = await expectBlocked(wallet.rolesAddress, ADDRESSES.swapRouter, swapData({ tokenIn: DEOD.address, tokenOut: USDT.address, amountIn: 1n }));
  return reason;
});

await step("User withdraws all DEOD back to their account", async () => {
  const inWallet = await balance(DEOD, wallet.safeAddress);
  await sendAction({ kind: "withdraw", token: "DEOD", amount: "max" });
  assert.equal(await balance(DEOD, wallet.safeAddress), 0n);
  return `${fmt(inWallet)} DEOD`;
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
