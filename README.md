# userDexBot

An automated trading bot for **DEOD/USDT on BNB Chain** where users never hand over their private key. Trades go through the DEOD/USDT pool on PancakeSwap v3.

Each user gets a **bot wallet**: a [Safe](https://safe.global) smart wallet whose only owner is their MetaMask. The bot gets a **trade-only permission** through a [Zodiac Roles](https://docs.roles.gnosisguild.org) module attached to that wallet. The blockchain checks every bot transaction against the user's rules, so the bot, our servers and our team can trade the funds but can never withdraw them.

```
User's MetaMask ──owns──▶ Bot wallet (Safe) ◀──trade-only key── Our bot server
  deposit, withdraw,        holds trading funds,     runs the strategy,
  enable or stop bot        enforces the rules       holds no user keys
```

## What the bot can and cannot do

The rules live in [backend/src/permissions.js](backend/src/permissions.js) and are written on-chain when the user enables the bot.

| The bot can | The bot can never |
|---|---|
| Swap DEOD and USDT on PancakeSwap v3, in the 1% DEOD/USDT pool only | Withdraw or transfer funds anywhere |
| Send swap output back to the bot wallet only | Trade other tokens, pools or exchanges |
| Approve DEOD and USDT for the PancakeSwap router only | Change the rules, add modules or change the owner |
| Sell up to a daily limit per token | Act at all after the user stops it |

## Project layout

```
backend/    Node.js + Express API, bot and relayer
  src/config.js        Network, trading pair, contract addresses and rule settings
  src/safe.js          Create bot wallets, build and submit user-signed Safe transactions
  src/roles.js         Deploy the Roles module and build the enable/stop calls
  src/permissions.js   The trade-only rules
  src/bot.js           Quotes and swaps through the Roles module
  src/db.js            MongoDB collections: users, walletActions, trades, loginNonces
  src/strategy/        Where the trading strategy plugs in (currently empty)
  scripts/e2e.js       End-to-end proof, including theft attempts
  scripts/fund.js      Gives a test address USDT and DEOD (and BNB on local nodes)
  scripts/testnet-setup.js  One-time setup of BNB testnet
  testnet/             Test USDT contract and the saved testnet addresses
frontend/   React (Vite) app
  src/lib/verifySafeTx.js  Checks every wallet action before MetaMask signs it
```

## Run it locally

Everything runs against a **local copy of BNB Chain**, so it uses the real Safe, Zodiac, PancakeSwap, DEOD and USDT contracts with fake money.

**Prerequisites:** Node.js 20 or newer, MongoDB running locally on the default port, MetaMask in your browser, and Foundry's `anvil`.
On Windows, download the `foundry_stable_win32_amd64.zip` release from [Foundry's GitHub releases](https://github.com/foundry-rs/foundry/releases) and unzip it, or run `foundryup` from Git Bash.

1. **Start the local BNB Chain fork** and leave it running:
   ```
   anvil --fork-url https://bsc-mainnet.public.blastapi.io --chain-id 561337
   ```
   The fork URL must serve historical state. Many free BNB Chain endpoints only keep the last minute or two, and the fork then breaks a few minutes after it starts. Blast API and `https://api.zan.top/bsc-mainnet` work. A paid endpoint is more reliable.
2. **Start the backend** in a second terminal:
   ```
   cd backend
   npm install
   cp .env.example .env      # then set JWT_SECRET to a long random string
   npm run dev
   ```
3. **Run the proof** in a third terminal. It should end with every check passing:
   ```
   cd backend
   npm run e2e
   ```
4. **Start the frontend:**
   ```
   cd frontend
   npm install
   npm run dev
   ```
5. **Fund your MetaMask account on the fork**, then open http://localhost:5173:
   ```
   cd backend
   npm run fund -- 0xYourMetaMaskAddress
   ```
   The app asks MetaMask to add the "BNB Chain (local fork)" network, chain id 561337, the first time you sign in or deposit. MetaMask doesn't show DEOD and USDT on this network until you import them with the token addresses in the next section.

If you restart anvil, the fork starts over but MongoDB keeps its records. The app then shows "Create bot wallet" again, which recreates each wallet at the same address. MetaMask may also remember old transaction counts. Fix that in MetaMask under Settings, Advanced, "Clear activity tab data".

## Test on BNB testnet

Testnet runs against the real public BNB testnet with your real MetaMask, so no anvil is needed. BNB testnet is missing three things the bot needs, so a one-time setup creates them:

- **Zodiac Roles 2.1.1**, copied byte for byte from BNB Chain. It points at a library already on testnet whose executable code is identical to the mainnet one.
- **A test USDT** that anyone can mint, because the existing testnet USDT tokens only let their owners mint.
- **A DEOD/USDT pool** on PancakeSwap v3 testnet at the 1% fee tier, priced at about 0.02 USDT per DEOD, with 1,250,000 test DEOD and 25,000 test USDT of liquidity. Test DEOD is `0x3fb98B9DaebFdaA06b72Df9704aDe353500e7CFf`, and anyone can mint it.

Steps, all run in `backend`:

1. **Fund the relayer.** `backend/.env.testnet` holds a relayer key and a bot key made only for testnet. Send about 0.1 test BNB from MetaMask to the relayer address that the setup prints. The setup itself costs about 0.03 test BNB, including 0.02 it passes to the bot key for gas.
2. **Run the setup once.** It skips anything already done, so it's safe to run again. It saves the new addresses to `backend/testnet/deployment.json` and to the frontend.
   ```
   npm run testnet:setup
   ```
3. **Start the backend on testnet** instead of the fork. Stop the fork backend first, since both use port 4000.
   ```
   npm run dev:testnet
   ```
4. **Get test tokens** in your MetaMask:
   ```
   npm run fund:testnet -- 0xYourMetaMaskAddress
   ```
5. **In MetaMask,** switch to BNB Smart Chain Testnet and import the test USDT address from `backend/testnet/deployment.json`.

The whole flow was rehearsed on a local copy of testnet before release: the setup, the 24-check proof and the browser test all passed.

## Token addresses on BNB Chain

```
DEOD                       0x3510FbBC13090F991Ffa523527113A166161683e
USDT                       0x55d398326f99059fF775485246999027B3197955
DEOD/USDT pool (v3, 1%)    0x185d73EC966d464A40372cd7E737bB68B0B95f1f
PancakeSwap Smart Router   0x13f4EA83D0bd40E75C8222255bc855a974568Dd4
```

## What the proof checks

`npm run e2e` plays a new user through the real API, then attacks the wallet with the bot key:

- Sign in, create the bot wallet, deposit, enable the bot, and make two swaps.
- Daily limits go down by exactly the amounts sold.
- The bot key is blocked from transferring funds, approving itself, sending swap output elsewhere, using another pool, buying an unlisted token, exceeding the daily limit by one unit, and calling the wallet directly.
- The user withdraws everything, stops the bot, and the bot can no longer trade.
- A signature from anyone other than the owner is rejected, and the same signed action can't be submitted twice.

## Configuration

All settings are in `backend/.env`. See [backend/.env.example](backend/.env.example) for descriptions.

| Variable | Purpose |
|---|---|
| `NETWORK` | `bsc-fork` for the local copy, `bsc-testnet` for BNB testnet, `bsc` for BNB Chain mainnet. Testnet settings live in `.env.testnet`. |
| `MONGODB_URI`, `MONGODB_DB` | MongoDB connection. The database defaults to `userdexbot_<network>`, such as `userdexbot_bsc_fork`. |
| `RPC_URL` | Blockchain RPC endpoint |
| `RELAYER_PRIVATE_KEY` | Pays gas to create wallets and submit user-signed actions. Never an owner. |
| `BOT_PRIVATE_KEY` | The trade-only key |
| `POOL_FEE`, `DAILY_LIMIT_DEOD`, `DAILY_LIMIT_USDT`, `SLIPPAGE_BPS` | Trade rules and limits |
| `ENABLE_TEST_TRADES` | Shows a manual "test trade" button. Turn off in production. |
| `STRATEGY_ENABLED`, `STRATEGY_INTERVAL_MS` | Automatic strategy loop |

## API

| Method and path | What it does |
|---|---|
| `GET /api/config` | Network, tokens, bot address and rules for the UI |
| `GET /api/auth/nonce`, `POST /api/auth/verify` | Sign-In with Ethereum |
| `GET /api/me` | Balances, bot status, daily limits left, recent activity |
| `POST /api/wallet` | Create the bot wallet. Safe to call twice. |
| `POST /api/wallet/actions` | Build an enable, stop or withdraw action for the user to sign |
| `POST /api/wallet/actions/:id/execute` | Submit the signed action. The relayer pays gas. |
| `POST /api/bot/test-trade` | Make one swap now. Development only. |

## Adding the trading strategy

Write it in [backend/src/strategy/strategy.js](backend/src/strategy/strategy.js). The `decide` function gets each active user's balances and remaining daily limits, and returns either nothing or one swap to make. Set `STRATEGY_ENABLED=true` to run it on a timer. The strategy never touches keys, and every trade it asks for is still checked on-chain.

## Before going to production

This is a working prototype, not a production system. These items are still open:

1. **Keys.** Move the relayer and bot keys into a key service such as AWS KMS. Keep only small BNB balances on them and alert when they run low.
2. **Rule verification in the browser.** The frontend already checks withdraw and stop actions exactly. For "enable bot" it checks which contracts and functions the rules cover, but not each rule's conditions. Rebuild the expected rules in the browser and compare them exactly.
3. **Frontend hosting.** Host the frontend separately from the API with locked-down deployments, so one breach can't change both what users see and what they sign.
4. **Sessions.** Move the login token from browser storage to an httpOnly cookie.
5. **Abuse limits.** Rate-limit wallet creation and relayed actions, since the relayer pays gas for them.
6. **Database.** Use a managed MongoDB deployment, such as MongoDB Atlas, with authentication, TLS and backups turned on.
7. **Outside review.** Get the permission rules and the integration reviewed by a smart-contract auditor.
8. **Legal review.** Confirm obligations for an automated trading service in your market.
9. **Launch settings.** Set `NETWORK=bsc`, use a paid RPC provider, turn off test trades, and start with low daily limits.
10. **Thin liquidity.** The DEOD/USDT pool held about $69,000 when this was built. Large bot trades move the price a lot and are easy targets for front-running. Keep daily limits small, and consider private transaction submission on BNB Chain.

## Known limitations

- Only DEOD and USDT, only the one PancakeSwap v3 pool, and one set of daily limits for every user.
- BNB sent to a bot wallet can be withdrawn but is not traded.
- Users can lose money through bad trades. The rules stop theft, not losses.
