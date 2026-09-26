// Tests the KMS signer without AWS: a stand-in answers like KMS, using a local key it never reveals.
// Run with: npm run test:kms   (needs anvil installed; it starts a throwaway local chain)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  bytesToHex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  hexToBytes,
  http,
  parseEther,
  recoverTransactionAddress,
  verifyMessage,
  verifyTypedData,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createKmsAccount } from "../src/kms.js";

const SPKI_PREFIX = "3056301006072a8648ce3d020106052b8104000a034200";
const N = secp256k1.CURVE.n;

/** Behaves like KMS for one key. Half its signatures use the high-s form KMS may return. */
function fakeKms(privateKey) {
  const priv = hexToBytes(privateKey);
  const publicKey = secp256k1.getPublicKey(priv, false);
  let count = 0;
  return {
    async send(command) {
      if (command instanceof GetPublicKeyCommand) {
        return { PublicKey: hexToBytes(`0x${SPKI_PREFIX}${bytesToHex(publicKey).slice(2)}`) };
      }
      if (command instanceof SignCommand) {
        assert.equal(command.input.MessageType, "DIGEST");
        let sig = secp256k1.sign(command.input.Message, priv);
        if (count++ % 2 === 1) sig = new secp256k1.Signature(sig.r, N - sig.s);
        return { Signature: sig.toDERRawBytes() };
      }
      throw new Error("Unexpected KMS command");
    },
  };
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

const privateKey = generatePrivateKey();
const expected = privateKeyToAccount(privateKey).address;
const account = await createKmsAccount({ keyId: "test-key", client: fakeKms(privateKey) });

await check("Address comes from the KMS public key", () => assert.equal(account.address, expected));

await check("Signed messages verify", async () => {
  for (const message of ["hello", "sign in to userDexBot"]) {
    const signature = await account.signMessage({ message });
    assert.ok(await verifyMessage({ address: expected, message, signature }));
  }
});

await check("Signed typed data verifies", async () => {
  const typedData = {
    domain: { name: "Test", chainId: 1, verifyingContract: "0x0000000000000000000000000000000000000001" },
    types: { Mail: [{ name: "note", type: "string" }] },
    primaryType: "Mail",
    message: { note: "hi" },
  };
  for (let i = 0; i < 2; i++) {
    const signature = await account.signTypedData(typedData);
    assert.ok(await verifyTypedData({ address: expected, signature, ...typedData }));
  }
});

await check("Signed transactions recover to the KMS address", async () => {
  for (const tx of [
    { chainId: 56, type: "legacy", nonce: 1, gasPrice: 50_000_000n, gas: 21000n, to: expected, value: 1n },
    { chainId: 56, type: "eip1559", nonce: 2, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gas: 21000n, to: expected, value: 1n },
  ]) {
    const serialized = await account.signTransaction(tx);
    assert.equal(await recoverTransactionAddress({ serializedTransaction: serialized }), expected);
  }
});

// A real transaction on a throwaway local chain.
const port = 8599;
const anvil = spawn(process.platform === "win32" ? "anvil.exe" : "anvil", ["--port", String(port), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
try {
  const chain = defineChain({ id: 31337, name: "local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } } });
  const transport = http(`http://127.0.0.1:${port}`);
  const publicClient = createPublicClient({ chain, transport });
  for (let i = 0; i < 50; i++) {
    try { await publicClient.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  await check("A KMS-signed transaction is accepted by a real node", async () => {
    await createTestClient({ chain, mode: "anvil", transport }).setBalance({ address: expected, value: parseEther("1") });
    const wallet = createWalletClient({ account, chain, transport });
    const hash = await wallet.sendTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 12345n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    assert.equal(receipt.from.toLowerCase(), expected.toLowerCase());
  });
} finally {
  anvil.kill();
}

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed.`);
process.exit(results.every(Boolean) ? 0 : 1);
