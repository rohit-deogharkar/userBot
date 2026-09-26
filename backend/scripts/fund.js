// Usage: npm run fund -- 0xYourMetaMaskAddress           (local fork of BNB Chain)
//        npm run fund:testnet -- 0xYourMetaMaskAddress   (BNB testnet)
// Gives the address test USDT and DEOD, plus BNB on local nodes, so you can try the app in MetaMask.
import { formatUnits, getAddress, isAddress } from "viem";
import { config, networkProblem } from "../src/config.js";
import { fundAddress } from "./test-funds.js";

const target = process.argv[2];
if (!target || !isAddress(target)) {
  console.error("Usage: npm run fund -- 0xYourMetaMaskAddress");
  process.exit(1);
}
const problem = networkProblem();
if (problem) {
  console.error(problem);
  process.exit(1);
}

const balances = await fundAddress(getAddress(target));
console.log(`Funded ${target} on ${config.chain.name}. It now holds:`);
for (const [symbol, amount] of Object.entries(balances)) {
  console.log(`  ${Number(formatUnits(amount, 18)).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${symbol}`);
}
