import { Router } from "express";
import { formatEther, parseUnits } from "viem";
import { issueNonce, linkWallet, logIn, requireAuth, requireWallet, signUp } from "./auth.js";
import { botAccount } from "./chain.js";
import { ADDRESSES, TOKENS, config } from "./config.js";
import { toJson, trades, users, walletActions } from "./db.js";
import { HttpError } from "./errors.js";
import { MM } from "./metamask.js";
import { automaticTrading } from "./strategy/runner.js";
import {
  confirmEnableBot,
  confirmWalletAction,
  getBalances,
  getWalletInfo,
  prepareCreateWallet,
  prepareEnableBot,
  prepareWalletAction,
  syncBotWallet,
  tradeForUser,
} from "./wallets.js";

export const router = Router();

// Bigints go out as decimal strings.
const send = (res, body) => res.type("json").send(toJson(body));
const isHex32 = (value) => /^0x[0-9a-fA-F]{64}$/.test(value ?? "");
const isSignature = (value) => /^0x[0-9a-fA-F]{130,}$/.test(value ?? "");

router.get("/health", (_req, res) => res.json({ ok: true }));

router.get("/config", (_req, res) => {
  const { DEOD, USDT } = TOKENS;
  const amount = (value) => Number(value / 10n ** 14n) / 10_000;
  send(res, {
    network: config.networkName,
    chain: {
      id: config.chain.id,
      name: config.chain.name,
      nativeCurrency: config.chain.nativeCurrency,
      rpcUrls: config.chain.rpcUrls.default.http,
      explorer: config.explorer,
    },
    tokens: TOKENS,
    nativeSymbol: config.nativeSymbol,
    contracts: { ...ADDRESSES, delegationManager: MM.delegationManager },
    botAddress: botAccount.address,
    limits: { perTrade: config.rules.perTradeLimits, daily: config.rules.dailyLimits },
    gas: { dailyCap: config.rules.dailyGasCap, repaidTo: botAccount.address },
    rules: {
      allowed: [
        `Swap between DEOD and USDT on PancakeSwap, in the ${config.rules.poolFee / 10_000}% fee pool only.`,
        "Every swap sends its output back to your smart account.",
        "Approve DEOD and USDT for the PancakeSwap router only.",
        `Sell at most ${amount(config.rules.perTradeLimits.DEOD).toLocaleString("en-US")} DEOD or ${amount(config.rules.perTradeLimits.USDT).toLocaleString("en-US")} USDT per trade. This size limit is checked by the bot, not by the blockchain.`,
        `Pay each trade's gas from the ${config.nativeSymbol} in your smart account, never more than ${formatEther(config.rules.dailyGasCap)} ${config.nativeSymbol} per day.`,
      ],
      blocked: [
        `Withdraw or transfer funds anywhere, apart from the capped ${config.nativeSymbol} for its own gas.`,
        "Trade any other token, or use any other exchange or pool.",
        "Keep trading after you stop it.",
      ],
    },
    testTradesEnabled: config.enableTestTrades,
    automaticTrading,
    tokensUsed: [DEOD.symbol, USDT.symbol],
  });
});

// Username and password login.
router.post("/auth/signup", async (req, res) => res.json(await signUp(req.body)));
router.post("/auth/login", async (req, res) => res.json(await logIn(req.body, req.ip)));

// Linking MetaMask to the login: a one-time message to sign, then the signature.
router.get("/auth/nonce", async (_req, res) => res.json({ nonce: await issueNonce() }));
router.post("/auth/link-wallet", requireAuth, async (req, res) => res.json(await linkWallet(req.user, req.body)));

// Everything below acts on the MetaMask linked to the login.
const withWallet = [requireAuth, requireWallet];

router.get("/me", requireAuth, async (req, res) => {
  const { username, address: owner } = req.user;
  if (!owner) return send(res, { username, address: null, ownerBalances: null, wallet: null, actions: [], trades: [] });
  const [ownerBalances, user, actions, recentTrades] = await Promise.all([
    getBalances(owner),
    users.get(owner),
    walletActions.recent(owner),
    trades.recent(owner),
  ]);
  send(res, { username, address: owner, ownerBalances, wallet: await getWalletInfo(user), actions, trades: recentTrades });
});

// Creating the smart account, step 1: the transaction to send and the owner permission to sign.
router.post("/wallet/create-tx", withWallet, async (req, res) => {
  send(res, await prepareCreateWallet(req.user.address));
});

// Step 2: after the transaction is mined, record the account with the signed owner permission.
router.post("/wallet", withWallet, async (req, res) => {
  const { signature } = req.body ?? {};
  if (signature && !isSignature(signature)) throw new HttpError(400, "Invalid signature.");
  const user = await syncBotWallet(req.user.address, signature);
  send(res, { wallet: await getWalletInfo(user) });
});

// Enabling the bot: the permission to sign, then the signature. No transaction and no gas.
router.post("/bot/permission", withWallet, async (req, res) => {
  send(res, await prepareEnableBot(req.user.address));
});

router.post("/bot/permission/:id", withWallet, async (req, res) => {
  const { signature } = req.body ?? {};
  if (!isSignature(signature)) throw new HttpError(400, "Missing signature.");
  send(res, await confirmEnableBot(req.user.address, req.params.id, signature));
});

// Stop and withdraw: a transaction the user sends from MetaMask, then confirms here.
router.post("/wallet/actions", withWallet, async (req, res) => {
  send(res, await prepareWalletAction(req.user.address, req.body ?? {}));
});

router.post("/wallet/actions/:id/confirm", withWallet, async (req, res) => {
  const { txHash } = req.body ?? {};
  if (!isHex32(txHash)) throw new HttpError(400, "Missing transaction hash.");
  send(res, await confirmWalletAction(req.user.address, req.params.id, txHash));
});

// Lets you trigger one swap by hand while the real strategy is being built.
router.post("/bot/test-trade", withWallet, async (req, res) => {
  if (!config.enableTestTrades) throw new HttpError(403, "Test trades are turned off.");
  const { sell, amount } = req.body ?? {};
  const token = TOKENS[sell];
  if (!token) throw new HttpError(400, `Choose ${Object.keys(TOKENS).join(" or ")} to sell.`);
  const amountIn = parseUnits(String(amount ?? ""), token.decimals);
  if (amountIn <= 0n) throw new HttpError(400, "Enter an amount greater than zero.");
  send(res, await tradeForUser(req.user.address, { sell, amountIn, source: "test" }));
});
