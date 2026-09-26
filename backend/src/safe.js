import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  getContractAddress,
  isAddressEqual,
  keccak256,
  recoverTypedDataAddress,
  size,
  toHex,
  zeroAddress,
} from "viem";
import { multiSendAbi, safeAbi, safeProxyFactoryAbi } from "./abis.js";
import { publicClient, relayerClient, relayerQueue, sendAndConfirm } from "./chain.js";
import { ADDRESSES, config } from "./config.js";
import { HttpError } from "./errors.js";

// Same salt for everyone. Combined with the owner address inside the initializer,
// each MetaMask address maps to exactly one bot wallet address.
export const SALT_NONCE = BigInt(keccak256(toHex("userDexBot:bot-wallet:v1")));
export const SENTINEL_MODULES = "0x0000000000000000000000000000000000000001";

export const OPERATION = { CALL: 0, DELEGATE_CALL: 1 };

export function safeInitializer(owner) {
  return encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [[getAddress(owner)], 1n, zeroAddress, "0x", ADDRESSES.safeFallbackHandler, zeroAddress, 0n, zeroAddress],
  });
}

let proxyCreationCode;
async function getProxyCreationCode() {
  proxyCreationCode ??= await publicClient.readContract({
    address: ADDRESSES.safeProxyFactory,
    abi: safeProxyFactoryAbi,
    functionName: "proxyCreationCode",
  });
  return proxyCreationCode;
}

/** Works out the bot wallet address for an owner before it exists. */
export async function predictSafeAddress(owner) {
  const initializer = safeInitializer(owner);
  const salt = keccak256(encodePacked(["bytes32", "uint256"], [keccak256(initializer), SALT_NONCE]));
  const bytecode = concat([
    await getProxyCreationCode(),
    encodeAbiParameters([{ type: "address" }], [ADDRESSES.safeSingletonL2]),
  ]);
  return getContractAddress({ opcode: "CREATE2", from: ADDRESSES.safeProxyFactory, salt, bytecode });
}

export async function isDeployed(address) {
  const code = await publicClient.getCode({ address });
  return Boolean(code && code !== "0x");
}

/** Creates the bot wallet with the user's MetaMask as its only owner. The relayer pays gas. */
export async function deploySafe(owner) {
  const safe = await predictSafeAddress(owner);
  if (!(await isDeployed(safe))) {
    await sendAndConfirm(relayerClient, relayerQueue, {
      address: ADDRESSES.safeProxyFactory,
      abi: safeProxyFactoryAbi,
      functionName: "createProxyWithNonce",
      args: [ADDRESSES.safeSingletonL2, safeInitializer(owner), SALT_NONCE],
    });
  }
  await assertSafeOwnedOnlyBy(safe, owner);
  return safe;
}

export async function getSafeState(safe) {
  const [owners, threshold, nonce, modulesPage] = await Promise.all([
    publicClient.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }),
    publicClient.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }),
    publicClient.readContract({ address: safe, abi: safeAbi, functionName: "nonce" }),
    publicClient.readContract({ address: safe, abi: safeAbi, functionName: "getModulesPaginated", args: [SENTINEL_MODULES, 10n] }),
  ]);
  return { owners, threshold, nonce, modules: modulesPage[0] };
}

/** Refuses to continue unless the wallet belongs to the user alone. */
export async function assertSafeOwnedOnlyBy(safe, owner) {
  const { owners, threshold } = await getSafeState(safe);
  if (owners.length !== 1 || !isAddressEqual(owners[0], owner) || threshold !== 1n) {
    throw new Error(`Bot wallet ${safe} is not owned solely by ${owner}`);
  }
}

/** Packs several calls into one MultiSend call, executed by the Safe with DELEGATECALL. */
export function encodeMultiSend(calls) {
  const packed = concat(
    calls.map((call) =>
      encodePacked(
        ["uint8", "address", "uint256", "uint256", "bytes"],
        [OPERATION.CALL, call.to, call.value ?? 0n, BigInt(size(call.data)), call.data],
      ),
    ),
  );
  return {
    to: ADDRESSES.multiSendCallOnly,
    value: 0n,
    data: encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packed] }),
    operation: OPERATION.DELEGATE_CALL,
  };
}

export async function buildSafeTx(safe, { to, value = 0n, data = "0x", operation = OPERATION.CALL }) {
  const nonce = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
  return {
    to: getAddress(to),
    value,
    data,
    operation,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce,
  };
}

export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

/** The EIP-712 message the user signs in MetaMask. */
export function safeTxTypedData(safe, tx) {
  return {
    domain: { chainId: config.chain.id, verifyingContract: getAddress(safe) },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx",
    message: tx,
  };
}

/** Checks the owner's signature and submits the transaction. The relayer pays gas but cannot change anything. */
export async function executeSafeTx(safe, owner, tx, signature) {
  const signer = await recoverTypedDataAddress({ ...safeTxTypedData(safe, tx), signature });
  if (!isAddressEqual(signer, owner)) {
    throw new HttpError(400, "Signature does not come from the bot wallet's owner.");
  }
  const currentNonce = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
  if (currentNonce !== tx.nonce) {
    throw new HttpError(409, "This request is out of date because another wallet action happened first. Please try again.");
  }
  const receipt = await sendAndConfirm(relayerClient, relayerQueue, {
    address: safe,
    abi: safeAbi,
    functionName: "execTransaction",
    args: [tx.to, tx.value, tx.data, tx.operation, 0n, 0n, 0n, zeroAddress, zeroAddress, signature],
  });
  return receipt.transactionHash;
}

/** Safe keeps modules in a linked list, so disabling one needs the module before it. */
export async function previousModule(safe, module) {
  const { modules } = await getSafeState(safe);
  const index = modules.findIndex((m) => isAddressEqual(m, module));
  if (index === -1) return null;
  return index === 0 ? SENTINEL_MODULES : modules[index - 1];
}
