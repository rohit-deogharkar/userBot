# userDexBot

An automated trading bot for **DEOD/USDT on BNB Chain**. Trades go through the DEOD/USDT pool on PancakeSwap v3.

- **Users never hand over their private key.** It stays in MetaMask.
- **Nobody can take user funds,** not the bot, our servers or our team. The blockchain enforces it.
- **Users pay all gas,** including the gas for the bot's trades.
- **The bot keeps trading when the user logs out,** until the user stops it.

## How it works

Each user gets a **bot wallet**: a [Safe](https://safe.global) smart wallet whose only owner is their MetaMask. The bot gets a **trade-only permission** through a [Zodiac Roles](https://docs.roles.gnosisguild.org) module attached to that wallet. The blockchain checks every bot transaction against the rules.

```
User's MetaMask ──owns──▶ Bot wallet (Safe) ◀──trade-only key── Our bot server
  create, deposit,          holds trading funds,     runs the strategy,
  enable, stop, withdraw    enforces the rules       holds no user keys
```

The bot runs on the server, not in the browser. Whether the user is logged in makes no difference. It only stops when the user sends "Stop bot" from MetaMask, which switches the rules module off on-chain.

## Who pays gas

| Action | Sent by | Paid by |
|---|---|---|
| Create bot wallet, deposit, enable bot, stop bot, withdraw | The user, from MetaMask | The user, in BNB |
| Each bot trade | The bot key | The user: the bot takes a flat USDT fee per trade from the bot wallet |

The per-trade fee repays the bot's gas. It defaults to 0.02 USDT, and the on-chain rules cap it at 1 USDT per day, so the bot can never take more. Both are settings. Trade gas on BNB Chain is about one cent.

## What the bot can and cannot do

The rules live in [backend/src/permissions.js](backend/src/permissions.js) and are written on-chain when the user enables the bot.

| The bot can | The bot can never |
|---|---|
| Swap DEOD and USDT on PancakeSwap v3, in the 1% DEOD/USDT pool only | Withdraw or transfer funds, apart from the capped fee |
| Send swap output back to the bot wallet only | Trade other tokens, pools or exchanges |
| Approve DEOD and USDT for the PancakeSwap router only | Change the rules, add modules or change the owner |
| Sell up to a daily limit per token | Act at all after the user stops it |
| Take the per-trade fee in USDT, up to the daily fee cap | |

## Keys

| Key | Where it lives | Who can see it |
|---|---|---|
| User's key | The user's MetaMask | Only the user. The app never asks for it. |
| Bot key, production | AWS KMS, set with `BOT_KMS_KEY_ID` | Nobody. KMS creates it inside its hardware and never exports it. |
| Bot key, development | `BOT_PRIVATE_KEY` in `.env` | Whoever has the file. Use only for local and testnet testing. |
| Deployer key | `DEPLOYER_PRIVATE_KEY` in `.env.testnet` | Testnet setup scripts only. The running app never uses it. |

To use KMS, create a key with key spec `ECC_SECG_P256K1` and usage `SIGN_VERIFY`. Give the server's IAM role only `kms:Sign` and `kms:GetPublicKey` on it. Then set `BOT_KMS_KEY_ID` and `AWS_REGION`, and remove `BOT_PRIVATE_KEY`. Even with a leaked or misused bot key, the rules above still apply.

`npm run test:kms` checks the KMS signer without an AWS account. A stand-in behaves like KMS, and the test confirms messages and transactions verify and that a real node accepts them.

## Project layout

```
backend/    Node.js + Express API and the bot
  src/config.js        Networks, trading pair, contract addresses, rules and fees
  src/safe.js          Bot wallet transactions and on-chain confirmation
  src/roles.js         The "enable bot" and "stop bot" transactions
  src/permissions.js   The trade-only rules
  src/bot.js           Quotes, swaps and the per-trade fee
  src/kms.js           Bot key signer backed by AWS KMS
  src/db.js            MongoDB: users, walletActions, trades, loginNonces
  src/strategy/        Where the trading strategy plugs in (currently empty)
  scripts/e2e.js       End-to-end proof, including theft attempts
  scripts/fund.js      Gives a test address USDT and DEOD (and BNB on local nodes)
  scripts/testnet-setup.js  One-time setup of BNB testnet
  scripts/test-kms.js  KMS signer test
  testnet/             Test USDT contract and the saved testnet addresses
frontend/   React (Vite) app
  src/lib/verifySafeTx.js  Checks every wallet transaction before MetaMask opens
```

## Test on BNB testnet

This uses the real public BNB testnet and your real MetaMask. BNB testnet is missing three things the bot needs, so a one-time setup creates them:

- **Zodiac Roles 2.1.1,** copied byte for byte from BNB Chain.
- **A test USDT** that anyone can mint.
- **A DEOD/USDT pool** on PancakeSwap v3 testnet at the 1% fee tier, priced at about 0.02 USDT per DEOD. Test DEOD is `0x3fb98B9DaebFdaA06b72Df9704aDe353500e7CFf`.

Steps, all run in `backend`:

1. **Fund the deployer.** In MetaMask on BNB Smart Chain Testnet, send 0.1 test BNB to the deployer address. `npm run testnet:setup` prints it if it's empty. The setup costs about 0.03 test BNB, including 0.02 it gives the bot key for trade gas.
2. **Run the setup once:** `npm run testnet:setup`. It's safe to run again.
3. **Start the backend on testnet:** `npm run dev:testnet`. Stop any other backend on port 4000 first.
4. **Get test USDT:** `npm run fund:testnet -- 0xYourMetaMaskAddress`
5. **Open http://localhost:5173** with MetaMask on BNB Smart Chain Testnet. Import the test USDT address from `backend/testnet/deployment.json` to see it in MetaMask.

## Run on a local copy of BNB Chain

This uses the real mainnet contracts with fake money, and needs Foundry's `anvil`. On Windows, unzip the `foundry_stable_win32_amd64.zip` release from [Foundry's GitHub releases](https://github.com/foundry-rs/foundry/releases).

1. `anvil --fork-url https://bsc-mainnet.public.blastapi.io --chain-id 561337`. The fork URL must serve historical state, and Blast API and `https://api.zan.top/bsc-mainnet` do.
2. In `backend`: `npm install`, copy `.env.example` to `.env`, set `JWT_SECRET`, then `npm run dev`.
3. Proof: `npm run e2e`
4. In `frontend`: `npm install`, then `npm run dev`.
5. Test funds: `npm run fund -- 0xYourMetaMaskAddress`

## What the proof checks

`npm run e2e` runs on a local anvil node. It plays a user through the real API, with the user sending and paying for every wallet transaction, then attacks the wallet with the bot key:

- **The user's side.** Create the wallet, deposit and enable the bot, all from the user's own account.
- **Stranger blocked.** A stranger cannot send the owner's wallet actions.
- **Trades and fees.** Two trades, each taking exactly the per-trade fee. Daily limits and the fee budget go down by exactly what was used.
- **Theft attempts blocked.** The bot key can't send USDT to anyone but the fee collector, or exceed the fee cap by one unit. It can't send DEOD at all, approve others, redirect swap output, use another pool or token, exceed a trading limit, or call the wallet directly.
- **No free trades.** The bot won't trade when it can't collect its fee.
- **The user stays in control.** The user withdraws everything and stops the bot, after which the bot can't trade.

## Configuration

Settings are in `backend/.env` for the local copy and `backend/.env.testnet` for testnet. The example files describe each one.

| Variable | Purpose |
|---|---|
| `NETWORK` | `bsc-fork`, `bsc-testnet` or `bsc` |
| `MONGODB_URI`, `MONGODB_DB` | MongoDB connection. The database defaults to `userdexbot_<network>`. |
| `BOT_KMS_KEY_ID` or `BOT_PRIVATE_KEY` | The bot's trade-only key. Use KMS in production. |
| `DEPLOYER_PRIVATE_KEY` | Testnet setup and test funding only |
| `TRADE_FEE_USDT`, `DAILY_FEE_CAP_USDT`, `FEE_COLLECTOR` | Per-trade fee, its daily cap, and where fees go. By default fees go to the bot's address. |
| `POOL_FEE`, `DAILY_LIMIT_DEOD`, `DAILY_LIMIT_USDT`, `SLIPPAGE_BPS` | Trading rules and limits |
| `ENABLE_TEST_TRADES` | Shows a manual "test trade" button. Turn off in production. |
| `STRATEGY_ENABLED`, `STRATEGY_INTERVAL_MS` | Automatic strategy loop |

## API

| Method and path | What it does |
|---|---|
| `GET /api/config` | Network, tokens, bot address, rules and fees |
| `GET /api/auth/nonce`, `POST /api/auth/verify` | Sign-In with Ethereum |
| `GET /api/me` | Balances, bot status, limits and fee budget left, recent activity |
| `POST /api/wallet/create-tx` | The transaction the user sends to create their bot wallet |
| `POST /api/wallet` | Records the bot wallet once it exists on-chain |
| `POST /api/wallet/actions` | Builds an enable, stop or withdraw transaction for the user to send |
| `POST /api/wallet/actions/:id/confirm` | Checks the user's transaction on-chain and records it |
| `POST /api/bot/test-trade` | Makes one swap now. Development only. |

## Adding the trading strategy

Write it in [backend/src/strategy/strategy.js](backend/src/strategy/strategy.js). The `decide` function gets each active user's balances and remaining daily limits, and returns either nothing or one swap to make. Set `STRATEGY_ENABLED=true` to run it on a timer for every user whose bot is on, whether they're logged in or not.

## Before going to production

1. **Bot key in KMS.** Set `BOT_KMS_KEY_ID` and remove `BOT_PRIVATE_KEY`. Keep a small BNB balance on the bot address for trade gas and alert when it runs low. The fees it collects in USDT repay that gas.
2. **Rule check in the browser.** The frontend checks wallet creation, withdraw and stop exactly. For "enable bot" it checks which contracts and functions the rules cover, but not each rule's conditions. Rebuild the expected rules in the browser and compare them exactly.
3. **Frontend hosting.** Host the frontend separately from the API with locked-down deployments.
4. **Sessions.** Move the login token from browser storage to an httpOnly cookie.
5. **Database.** Use a managed MongoDB deployment with authentication, TLS and backups.
6. **Outside review.** Get the rules and the integration reviewed by a smart-contract auditor.
7. **Legal review.** Confirm obligations for an automated trading service in your market.
8. **Thin liquidity.** The DEOD/USDT pool held about $69,000 when this was built. Keep daily limits small.
9. **Launch settings.** Set `NETWORK=bsc`, use a paid RPC provider, and turn off test trades.

## Known limitations

- Only DEOD and USDT, one PancakeSwap v3 pool, and one set of limits and fees for every user.
- BNB sent to a bot wallet can be withdrawn but is not traded.
- The fee is paid in USDT. Sales of DEOD pay it from their proceeds, so a sale worth less than the fee is refused.
- Users can lose money through bad trades. The rules stop theft, not losses.
