import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineChain, parseUnits } from "viem";
import { bsc, bscTestnet } from "viem/chains";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Safe 1.4.1 and Zodiac's module factory live at the same addresses on BNB Chain, its testnet and local forks.
// Sources: @safe-global/safe-deployments and @gnosis-guild/zodiac. All addresses were checked on-chain.
const SAFE_AND_ZODIAC = {
  safeSingletonL2: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  safeProxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  safeFallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
  multiSendCallOnly: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
  moduleProxyFactory: "0x000000000000aDdB49795b0f9bA5BC298cDda236",
};

const MAINNET = {
  contracts: {
    ...SAFE_AND_ZODIAC,
    // Zodiac Roles 2.1.1. Zodiac flags 2.1.0 as faulty.
    rolesMastercopy: "0xf2964ce6161ce0e75964fe7927ce114cb0b283d5",
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

// BNB testnet has no Roles 2.1.1 and no USDT anyone can mint, so `npm run testnet:setup`
// deploys both and records their addresses in this file.
export const TESTNET_DEPLOYMENT_FILE = path.join(backendRoot, "testnet", "deployment.json");
const testnetDeployment = fs.existsSync(TESTNET_DEPLOYMENT_FILE)
  ? JSON.parse(fs.readFileSync(TESTNET_DEPLOYMENT_FILE, "utf8"))
  : {};

export const TESTNET_CONTRACTS = {
  ...SAFE_AND_ZODIAC,
  rolesMastercopy: testnetDeployment.rolesMastercopy ?? null,
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
  // confusing it with the real BNB Chain.
  "bsc-fork": {
    ...MAINNET,
    chain: defineChain({
      id: 561337,
      name: "BNB Chain (local fork)",
      nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
      rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
    }),
    explorer: null,
  },
  bsc: { ...MAINNET, chain: bsc, explorer: "https://bscscan.com" },
  "bsc-testnet": {
    ...TESTNET,
    chain: bscTestnet,
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
  if (!ADDRESSES.rolesMastercopy || Object.values(TOKENS).some((t) => !t.address)) {
    return `The ${networkName} contracts are not set up yet. Run "npm run testnet:setup" first.`;
  }
  return null;
}

export const config = {
  networkName,
  chain: network.chain,
  explorer: network.explorer,
  nativeSymbol: network.chain.nativeCurrency.symbol,
  rpcUrl: process.env.RPC_URL || network.defaultRpcUrl || network.chain.rpcUrls.default.http[0],
  port: Number(process.env.PORT || 4000),
  appOrigin: process.env.APP_ORIGIN || "http://localhost:5173",
  jwtSecret: required("JWT_SECRET"),
  relayerPrivateKey: required("RELAYER_PRIVATE_KEY"),
  botPrivateKey: required("BOT_PRIVATE_KEY"),
  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017",
  // One database per network, so test data never mixes with real data.
  mongoDbName: process.env.MONGODB_DB || `userdexbot_${networkName.replace(/-/g, "_")}`,
  enableTestTrades: (process.env.ENABLE_TEST_TRADES ?? "true") === "true",
  rules: {
    // The DEOD/USDT pool on PancakeSwap v3 uses the 1% fee tier (10000). The testnet pool copies that.
    poolFee: Number(process.env.POOL_FEE || 10_000),
    slippageBps: BigInt(process.env.SLIPPAGE_BPS || 100),
    dailyLimits: {
      DEOD: parseUnits(process.env.DAILY_LIMIT_DEOD || "10000", 18),
      USDT: parseUnits(process.env.DAILY_LIMIT_USDT || "200", 18),
    },
  },
  strategy: {
    enabled: process.env.STRATEGY_ENABLED === "true",
    intervalMs: Number(process.env.STRATEGY_INTERVAL_MS || 60_000),
  },
};

// SIWE messages must name the site the user signed in on.
config.appDomain = new URL(config.appOrigin).host;
