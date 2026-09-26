import {
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  getContractAddress,
  isAddressEqual,
  keccak256,
  pad,
  size,
  toHex,
  zeroAddress,
} from "viem";
import { multiSendAbi, safeAbi, safeProxyFactoryAbi } from "./abis.js";
import { publicClient } from "./chain.js";
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

/** The transaction the user sends from MetaMask to create their bot wallet. The user pays the gas. */
export async function buildCreateSafeTx(owner) {
  return {
    safeAddress: await predictSafeAddress(owner),
    tx: {
      to: ADDRESSES.safeProxyFactory,
      value: 0n,
      data: encodeFunctionData({
        abi: safeProxyFactoryAbi,
        functionName: "createProxyWithNonce",
        args: [ADDRESSES.safeSingletonL2, safeInitializer(owner), SALT_NONCE],
      }),
    },
  };
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

/**
 * The signature Safe accepts when the owner sends execTransaction themselves.
 * Safe checks that the sender is the owner, so no separate signing step is needed.
 */
export const ownerSentSignature = (owner) => concat([pad(getAddress(owner)), pad("0x00"), "0x01"]);

/**
 * Checks on-chain that the owner really sent this wallet action from MetaMask and that it succeeded.
 * Used only to keep the activity history accurate. The blockchain itself already enforced everything.
 */
export async function confirmSafeTx(safe, owner, tx, txHash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
  const transaction = await publicClient.getTransaction({ hash: txHash });
  if (receipt.status !== "success") throw new HttpError(400, "That transaction failed on the blockchain.");
  if (!isAddressEqual(transaction.from, owner)) throw new HttpError(400, "That transaction was not sent by the wallet owner.");
  if (!transaction.to || !isAddressEqual(transaction.to, safe)) throw new HttpError(400, "That transaction was not sent to your bot wallet.");
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: safeAbi, data: transaction.input });
  } catch {
    throw new HttpError(400, "That transaction is not a wallet action.");
  }
  const [to, value, data, operation] = decoded.args;
  const matches =
    decoded.functionName === "execTransaction" &&
    isAddressEqual(to, tx.to) &&
    value === tx.value &&
    data.toLowerCase() === tx.data.toLowerCase() &&
    Number(operation) === tx.operation;
  if (!matches) throw new HttpError(400, "That transaction does not match this wallet action.");
  return receipt.transactionHash;
}

/** Safe keeps modules in a linked list, so disabling one needs the module before it. */
export async function previousModule(safe, module) {
  const { modules } = await getSafeState(safe);
  const index = modules.findIndex((m) => isAddressEqual(m, module));
  if (index === -1) return null;
  return index === 0 ? SENTINEL_MODULES : modules[index - 1];
}
