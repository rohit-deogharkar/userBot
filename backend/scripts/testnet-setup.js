// One-time setup for BNB testnet. Run with: npm run testnet:setup
//
// BNB testnet is missing three things the bot needs, and this script creates them with the deployer key:
//   1. Zodiac Roles 2.1.1, copied byte for byte from BNB Chain.
//   2. A test USDT that anyone can mint.
//   3. A DEOD/USDT pool on PancakeSwap v3 at the 1% fee tier, priced like mainnet, with test liquidity.
// It also sends the bot key a little test BNB for gas. Every step is skipped if it was already done,
// so the script is safe to run again. Addresses are saved to testnet/deployment.json.
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  maxUint256,
  parseAbi,
  parseEther,
  parseUnits,
  zeroAddress,
} from "viem";
import { erc20Abi } from "../src/abis.js";
import { botAccount, deployerAccount, deployerClient, publicClient } from "../src/chain.js";
import { TESTNET_CONTRACTS, TESTNET_DEPLOYMENT_FILE, TOKENS, config } from "../src/config.js";

if (config.networkName !== "bsc-testnet") {
  console.error('Run this with the testnet settings: "npm run testnet:setup".');
  process.exit(1);
}
if (!deployerAccount) {
  console.error("Set DEPLOYER_PRIVATE_KEY in .env.testnet. The deployer pays for this one-time setup.");
  process.exit(1);
}

// Roles 2.1.1 on BNB Chain, and the one library address inside it that must change for testnet.
// Its library 0x8697… is not on testnet, but 0x61c5… is, and their executable code is identical
// (they differ only in the compiler's metadata fingerprint).
const MAINNET_RPC = process.env.MAINNET_RPC_URL || "https://bsc-rpc.publicnode.com";
const MAINNET_ROLES = "0xf2964ce6161ce0e75964fe7927ce114cb0b283d5";
const MAINNET_ROLES_CODE_HASH = "0x471d8b3b419f1eb955230c0326c8812176df49bf3c7b414a563fda5a3c6c10b6";
const MAINNET_PACKER = "869718c939652084bc491fbc5ce0d3c1d5b309f0";
const TESTNET_PACKER = "61c5b1be435391fdd7bc6703f3740c0d11728a8c";
const REQUIRED_TESTNET_CODE = [
  "0x61c5b1be435391fdd7bc6703f3740c0d11728a8c", // Roles library, identical code to the mainnet one
  "0x6a6af4b16458bc39817e4019fb02bd3b26d41049", // Roles integrity library
  "0xce0042B868300000d44A59004Da54A005ffdcf9f", // Singleton factory Roles uses to store rules
];

const POOL_FEE = 10_000;
const TICK_SPACING = 200;
const FULL_RANGE = { tickLower: -887200, tickUpper: 887200 };
// Mainnet price when this was written: about 0.02 USDT per DEOD.
const DEOD_LIQUIDITY = parseUnits("1250000", 18);
const USDT_LIQUIDITY = parseUnits("25000", 18);
const BOT_GAS = parseEther("0.02");
const MIN_DEPLOYER_BALANCE = parseEther("0.05");

const testUsdtArtifact = JSON.parse(fs.readFileSync(new URL("../testnet/TestUSDT.json", import.meta.url), "utf8"));
const deodAbi = parseAbi(["function mint(uint256 amount)"]);
const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)", "function feeAmountTickSpacing(uint24) view returns (int24)"]);
const poolAbi = parseAbi(["function liquidity() view returns (uint128)", "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint32, bool)"]);
const positionManagerAbi = parseAbi([
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
  "struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }",
  "function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
]);

const deployment = fs.existsSync(TESTNET_DEPLOYMENT_FILE) ? JSON.parse(fs.readFileSync(TESTNET_DEPLOYMENT_FILE, "utf8")) : {};
function save() {
  deployment.chainId = config.chain.id;
  deployment.updatedAt = new Date().toISOString();
  fs.writeFileSync(TESTNET_DEPLOYMENT_FILE, JSON.stringify(deployment, null, 2) + "\n");
  // The browser checks what users send against hard-coded addresses, so it needs the testnet addresses too.
  const frontendFile = path.resolve(path.dirname(TESTNET_DEPLOYMENT_FILE), "../../frontend/src/lib/testnetContracts.json");
  const forFrontend = { usdt: deployment.usdt ?? null, rolesMastercopy: deployment.rolesMastercopy ?? null };
  fs.writeFileSync(frontendFile, JSON.stringify(forFrontend, null, 2) + "\n");
}

const hasCode = async (address) => {
  if (!address) return false;
  const code = await publicClient.getCode({ address });
  return Boolean(code && code !== "0x");
};

async function send(request) {
  const hash = await deployerClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
  return receipt;
}

/** Deploys an exact copy of the given runtime code, using a 12-byte constructor that returns it unchanged. */
async function deployRuntimeCopy(runtimeHex) {
  const length = (runtimeHex.length - 2) / 2;
  const prefix = `0x61${length.toString(16).padStart(4, "0")}80600c6000396000f3`;
  const hash = await deployerClient.sendTransaction({ data: prefix + runtimeHex.slice(2) });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`Deployment ${hash} failed`);
  return receipt.contractAddress;
}

// Integer square root, for the pool's starting price.
function sqrt(value) {
  if (value < 2n) return value;
  let x = value, y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

// ---------------------------------------------------------------------------

const chainId = await publicClient.getChainId();
if (chainId !== 97) throw new Error(`Expected BNB testnet (chain 97) at ${config.rpcUrl}, got chain ${chainId}.`);

const deployerBalance = await publicClient.getBalance({ address: deployerAccount.address });
console.log(`Deployer ${deployerAccount.address} has ${formatEther(deployerBalance)} test BNB.`);
if (deployerBalance < MIN_DEPLOYER_BALANCE) {
  console.error(`\nSend at least ${formatEther(MIN_DEPLOYER_BALANCE)} test BNB to the deployer address above, then run this again.`);
  process.exit(1);
}

for (const address of REQUIRED_TESTNET_CODE) {
  if (!(await hasCode(address))) throw new Error(`Expected contract ${address} is missing on BNB testnet.`);
}

// 1. Roles 2.1.1
if (await hasCode(deployment.rolesMastercopy)) {
  console.log(`1. Roles 2.1.1 already at ${deployment.rolesMastercopy}`);
} else {
  const mainnet = createPublicClient({ transport: http(MAINNET_RPC) });
  const runtime = (await mainnet.getCode({ address: MAINNET_ROLES })).toLowerCase();
  if (keccak256(runtime) !== MAINNET_ROLES_CODE_HASH) throw new Error("Mainnet Roles code does not match the expected version.");
  const occurrences = runtime.split(MAINNET_PACKER).length - 1;
  if (occurrences !== 1) throw new Error(`Expected one library reference in Roles, found ${occurrences}.`);
  const patched = runtime.replace(MAINNET_PACKER, TESTNET_PACKER);
  deployment.rolesMastercopy = await deployRuntimeCopy(patched);
  const deployed = (await publicClient.getCode({ address: deployment.rolesMastercopy })).toLowerCase();
  if (deployed !== patched) throw new Error("Deployed Roles code does not match.");
  save();
  console.log(`1. Deployed Roles 2.1.1 copy at ${deployment.rolesMastercopy}`);
}

// 2. Test USDT
if (await hasCode(deployment.usdt)) {
  console.log(`2. Test USDT already at ${deployment.usdt}`);
} else {
  const hash = await deployerClient.deployContract({ abi: testUsdtArtifact.abi, bytecode: testUsdtArtifact.bytecode });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Test USDT deployment ${hash} failed`);
  deployment.usdt = receipt.contractAddress;
  save();
  console.log(`2. Deployed test USDT at ${deployment.usdt}`);
}

// 3. DEOD/USDT pool with liquidity
const DEOD = getAddress(TOKENS.DEOD.address);
const USDT = getAddress(deployment.usdt);
const [token0, token1] = BigInt(DEOD) < BigInt(USDT) ? [DEOD, USDT] : [USDT, DEOD];
const spacing = await publicClient.readContract({ address: TESTNET_CONTRACTS.v3Factory, abi: factoryAbi, functionName: "feeAmountTickSpacing", args: [POOL_FEE] });
if (Number(spacing) !== TICK_SPACING) throw new Error(`Unexpected tick spacing ${spacing} for the 1% fee tier.`);

let pool = await publicClient.readContract({ address: TESTNET_CONTRACTS.v3Factory, abi: factoryAbi, functionName: "getPool", args: [DEOD, USDT, POOL_FEE] });
if (isAddressEqual(pool, zeroAddress)) {
  // Price is token1 per token0. Both tokens use 18 decimals, so raw units compare directly.
  const [num, den] = isAddressEqual(token0, DEOD) ? [USDT_LIQUIDITY, DEOD_LIQUIDITY] : [DEOD_LIQUIDITY, USDT_LIQUIDITY];
  const sqrtPriceX96 = sqrt((num << 192n) / den);
  await send({
    address: TESTNET_CONTRACTS.positionManager,
    abi: positionManagerAbi,
    functionName: "createAndInitializePoolIfNecessary",
    args: [token0, token1, POOL_FEE, sqrtPriceX96],
  });
  pool = await publicClient.readContract({ address: TESTNET_CONTRACTS.v3Factory, abi: factoryAbi, functionName: "getPool", args: [DEOD, USDT, POOL_FEE] });
  console.log(`3a. Created the DEOD/USDT 1% pool at ${pool}`);
} else {
  console.log(`3a. DEOD/USDT 1% pool already at ${pool}`);
}
deployment.pool = pool;
deployment.poolFee = POOL_FEE;
save();

const liquidity = await publicClient.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" });
if (liquidity > 0n) {
  console.log("3b. Pool already has liquidity");
} else {
  await send({ address: DEOD, abi: deodAbi, functionName: "mint", args: [DEOD_LIQUIDITY] });
  await send({ address: USDT, abi: testUsdtArtifact.abi, functionName: "mint", args: [deployerAccount.address, USDT_LIQUIDITY] });
  for (const token of [DEOD, USDT]) {
    await send({ address: token, abi: erc20Abi, functionName: "approve", args: [TESTNET_CONTRACTS.positionManager, maxUint256] });
  }
  const amounts = isAddressEqual(token0, DEOD) ? [DEOD_LIQUIDITY, USDT_LIQUIDITY] : [USDT_LIQUIDITY, DEOD_LIQUIDITY];
  const { timestamp } = await publicClient.getBlock();
  await send({
    address: TESTNET_CONTRACTS.positionManager,
    abi: positionManagerAbi,
    functionName: "mint",
    args: [
      {
        token0,
        token1,
        fee: POOL_FEE,
        ...FULL_RANGE,
        amount0Desired: amounts[0],
        amount1Desired: amounts[1],
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: deployerAccount.address,
        deadline: timestamp + 600n,
      },
    ],
  });
  console.log("3b. Added 1,250,000 DEOD and 25,000 test USDT of liquidity");
}

// 4. Gas for the bot key
const botBalance = await publicClient.getBalance({ address: botAccount.address });
if (botBalance >= BOT_GAS / 2n) {
  console.log(`4. Bot ${botAccount.address} already has ${formatEther(botBalance)} test BNB`);
} else {
  const hash = await deployerClient.sendTransaction({ to: botAccount.address, value: BOT_GAS });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`4. Sent ${formatEther(BOT_GAS)} test BNB to the bot ${botAccount.address}`);
}

save();
console.log(`\nBNB testnet is ready. Addresses saved to ${path.relative(process.cwd(), TESTNET_DEPLOYMENT_FILE)}.`);
console.log(`Deployer has ${formatEther(await publicClient.getBalance({ address: deployerAccount.address }))} test BNB left.`);
