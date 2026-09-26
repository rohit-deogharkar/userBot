import { Router } from "express";
import { parseUnits } from "viem";
import { issueNonce, requireAuth, verifyLogin } from "./auth.js";
import { botAccount } from "./chain.js";
import { ADDRESSES, TOKENS, config } from "./config.js";
import { toJson, trades, users, walletActions } from "./db.js";
import { HttpError } from "./errors.js";
import { rulesSummary } from "./permissions.js";
import { createBotWallet, executeWalletAction, getBalances, getWalletInfo, prepareWalletAction, tradeForUser } from "./wallets.js";

export const router = Router();

// Bigints go out as decimal strings.
const send = (res, body) => res.type("json").send(toJson(body));

router.get("/health", (_req, res) => res.json({ ok: true }));

router.get("/config", (_req, res) =>
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
    contracts: ADDRESSES,
    botAddress: botAccount.address,
    rules: rulesSummary(),
    dailyLimits: config.rules.dailyLimits,
    testTradesEnabled: config.enableTestTrades,
  }),
);

router.get("/auth/nonce", async (_req, res) => res.json({ nonce: await issueNonce() }));

router.post("/auth/verify", async (req, res) => {
  const { message, signature } = req.body ?? {};
  if (!message || !signature) throw new HttpError(400, "Missing sign-in message or signature.");
  res.json(await verifyLogin(message, signature));
});

router.get("/me", requireAuth, async (req, res) => {
  const owner = req.user.address;
  const [ownerBalances, user, actions, recentTrades] = await Promise.all([
    getBalances(owner),
    users.get(owner),
    walletActions.recent(owner),
    trades.recent(owner),
  ]);
  send(res, { address: owner, ownerBalances, wallet: await getWalletInfo(user), actions, trades: recentTrades });
});

router.post("/wallet", requireAuth, async (req, res) => {
  const user = await createBotWallet(req.user.address);
  send(res, { wallet: await getWalletInfo(user) });
});

router.post("/wallet/actions", requireAuth, async (req, res) => {
  send(res, await prepareWalletAction(req.user.address, req.body ?? {}));
});

router.post("/wallet/actions/:id/execute", requireAuth, async (req, res) => {
  const { signature } = req.body ?? {};
  if (!signature) throw new HttpError(400, "Missing signature.");
  send(res, await executeWalletAction(req.user.address, req.params.id, signature));
});

// Lets you trigger one swap by hand while the real strategy is being built.
router.post("/bot/test-trade", requireAuth, async (req, res) => {
  if (!config.enableTestTrades) throw new HttpError(403, "Test trades are turned off.");
  const { sell, amount } = req.body ?? {};
  const token = TOKENS[sell];
  if (!token) throw new HttpError(400, `Choose ${Object.keys(TOKENS).join(" or ")} to sell.`);
  const amountIn = parseUnits(String(amount ?? ""), token.decimals);
  if (amountIn <= 0n) throw new HttpError(400, "Enter an amount greater than zero.");
  send(res, await tradeForUser(req.user.address, { sell, amountIn, source: "test" }));
});
