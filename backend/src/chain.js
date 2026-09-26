import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";

const transport = http(config.rpcUrl);

export const publicClient = createPublicClient({ chain: config.chain, transport });

// Pays gas to create bot wallets and to submit transactions the user signed.
// It is never an owner of any wallet, so a leak only exposes its own gas money.
export const relayerAccount = privateKeyToAccount(config.relayerPrivateKey);
export const relayerClient = createWalletClient({ account: relayerAccount, chain: config.chain, transport });

// The trade-only key. Its only power is what each user's Roles module allows.
export const botAccount = privateKeyToAccount(config.botPrivateKey);
export const botClient = createWalletClient({ account: botAccount, chain: config.chain, transport });

// Sending two transactions from the same key at once can reuse a nonce.
// Each key gets its own queue so its transactions go out one at a time.
function createQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}
export const relayerQueue = createQueue();
export const botQueue = createQueue();

export async function sendAndConfirm(client, queue, request) {
  return queue(async () => {
    const hash = await client.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`Transaction ${hash} reverted`);
    }
    return receipt;
  });
}
