import { createPublicClient, createWalletClient, custom, defineChain, parseAbi } from "viem";

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

/** The API sends bigints as strings. MetaMask signing through viem needs the delegation salt as a bigint. */
export function reviveDelegationTypedData(typedData) {
  return {
    ...typedData,
    domain: { ...typedData.domain, chainId: Number(typedData.domain.chainId) },
    message: { ...typedData.message, salt: BigInt(typedData.message.salt) },
  };
}

const nonceAbi = parseAbi(["function currentNonce(address _delegationManager, address _delegator) view returns (uint256)"]);

/** Reads the smart account's stop-switch counter straight from the chain, not from the backend. */
export function readCurrentNonce(reader, { nonceEnforcer, delegationManager, account }) {
  return reader.readContract({ address: nonceEnforcer, abi: nonceAbi, functionName: "currentNonce", args: [delegationManager, account] });
}

export function friendlyError(error) {
  const rejected = error?.walk?.((e) => e?.code === 4001 || e?.name === "UserRejectedRequestError");
  if (rejected || error?.code === 4001) return "You cancelled the request in MetaMask.";
  return error?.shortMessage || error?.message || "Something went wrong.";
}
