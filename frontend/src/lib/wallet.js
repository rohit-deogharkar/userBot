import { concat, createPublicClient, createWalletClient, custom, defineChain, getAddress, pad, parseAbi } from "viem";

export const safeExecAbi = parseAbi([
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
]);

/**
 * The signature Safe accepts when the owner sends the transaction themselves.
 * Safe checks the sender is the owner, so MetaMask shows one transaction and no separate signature.
 */
export const ownerSentSignature = (owner) => concat([pad(getAddress(owner)), pad("0x00"), "0x01"]);

export const hasMetaMask = () => typeof window !== "undefined" && Boolean(window.ethereum);

/** Builds a viem chain from the backend's /config response. */
export function chainFromConfig(config) {
  const { chain } = config;
  return defineChain({
    id: chain.id,
    name: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: { default: { http: chain.rpcUrls } },
    blockExplorers: chain.explorer ? { default: { name: "Explorer", url: chain.explorer } } : undefined,
  });
}

export function createClients(chain) {
  const transport = custom(window.ethereum);
  return {
    wallet: createWalletClient({ chain, transport }),
    reader: createPublicClient({ chain, transport }),
  };
}

/** Asks MetaMask to switch to our chain, adding it first if MetaMask doesn't know it. */
export async function ensureChain(wallet, chain) {
  if ((await wallet.getChainId()) === chain.id) return;
  try {
    await wallet.switchChain({ id: chain.id });
  } catch (error) {
    const unknownChain = error?.walk?.((e) => e?.code === 4902) || /unrecognized chain/i.test(error?.message ?? "");
    if (!unknownChain) throw error;
    await wallet.addChain({ chain });
    await wallet.switchChain({ id: chain.id });
  }
}

/** The API sends bigints as strings. MetaMask signing through viem needs them as bigints. */
export function reviveSafeTypedData(typedData) {
  const m = typedData.message;
  return {
    ...typedData,
    message: {
      ...m,
      value: BigInt(m.value),
      operation: Number(m.operation),
      safeTxGas: BigInt(m.safeTxGas),
      baseGas: BigInt(m.baseGas),
      gasPrice: BigInt(m.gasPrice),
      nonce: BigInt(m.nonce),
    },
  };
}

export function friendlyError(error) {
  const rejected = error?.walk?.((e) => e?.code === 4001 || e?.name === "UserRejectedRequestError");
  if (rejected || error?.code === 4001) return "You cancelled the request in MetaMask.";
  return error?.shortMessage || error?.message || "Something went wrong.";
}
