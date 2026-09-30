import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineChain, parseEther, parseUnits } from "viem";
import { bsc, bscTestnet } from "viem/chains";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MAINNET = {
  contracts: {
    // PancakeSwap Smart Router. Its exactInputSingle has the same shape as Uniswap's SwapRouter02.
    swapRouter: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
    // PancakeSwap v3 QuoterV2.
    quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
  },
  tokens: {
    DEOD: { symbol: "DEOD", address: "0x3510FbBC13090F991Ffa523527113A166161683e", decimals: 18 },
    USDT: { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  },
};

// BNB testnet has no USDT anyone can mint and no DEOD/USDT pool, so `npm run testnet:setup`
// creates both and records their addresses in this file.
export const TESTNET_DEPLOYMENT_FILE = path.join(backendRoot, "testnet", "deployment.json");
const testnetDeployment = fs.existsSync(TESTNET_DEPLOYMENT_FILE)
  ? JSON.parse(fs.readFileSync(TESTNET_DEPLOYMENT_FILE, "utf8"))
  : {};

export const TESTNET_CONTRACTS = {
  swapRouter: "0x9a489505a00cE272eAa5e07Dba6491314CaE3796",
  quoter: "0xbC203d7f83677c7ed3F7acEc959963E7F4ECC5C2",
  v3Factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
  positionManager: "0x427bF5b37357632377eCbEC9de3626C71A5396c1",
};

const TESTNET = {
  contracts: TESTNET_CONTRACTS,
  tokens: {
    // Decentrawood's test DEOD. Anyone can mint it.
    DEOD: { symbol: "DEOD", address: "0x3fb98B9DaebFdaA06b72Df9704aDe353500e7CFf", decimals: 18 },
    USDT: { symbol: "USDT", address: testnetDeployment.usdt ?? null, decimals: 18 },
  },
};

const NETWORKS = {
  // Local copy of BNB Chain run with anvil. Its own chain id keeps MetaMask from
  // confusing it with the real BNB Chain. MetaMask's contracts there match BNB Chain's (56).
  "bsc-fork": {
    ...MAINNET,
    chain: defineChain({
      id: 561337,
      name: "BNB Chain (local fork)",
      nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
      rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
    }),
    metamaskChainId: 56,
    explorer: null,
  },
  bsc: { ...MAINNET, chain: bsc, metamaskChainId: 56, explorer: "https://bscscan.com" },
  "bsc-testnet": {
    ...TESTNET,
    chain: bscTestnet,
    metamaskChainId: 97,
    explorer: "https://testnet.bscscan.com",
    // This endpoint also serves older state, which a local copy of testnet needs.
    defaultRpcUrl: "https://bsc-testnet-rpc.publicnode.com",
  },
};

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  return value;
}

const networkName = process.env.NETWORK || "bsc-fork";
const network = NETWORKS[networkName];
if (!network) throw new Error(`Unknown NETWORK "${networkName}". Use one of: ${Object.keys(NETWORKS).join(", ")}`);

export const ADDRESSES = network.contracts;
export const TOKENS = network.tokens;

/** The token on the other side of the pair. */
export const otherToken = (symbol) => Object.values(TOKENS).find((t) => t.symbol !== symbol);

/** Explains what is missing before this network can be used, or returns null when it is ready. */
export function networkProblem() {
  if (Object.values(TOKENS).some((t) => !t.address)) {
    return `The ${networkName} contracts are not set up yet. Run "npm run testnet:setup" first.`;
  }
  return null;
}

export const config = {
  networkName,
  chain: network.chain,
  // Which chain's MetaMask Smart Accounts deployment to use. The contracts are at the same addresses everywhere.
  metamaskChainId: network.metamaskChainId,
  explorer: network.explorer,
  nativeSymbol: network.chain.nativeCurrency.symbol,
  rpcUrl: process.env.RPC_URL || network.defaultRpcUrl || network.chain.rpcUrls.default.http[0],
  port: Number(process.env.PORT || 4000),
  appOrigin: process.env.APP_ORIGIN || "http://localhost:5173",
  jwtSecret: required("JWT_SECRET"),
  // The bot's key. In production, set BOT_KMS_KEY_ID so the key lives in AWS KMS and nobody can see it.
  // BOT_PRIVATE_KEY is for local development and testnet only.
  botKmsKeyId: process.env.BOT_KMS_KEY_ID || null,
  botPrivateKey: process.env.BOT_PRIVATE_KEY || null,
  // Only used by the testnet setup and test-funding scripts. The running app never needs it.
  deployerPrivateKey: process.env.DEPLOYER_PRIVATE_KEY || null,
  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017",
  // One database per network, so test data never mixes with real data.
  mongoDbName: process.env.MONGODB_DB || `userdexbot_${networkName.replace(/-/g, "_")}`,
  enableTestTrades: (process.env.ENABLE_TEST_TRADES ?? "true") === "true",
  rules: {
    // The DEOD/USDT pool on PancakeSwap v3 uses the 1% fee tier (10000). The testnet pool copies that.
    poolFee: Number(process.env.POOL_FEE || 10_000),
    slippageBps: BigInt(process.env.SLIPPAGE_BPS || 100),
    // The most the bot may sell in one trade, and per day. Checked by the bot before each trade.
    // MetaMask's permission rules can't cap swap sizes, so these are not enforced on-chain.
    perTradeLimits: {
      DEOD: parseUnits(process.env.PER_TRADE_LIMIT_DEOD || "5000", 18),
      USDT: parseUnits(process.env.PER_TRADE_LIMIT_USDT || "100", 18),
    },
    dailyLimits: {
      DEOD: parseUnits(process.env.DAILY_LIMIT_DEOD || "10000", 18),
      USDT: parseUnits(process.env.DAILY_LIMIT_USDT || "200", 18),
    },
    // The user pays the gas of the bot's trades in BNB, from their smart account, in the same
    // transaction as the swap. The signed permission caps the total per day.
    dailyGasCap: parseEther(process.env.DAILY_GAS_CAP_BNB || "0.005"),
  },
  strategy: {
    enabled: process.env.STRATEGY_ENABLED === "true",
    intervalMs: Number(process.env.STRATEGY_INTERVAL_MS || 60_000),
  },
};

if (!config.botKmsKeyId && !config.botPrivateKey) {
  throw new Error("Set BOT_KMS_KEY_ID (production) or BOT_PRIVATE_KEY (development). See .env.example.");
}

// SIWE messages must name the site the user signed in on.
config.appDomain = new URL(config.appOrigin).host;
