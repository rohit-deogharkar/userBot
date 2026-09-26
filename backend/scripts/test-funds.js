// Test funds for local forks and BNB testnet. Refuses to run against BNB Chain mainnet.
//
// - Local fork of BNB Chain: gives BNB directly, then buys USDT and DEOD on the real PancakeSwap pools copied into the fork.
// - BNB testnet: mints test DEOD and test USDT, which anyone can mint. On a local copy of testnet it also gives BNB.
import {
  createTestClient,
  createWalletClient,
  http,
  maxUint256,
  parseAbi,
  parseEther,
  parseUnits,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { erc20Abi, swapRouterAbi, wethAbi } from "../src/abis.js";
import { publicClient, relayerAccount, relayerClient } from "../src/chain.js";
import { ADDRESSES, TOKENS, config } from "../src/config.js";

if (config.networkName === "bsc") {
  throw new Error("Test funding never runs against BNB Chain mainnet.");
}

const transport = http(config.rpcUrl);
export { publicClient };
export const testClient = createTestClient({ chain: config.chain, mode: "anvil", transport });

export function walletFor(account) {
  return createWalletClient({ account, chain: config.chain, transport });
}

/** True when the RPC is a local anvil node, where balances can be set directly. */
export async function isLocalNode() {
  try {
    const version = await publicClient.request({ method: "web3_clientVersion" });
    return String(version).toLowerCase().startsWith("anvil");
  } catch {
    return false;
  }
}

async function send(wallet, request) {
  const hash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
  return receipt;
}

const balanceOf = (token, owner) =>
  publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });

async function balancesOf(address) {
  const [bnb, usdt, deod] = await Promise.all([
    publicClient.getBalance({ address }),
    balanceOf(TOKENS.USDT.address, address),
    balanceOf(TOKENS.DEOD.address, address),
  ]);
  return { BNB: bnb, USDT: usdt, DEOD: deod };
}

const MAINNET_WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const WBNB_USDT_FEE = 100; // The deep WBNB/USDT PancakeSwap v3 pool on mainnet.

async function fundOnMainnetFork(address, { bnb = "10", usdt = "1000", usdtForDeod = "200" }) {
  if (!(await isLocalNode())) throw new Error("NETWORK=bsc-fork needs a local anvil node.");
  await testClient.setBalance({ address, value: parseEther(bnb) });

  const helper = privateKeyToAccount(generatePrivateKey());
  await testClient.setBalance({ address: helper.address, value: parseEther("1000") });
  const wallet = walletFor(helper);
  const router = ADDRESSES.swapRouter;
  const swap = (tokenIn, tokenOut, fee, amountIn, recipient) =>
    send(wallet, {
      address: router,
      abi: swapRouterAbi,
      functionName: "exactInputSingle",
      args: [{ tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
    });

  const wrapped = parseEther("5");
  await send(wallet, { address: MAINNET_WBNB, abi: wethAbi, functionName: "deposit", value: wrapped });
  await send(wallet, { address: MAINNET_WBNB, abi: erc20Abi, functionName: "approve", args: [router, maxUint256] });
  await swap(MAINNET_WBNB, TOKENS.USDT.address, WBNB_USDT_FEE, wrapped, helper.address);
  await send(wallet, { address: TOKENS.USDT.address, abi: erc20Abi, functionName: "transfer", args: [address, parseUnits(usdt, 18)] });
  await send(wallet, { address: TOKENS.USDT.address, abi: erc20Abi, functionName: "approve", args: [router, maxUint256] });
  await swap(TOKENS.USDT.address, TOKENS.DEOD.address, config.rules.poolFee, parseUnits(usdtForDeod, 18), address);
  return balancesOf(address);
}

const deodMintAbi = parseAbi(["function mint(uint256 amount)"]);
const usdtMintAbi = parseAbi(["function mint(address to, uint256 amount)"]);

async function fundOnTestnet(address, { bnb = "10", usdt = "1000", deod = "50000" }) {
  if (await isLocalNode()) {
    await testClient.setBalance({ address, value: parseEther(bnb) });
    // On a local copy of testnet the relayer may start empty. Real testnet BNB comes from you.
    if ((await publicClient.getBalance({ address: relayerAccount.address })) < parseEther("1")) {
      await testClient.setBalance({ address: relayerAccount.address, value: parseEther("10") });
    }
  }
  // Test DEOD mints to whoever calls it, so the relayer mints and passes it on.
  await send(relayerClient, { address: TOKENS.DEOD.address, abi: deodMintAbi, functionName: "mint", args: [parseUnits(deod, 18)] });
  await send(relayerClient, { address: TOKENS.DEOD.address, abi: erc20Abi, functionName: "transfer", args: [address, parseUnits(deod, 18)] });
  await send(relayerClient, { address: TOKENS.USDT.address, abi: usdtMintAbi, functionName: "mint", args: [address, parseUnits(usdt, 18)] });
  return balancesOf(address);
}

/** Gives an address test BNB (where possible), USDT and DEOD. */
export async function fundAddress(address, options = {}) {
  return config.networkName === "bsc-testnet" ? fundOnTestnet(address, options) : fundOnMainnetFork(address, options);
}

