# userDexBot

An automated trading bot for **DEOD/USDT on BNB Chain**, built on **MetaMask Smart Accounts**. Trades go through the DEOD/USDT pool on PancakeSwap v3.

- **Users never hand over their private key.** It stays in MetaMask.
- **Nobody can take user funds,** not the bot, our servers or our team. The blockchain enforces it.
- **Users pay all gas,** including the gas for the bot's trades, in BNB from their smart account.
- **The bot keeps trading when the user logs out,** until the user stops it.

## How it works

Each user gets a **MetaMask smart account** (a Hybrid DeleGator from MetaMask's Smart Accounts Kit) whose only owner is their MetaMask. It holds only the funds they deposit for trading. The user signs the bot a **delegation**: a MetaMask permission with rules (caveats) that the blockchain checks on every bot transaction.

```
User's MetaMask ──owns──▶ MetaMask smart account ◀──signed permission── Our bot server
  create, deposit,          holds trading funds,        runs the strategy,
  enable, stop, withdraw    rules checked on-chain      holds no user keys
```

| User action | What MetaMask asks for | Gas |
|---|---|---|
| Create a login, or log in | Nothing. A username and password on our site. | None |
| Link MetaMask to the login | One free signature, the first time only | None |
| Create smart account | One transaction, plus one free signature (the owner permission) | User pays |
| Deposit | One transfer: DEOD or USDT to trade, or a little BNB for the bot's gas | User pays |
| Enable bot | One free signature (the bot's permission). No transaction. | None |
| Stop bot | One transaction. It bumps the account's nonce, which cancels every bot permission at once. | User pays |
| Withdraw | One transaction, through the owner permission | User pays |

The bot runs on the server, not in the browser, so it keeps trading while the user is logged out. It stops only when the user sends "Stop bot".

## Logins

Users log in with a username and password, then link their MetaMask once. Linking is a signed message (Sign-In with Ethereum). Without it, anyone could claim someone else's wallet address and trigger trades on it. Each login links one MetaMask, each MetaMask belongs to one login, and the link can't be changed.

The login only identifies the user to this app. It gives no access to funds: deposits, withdrawals, and enabling or stopping the bot all still need MetaMask's own confirmation. If the MetaMask in the browser is on a different account than the linked one, the page says so and waits.

Passwords are stored only as salted scrypt hashes. Ten wrong passwords for one username from one IP address lock that combination out for 15 minutes. The code is in [backend/src/auth.js](backend/src/auth.js).

## What the bot can and cannot do

The rules live in [backend/src/metamask.js](backend/src/metamask.js). The user signs them once as a single permission with four rule groups, and each bot transaction picks the group it needs.

**Enforced on-chain by the signed permission:**

| The bot can | The bot can never |
|---|---|
| Swap DEOD and USDT on PancakeSwap v3, in the 1% DEOD/USDT pool only | Withdraw or transfer funds, apart from the capped gas repayment |
| Send swap output back to the smart account only | Trade other tokens, pools or exchanges |
| Approve DEOD and USDT for the PancakeSwap router only | Approve anyone else |
| Repay its own gas in BNB, sent only to the bot's address, up to the daily gas cap | Keep trading after the user stops it |

**Enforced by the bot's own code, not on-chain:** the per-trade limit and daily sell limit. MetaMask's permission rules can't cap swap sizes: its balance-change rule reverts whenever an account holds less than the cap. A stolen or misused bot key therefore can't withdraw funds. It could make bad trades inside the pinned pool, and take up to the daily gas cap in BNB from each account. Keep the bot key in KMS and deposits modest.

## Who pays gas

Users pay for their own transactions in BNB from MetaMask. They also pay for the bot's trades, from BNB they deposit into their smart account next to their DEOD and USDT.

On BNB Chain, whoever sends a transaction pays its gas. The bot sends the trades while the user is offline, so it pays the gas first. **In the same transaction as the swap**, the smart account pays the bot back in BNB: the trade's gas estimate times the gas price the transaction pays. A trade can't happen without its repayment. The bot therefore needs only a small float of BNB to send trades, which each trade refills.

A trade uses about 1.2 to 1.7 million gas: about 0.0001 BNB at BNB Chain's usual 0.05 gwei, or 0.0002 test BNB on testnet. The signed permission caps what the bot can take at `DAILY_GAS_CAP_BNB` per day (default 0.005 BNB), and only to the bot's own address. If the smart account has no BNB, the bot doesn't trade.

The platform charges nothing on top of gas. A platform fee would be a separate rule in the permission.

## Keys

| Key | Where it lives | Who can see it |
|---|---|---|
| User's key | The user's MetaMask | Only the user. The app never asks for it. |
| Bot key, production | AWS KMS, set with `BOT_KMS_KEY_ID` | Nobody. KMS creates it inside its hardware and never exports it. |
| Bot key, development | `BOT_PRIVATE_KEY` in `.env` | Whoever has the file. Use only for local and testnet testing. |
| Deployer key | `DEPLOYER_PRIVATE_KEY` in `.env.testnet` | Testnet setup scripts only. The running app never uses it. |

To use KMS, create a key with key spec `ECC_SECG_P256K1` and usage `SIGN_VERIFY`, give the server's IAM role only `kms:Sign` and `kms:GetPublicKey`, set `BOT_KMS_KEY_ID` and `AWS_REGION`, and remove `BOT_PRIVATE_KEY`. `npm run test:kms` checks the KMS signer without an AWS account.

## The browser's safety check

Before MetaMask opens, [frontend/src/lib/verifyMetaMask.js](frontend/src/lib/verifyMetaMask.js) rebuilds each item from MetaMask's own contract registry and hard-coded token addresses, not from the backend:

- **Smart account creation:** must match the standard MetaMask smart account owned only by the user.
- **Owner permission:** must match exactly.
- **Bot permission:** must match exactly, apart from the daily gas cap. That is read from the permission itself and shown to the user. Gas repayments must go to the bot's own address.
- **Stop and withdraw:** must use the user's own permission, and withdrawals must go only to their MetaMask.

## Project layout

```
backend/    Node.js + Express API and the bot
  src/config.js        Networks, trading pair, contract addresses, limits and the gas cap
  src/metamask.js      Smart accounts, the owner and bot permissions, and transaction encoding
  src/bot.js           Quotes, swaps and the gas repayment, as one transaction
  src/wallets.js       Account creation, enable, stop, withdraw and trades
  src/auth.js          Username and password logins, and linking MetaMask
  src/kms.js           Bot key signer backed by AWS KMS
  src/db.js            MongoDB: members (logins), users (smart accounts), walletActions, trades, loginNonces
  src/strategy/        Automatic trading: the runner, and a random test strategy
  scripts/e2e.js       End-to-end proof, including theft attempts
  scripts/fund.js      Gives a test address USDT and DEOD (and BNB on local nodes)
  scripts/testnet-setup.js  One-time setup of BNB testnet
  testnet/             Test USDT contract and the saved testnet addresses
frontend/   React (Vite) app
  src/lib/verifyMetaMask.js  Checks everything before MetaMask opens
```

## Test on BNB testnet

MetaMask's Smart Accounts contracts already exist on BNB testnet. A one-time setup creates what's missing: a test USDT anyone can mint, and a DEOD/USDT pool on PancakeSwap v3 testnet at the 1% fee tier with test liquidity. Test DEOD is `0x3fb98B9DaebFdaA06b72Df9704aDe353500e7CFf`.

**To test from the browser,** run `npm run testnet` in the project folder. It starts the server and the website together. When it prints "Ready", open http://localhost:5173 with MetaMask on BNB Smart Chain Testnet. Keep the window open, and press Ctrl+C to stop both.

One-time steps, in `backend`, only when needed:

1. **Fund the deployer and run the setup once.** Skip this if `backend/testnet/deployment.json` already lists a `usdt` and a `pool`. Send about 0.1 test BNB to the deployer address that the setup prints, then run `npm run testnet:setup`.
2. **Get test USDT,** only to test with USDT: `npm run fund:testnet -- 0xYourMetaMaskAddress`

In the website, after creating the smart account, deposit some DEOD or USDT plus about 0.01 test BNB for the bot's gas. The bot key needs its own small float of test BNB to send trades. The setup gives it 0.02, and each trade pays it back.

## Run on a local copy of BNB Chain

This uses the real mainnet contracts with fake money, and needs Foundry's `anvil`.

1. `anvil --fork-url https://bsc-mainnet.public.blastapi.io --chain-id 561337`. The fork URL must serve historical state, and Blast API and `https://api.zan.top/bsc-mainnet` do.
2. In `backend`: `npm install`, copy `.env.example` to `.env`, set `JWT_SECRET`, then `npm run dev`.
3. Proof: `npm run e2e`
4. In `frontend`: `npm install`, then `npm run dev`.
5. Test funds: `npm run fund -- 0xYourMetaMaskAddress`

## What the proof checks

`npm run e2e` runs on a local anvil node, against a copy of BNB Chain or of BNB testnet. It plays a user through the real API, with the user sending and paying for every transaction, then attacks with the bot key:

- **Logins.** The user creates a login and logs in. A taken username and a wrong password are refused. Wallet actions are refused until MetaMask is linked. A stranger's signature can't link the user's MetaMask, and a second login can't link it either.
- **Setup.** The user links MetaMask with one signature, creates the smart account, signs the owner permission, deposits DEOD, USDT and BNB, and enables the bot with one free signature. A stranger's signature and a reused permission are both refused.
- **Trades and gas.** Two trades. In each, the user's BNB repays the bot's gas in the same transaction, and the bot ends up repaid in full. The gas budget and daily limits go down by exactly what was used.
- **Theft attempts blocked on-chain.** The bot key can't:
  - send BNB anywhere but its own address, go 1 wei over the daily gas cap, or attach call data to the repayment;
  - send USDT or DEOD at all;
  - approve anyone but the router;
  - redirect swap output, or use another pool or token;
  - use the owner's permission.
  A stranger can't use the bot's permission or the owner's withdrawal.
- **No unpaid trades.** After the user withdraws their BNB, the bot refuses to trade.
- **User control.** The user withdraws everything and stops the bot, after which the bot's permission no longer works.

On a local copy of BNB Chain, the development bot key is anvil's public test key. Someone has attached a sweeper contract to its address on the real chain (EIP-7702), which would forward away gas repayments. Test funding clears it on local copies, and the backend warns at startup if the bot's address has any contract attached.

## Configuration

Settings are in `backend/.env` for the local copy and `backend/.env.testnet` for testnet.

| Variable | Purpose |
|---|---|
| `NETWORK` | `bsc-fork`, `bsc-testnet` or `bsc` |
| `MONGODB_URI`, `MONGODB_DB` | MongoDB connection. The database defaults to `userdexbot_<network>`. |
| `BOT_KMS_KEY_ID` or `BOT_PRIVATE_KEY` | The bot's key. Use KMS in production. |
| `DEPLOYER_PRIVATE_KEY` | Testnet setup and test funding only |
| `DAILY_GAS_CAP_BNB` | The most BNB the bot may take per day from a smart account to repay its gas. Enforced on-chain by the permission. |
| `PER_TRADE_LIMIT_DEOD`, `PER_TRADE_LIMIT_USDT`, `DAILY_LIMIT_DEOD`, `DAILY_LIMIT_USDT` | Trade size limits, checked by the bot |
| `POOL_FEE`, `SLIPPAGE_BPS` | Pool fee tier and maximum slippage |
| `ENABLE_TEST_TRADES` | Shows a manual "test trade" button. Turn off in production. |
| `STRATEGY_ENABLED`, `STRATEGY_INTERVAL_MS` | Automatic trading, and how often it trades. On in `.env.testnet` (every 2 minutes), off in `.env`. Turn it off to run the proof. |

## API

| Method and path | What it does |
|---|---|
| `GET /api/config` | Network, tokens, bot address, rules, limits and the gas cap |
| `POST /api/auth/signup`, `POST /api/auth/login` | Create a login, or log in, with a username and password |
| `GET /api/auth/nonce`, `POST /api/auth/link-wallet` | Link MetaMask to the login with a signed message (Sign-In with Ethereum) |
| `GET /api/me` | Balances, bot status, limits and gas budget left, recent activity |
| `POST /api/wallet/create-tx` | The smart account creation transaction and the owner permission to sign |
| `POST /api/wallet` | Records the smart account with the signed owner permission |
| `POST /api/bot/permission` | The bot permission for the user to sign |
| `POST /api/bot/permission/:id` | Stores the signed bot permission after checking it on-chain |
| `POST /api/wallet/actions` | Builds a stop or withdraw transaction for the user to send |
| `POST /api/wallet/actions/:id/confirm` | Checks the user's transaction on-chain and records it |
| `POST /api/bot/test-trade` | Makes one swap now. Development only. |

## Automatic trading

With `STRATEGY_ENABLED=true`, the server checks every `STRATEGY_INTERVAL_MS` for users whose bot is on, whether they're logged in or not, and asks the strategy what to trade. "Stop bot" ends it for that user: the runner skips stopped bots, and the blockchain would refuse their trades anyway.

A user is skipped, without a failed trade being recorded, while their smart account lacks the BNB for a trade's gas or today's gas budget is used up. Trades then resume by themselves.

**The current strategy is a random test strategy.** Each time, it buys or sells DEOD at random, 50/50: it sells 1 to 10 USDT or 50 to 500 DEOD, within the balance and the limits. It's only for trying the system out. Every trade pays the pool's 1% fee, so random trading slowly loses value. It never runs on BNB Chain mainnet (`testOnly` in the strategy file).

To add the real strategy, replace `decide` in [backend/src/strategy/strategy.js](backend/src/strategy/strategy.js). It gets each active user's balances, remaining daily limits and per-trade limits, and returns nothing or one swap to make. Set `testOnly` to false once it may run on mainnet.

## Before going to production

1. **Test with the real MetaMask extension.** The automated browser test used a stand-in that signs like MetaMask. Check how MetaMask displays the permission signature requests, and that it doesn't block or warn on them.
2. **Bot key in KMS.** Set `BOT_KMS_KEY_ID` and remove `BOT_PRIVATE_KEY`. Keep a small BNB balance on the bot address, and alert when it runs low.
3. **Trade size limits.** They aren't enforced on-chain, so keep daily limits and deposits modest. An on-chain volume cap would need a custom caveat enforcer contract, which would need an audit.
4. **Frontend hosting.** Host the frontend separately from the API with locked-down deployments.
5. **Logins.** Move the login token from browser storage to an httpOnly cookie. Add an email address for password resets; there is none yet, so a forgotten password means a new login, and the MetaMask stays linked to the old one. Behind a load balancer, set Express's `trust proxy` so lockouts see real IP addresses. With more than one server, keep the lockout counts in a shared store such as Redis, since each server counts separately today.
6. **Database.** Use a managed MongoDB deployment with authentication, TLS and backups.
7. **Outside review.** Get the permission rules and the integration reviewed by a smart-contract auditor.
8. **Legal review.** Confirm obligations for an automated trading service in your market.
9. **Launch settings.** Set `NETWORK=bsc`, use a paid RPC provider, and turn off test trades.

## Known limitations

- Only DEOD and USDT, one PancakeSwap v3 pool, and one set of limits and one gas cap for every user.
- BNB in a smart account pays the bot's gas and can be withdrawn, but is never traded.
- The gas repayment is based on the transaction's gas estimate, which runs slightly above the gas actually used (about 0.3% in testing).
- Users can lose money through bad trades. The rules stop theft, not losses.

The earlier Safe and Zodiac Roles version, which also enforced trading limits on-chain, is in the git history.
