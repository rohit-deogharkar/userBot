// One-time setup for BNB testnet. Run with: npm run testnet:setup
//
// MetaMask's Smart Accounts contracts already exist on BNB testnet. What's missing, this script creates
// with the deployer key:
//   1. A test USDT that anyone can mint.
//   2. A DEOD/USDT pool on PancakeSwap v3 at the 1% fee tier, priced like mainnet, with test liquidity.
// It also sends the bot key a little test BNB for gas. Every step is skipped if it was already done,
// so the script is safe to run again. Addresses are saved to testnet/deployment.json.
import fs from "node:fs";
import path from "node:path";
import {
  formatEther,
  getAddress,
  isAddressEqual,
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
  const forFrontend = { usdt: deployment.usdt ?? null };
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

// 1. Test USDT
if (await hasCode(deployment.usdt)) {
  console.log(`1. Test USDT already at ${deployment.usdt}`);
} else {
  const hash = await deployerClient.deployContract({ abi: testUsdtArtifact.abi, bytecode: testUsdtArtifact.bytecode });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Test USDT deployment ${hash} failed`);
  deployment.usdt = receipt.contractAddress;
  save();
  console.log(`1. Deployed test USDT at ${deployment.usdt}`);
}

// 2. DEOD/USDT pool with liquidity
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
  console.log(`2a. Created the DEOD/USDT 1% pool at ${pool}`);
} else {
  console.log(`2a. DEOD/USDT 1% pool already at ${pool}`);
}
deployment.pool = pool;
deployment.poolFee = POOL_FEE;
save();

const liquidity = await publicClient.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" });
if (liquidity > 0n) {
  console.log("2b. Pool already has liquidity");
} else {
  // Mint only what's missing, so a rerun after an interruption doesn't mint twice.
  const held = async (token) =>
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [deployerAccount.address] });
  const deodHeld = await held(DEOD);
  if (deodHeld < DEOD_LIQUIDITY) await send({ address: DEOD, abi: deodAbi, functionName: "mint", args: [DEOD_LIQUIDITY - deodHeld] });
  const usdtHeld = await held(USDT);
  if (usdtHeld < USDT_LIQUIDITY) {
    await send({ address: USDT, abi: testUsdtArtifact.abi, functionName: "mint", args: [deployerAccount.address, USDT_LIQUIDITY - usdtHeld] });
  }
  for (const token of [DEOD, USDT]) {
    const allowance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [deployerAccount.address, TESTNET_CONTRACTS.positionManager],
    });
    if (allowance < maxUint256 / 2n) {
      await send({ address: token, abi: erc20Abi, functionName: "approve", args: [TESTNET_CONTRACTS.positionManager, maxUint256] });
    }
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
  console.log("2b. Added 1,250,000 DEOD and 25,000 test USDT of liquidity");
}

// 3. Gas for the bot key
const botBalance = await publicClient.getBalance({ address: botAccount.address });
if (botBalance >= BOT_GAS / 2n) {
  console.log(`3. Bot ${botAccount.address} already has ${formatEther(botBalance)} test BNB`);
} else {
  const hash = await deployerClient.sendTransaction({ to: botAccount.address, value: BOT_GAS });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`3. Sent ${formatEther(BOT_GAS)} test BNB to the bot ${botAccount.address}`);
}

save();
console.log(`\nBNB testnet is ready. Addresses saved to ${path.relative(process.cwd(), TESTNET_DEPLOYMENT_FILE)}.`);
console.log(`Deployer has ${formatEther(await publicClient.getBalance({ address: deployerAccount.address }))} test BNB left.`);
