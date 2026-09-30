import { createPublicClient, createWalletClient, http, nonceManager } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";
import { createKmsAccount } from "./kms.js";

const transport = http(config.rpcUrl);

export const publicClient = createPublicClient({ chain: config.chain, transport });

// The bot's key. Its only power is what each user's signed MetaMask permission allows.
// With BOT_KMS_KEY_ID set, the key stays inside AWS KMS and is never visible to anyone.
// Transaction numbers (nonces) are tracked locally, because public RPC endpoints can briefly report stale ones.
export const botAccount = config.botKmsKeyId
  ? await createKmsAccount({ keyId: config.botKmsKeyId })
  : privateKeyToAccount(config.botPrivateKey, { nonceManager });
export const botClient = createWalletClient({ account: botAccount, chain: config.chain, transport });

// Only for the testnet setup and test-funding scripts. The running app never uses it:
// users send their own wallet transactions from MetaMask and pay their own gas.
export const deployerAccount = config.deployerPrivateKey ? privateKeyToAccount(config.deployerPrivateKey, { nonceManager }) : null;
export const deployerClient = deployerAccount ? createWalletClient({ account: deployerAccount, chain: config.chain, transport }) : null;

// Sending two transactions from the same key at once can reuse a nonce.
// The bot's transactions go out one at a time through this queue.
function createQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}
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
