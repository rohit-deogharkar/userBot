// MetaMask Smart Accounts: each user gets a MetaMask smart account (Hybrid DeleGator) owned by their MetaMask.
// The bot acts on it only through a delegation the user signs, whose caveats the blockchain enforces.
import { randomBytes } from "node:crypto";
import { DELEGATOR_CONTRACTS } from "@metamask/delegation-deployments";
import {
  createAllowedCalldataTerms,
  createAllowedMethodsTerms,
  createAllowedTargetsTerms,
  createExactCalldataTerms,
  createLogicalOrWrapperArgs,
  createLogicalOrWrapperTerms,
  createNativeTokenPeriodTransferTerms,
  createNonceTerms,
  createValueLteTerms,
  decodeLogicalOrWrapperTerms,
  decodeNonceTerms,
} from "@metamask/delegation-core";
import { ExecutionMode, ROOT_AUTHORITY, createExecution, getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { DelegationManager } from "@metamask/smart-accounts-kit/contracts";
import { SIGNABLE_DELEGATION_TYPED_DATA, getCounterfactualAccountData, hashDelegation } from "@metamask/smart-accounts-kit/utils";
import {
  bytesToHex,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  isAddressEqual,
  keccak256,
  maxUint256,
  pad,
  parseAbi,
  toFunctionSelector,
  toHex,
} from "viem";
import { erc20Abi } from "./abis.js";
import { publicClient } from "./chain.js";
import { ADDRESSES, TOKENS, config } from "./config.js";

const env = getSmartAccountsEnvironment(config.metamaskChainId);
// The kit's environment leaves out the OR-group enforcer, so it comes from MetaMask's deployment registry.
const registry = DELEGATOR_CONTRACTS["1.3.0"][String(config.metamaskChainId)];

export const MM = {
  delegationManager: env.DelegationManager,
  factory: env.SimpleFactory,
  implementations: env.implementations,
  enforcers: { ...env.caveatEnforcers, LogicalOrWrapperEnforcer: registry.LogicalOrWrapperEnforcer },
};

// One smart account per MetaMask address. The salt is fixed, so the address is known before it exists.
export const ACCOUNT_SALT = keccak256(toHex("userDexBot:mm-account:v1"));

const hybridAbi = parseAbi([
  "function owner() view returns (address)",
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
const nonceAbi = parseAbi([
  "function incrementNonce(address _delegationManager)",
  "function currentNonce(address _delegationManager, address _delegator) view returns (uint256)",
]);
const periodTransferAbi = parseAbi([
  "function getAvailableAmount(bytes32 _delegationHash, address _delegationManager, bytes _terms) view returns (uint256 availableAmount, bool isNewPeriod, uint256 currentPeriod)",
]);

const EIP1271_MAGIC = "0x1626ba7e";
const APPROVE = toFunctionSelector("approve(address,uint256)");
const SWAP = toFunctionSelector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))");
const word = (value) => pad(value, { size: 32 });
const EMPTY = new Uint8Array(0);

// ---------------------------------------------------------------------------
// The smart account

export async function predictAccount(owner) {
  return getCounterfactualAccountData({
    factory: MM.factory,
    implementations: MM.implementations,
    implementation: "Hybrid",
    deployParams: [getAddress(owner), [], [], []],
    deploySalt: ACCOUNT_SALT,
  });
}

/** The transaction the user sends from MetaMask to create their smart account. The user pays the gas. */
export async function buildCreateAccountTx(owner) {
  const { address, factoryData } = await predictAccount(owner);
  return { account: address, tx: { to: MM.factory, value: 0n, data: factoryData } };
}

export async function isDeployed(address) {
  const code = await publicClient.getCode({ address });
  return Boolean(code && code !== "0x");
}

export async function accountOwner(account) {
  return publicClient.readContract({ address: account, abi: hybridAbi, functionName: "owner" });
}

// ---------------------------------------------------------------------------
// Delegations

/** The EIP-712 message MetaMask shows and signs for a delegation. */
export function delegationTypedData(delegation) {
  return {
    domain: { name: "DelegationManager", version: "1", chainId: config.chain.id, verifyingContract: MM.delegationManager },
    types: SIGNABLE_DELEGATION_TYPED_DATA,
    primaryType: "Delegation",
    message: {
      delegate: delegation.delegate,
      delegator: delegation.delegator,
      authority: delegation.authority,
      caveats: delegation.caveats.map(({ enforcer, terms }) => ({ enforcer, terms })),
      salt: BigInt(delegation.salt),
    },
  };
}

/** Asks the smart account itself whether the signature is valid, exactly as the DelegationManager will. */
export async function isValidDelegationSignature(delegation, signature) {
  const hash = hashTypedData(delegationTypedData(delegation));
  const result = await publicClient.readContract({
    address: delegation.delegator,
    abi: hybridAbi,
    functionName: "isValidSignature",
    args: [hash, signature],
  });
  return result === EIP1271_MAGIC;
}

export const delegationHash = (delegation) => hashDelegation(delegation);

/**
 * The owner's own delegation. Lets the user act on their smart account by sending one MetaMask
 * transaction: withdraw DEOD, USDT or BNB, and stop the bot. Only the owner can use it.
 */
export function buildOwnerDelegation(owner, account) {
  const targets = [TOKENS.DEOD.address, TOKENS.USDT.address, MM.enforcers.NonceEnforcer, getAddress(owner)];
  return {
    delegate: getAddress(owner),
    delegator: account,
    authority: ROOT_AUTHORITY,
    caveats: [{ enforcer: MM.enforcers.AllowedTargetsEnforcer, terms: createAllowedTargetsTerms({ targets }), args: "0x" }],
    salt: word(toHex(1n)),
    signature: "0x",
  };
}

// The bot's permission has four groups. Each trade uses the ones it needs.
export const GROUP = { APPROVE: 0, SELL_USDT: 1, SELL_DEOD: 2, GAS: 3 };

const inner = (enforcer, terms) => ({ enforcer, terms, args: EMPTY });

function swapGroup(account, tokenIn, tokenOut) {
  const E = MM.enforcers;
  return [
    inner(E.AllowedTargetsEnforcer, createAllowedTargetsTerms({ targets: [ADDRESSES.swapRouter] })),
    inner(E.AllowedMethodsEnforcer, createAllowedMethodsTerms({ selectors: [SWAP] })),
    inner(E.ValueLteEnforcer, createValueLteTerms({ maxValue: 0n })),
    // exactInputSingle's fields sit at fixed offsets: tokenIn, tokenOut, pool fee, recipient.
    inner(E.AllowedCalldataEnforcer, createAllowedCalldataTerms({ startIndex: 4, value: word(tokenIn.address) })),
    inner(E.AllowedCalldataEnforcer, createAllowedCalldataTerms({ startIndex: 36, value: word(tokenOut.address) })),
    inner(E.AllowedCalldataEnforcer, createAllowedCalldataTerms({ startIndex: 68, value: word(toHex(config.rules.poolFee)) })),
    inner(E.AllowedCalldataEnforcer, createAllowedCalldataTerms({ startIndex: 100, value: word(account) })),
    // No on-chain size cap: MetaMask's balance-change rule reverts whenever the account holds less than
    // the cap, so per-trade and daily limits are checked by the bot before each trade instead.
  ];
}

export function botPermissionGroups(account, botAddress, startDate) {
  const E = MM.enforcers;
  const { DEOD, USDT } = TOKENS;
  return [
    // Approve DEOD or USDT for the PancakeSwap router only.
    [
      inner(E.AllowedTargetsEnforcer, createAllowedTargetsTerms({ targets: [DEOD.address, USDT.address] })),
      inner(E.AllowedMethodsEnforcer, createAllowedMethodsTerms({ selectors: [APPROVE] })),
      inner(E.ValueLteEnforcer, createValueLteTerms({ maxValue: 0n })),
      inner(E.AllowedCalldataEnforcer, createAllowedCalldataTerms({ startIndex: 4, value: word(ADDRESSES.swapRouter) })),
    ],
    swapGroup(account, USDT, DEOD),
    swapGroup(account, DEOD, USDT),
    // Repaying the bot's gas: plain BNB to the bot's own address only, capped per day.
    [
      inner(
        E.NativeTokenPeriodTransferEnforcer,
        createNativeTokenPeriodTransferTerms({ periodAmount: config.rules.dailyGasCap, periodDuration: 86_400, startDate }),
      ),
      inner(E.AllowedTargetsEnforcer, createAllowedTargetsTerms({ targets: [getAddress(botAddress)] })),
      // Empty call data, as bytes: the group builder rejects the empty hex string "0x".
      inner(E.ExactCalldataEnforcer, createExactCalldataTerms({ calldata: "0x" }, { out: "bytes" })),
    ],
  ];
}

export async function currentNonce(account) {
  return publicClient.readContract({
    address: MM.enforcers.NonceEnforcer,
    abi: nonceAbi,
    functionName: "currentNonce",
    args: [MM.delegationManager, account],
  });
}

/**
 * The bot's permission, for the user to sign once. It includes the account's current nonce,
 * so the user's "Stop bot" transaction (which bumps the nonce) invalidates it immediately.
 */
export async function buildBotDelegation(account, botAddress) {
  const [nonce, block] = await Promise.all([currentNonce(account), publicClient.getBlock()]);
  const startDate = Number(block.timestamp);
  const groups = botPermissionGroups(account, botAddress, startDate);
  const E = MM.enforcers;
  return {
    delegate: getAddress(botAddress),
    delegator: account,
    authority: ROOT_AUTHORITY,
    caveats: [
      { enforcer: E.NonceEnforcer, terms: createNonceTerms({ nonce: toHex(nonce) }), args: "0x" },
      { enforcer: E.LogicalOrWrapperEnforcer, terms: createLogicalOrWrapperTerms({ caveatGroups: groups }), args: "0x" },
    ],
    salt: bytesToHex(randomBytes(32)),
    signature: "0x",
  };
}

/** True while the signed bot permission still matches the account's nonce, meaning the user hasn't stopped it. */
export async function isBotDelegationLive(account, delegation) {
  const { nonce } = decodeNonceTerms(delegation.caveats[0].terms);
  return BigInt(nonce) === (await currentNonce(account));
}

/** Picks which permission group a redemption uses. Group selection is not part of what the user signed. */
export function withGroup(delegation, groupIndex) {
  const { caveatGroups } = decodeLogicalOrWrapperTerms(delegation.caveats[1].terms);
  const args = createLogicalOrWrapperArgs({ groupIndex: BigInt(groupIndex), caveatArgs: caveatGroups[groupIndex].map(() => EMPTY) });
  return { ...delegation, caveats: delegation.caveats.map((c, i) => (i === 1 ? { ...c, args } : c)) };
}

/** How much BNB the bot may still take today under this permission to repay its gas. */
export async function gasBudgetLeftToday(delegation) {
  const { caveatGroups } = decodeLogicalOrWrapperTerms(delegation.caveats[1].terms);
  const gasTerms = caveatGroups[GROUP.GAS][0].terms;
  const [available] = await publicClient.readContract({
    address: MM.enforcers.NativeTokenPeriodTransferEnforcer,
    abi: periodTransferAbi,
    functionName: "getAvailableAmount",
    // The OR-group enforcer calls the gas enforcer, so it is the "delegation manager" the gas enforcer sees.
    args: [delegationHash(delegation), MM.enforcers.LogicalOrWrapperEnforcer, gasTerms],
  });
  return available;
}

/** Encodes one DelegationManager call that runs several redemptions, one call each, in order. */
export function encodeRedeem(items) {
  return DelegationManager.encode.redeemDelegations({
    delegations: items.map(({ delegation }) => [delegation]),
    modes: items.map(() => ExecutionMode.SingleDefault),
    executions: items.map(({ execution }) => [execution]),
  });
}

// ---------------------------------------------------------------------------
// Owner actions, sent from MetaMask with the owner's delegation

export const ownerActionTx = (ownerDelegation, execution) => ({
  to: MM.delegationManager,
  value: 0n,
  data: encodeRedeem([{ delegation: ownerDelegation, execution }]),
});

/** "Stop bot": bumps the account's nonce, which invalidates every bot permission signed before. */
export const stopBotExecution = () =>
  createExecution({
    target: MM.enforcers.NonceEnforcer,
    callData: encodeFunctionData({ abi: nonceAbi, functionName: "incrementNonce", args: [MM.delegationManager] }),
  });

/** Withdrawals always go to the owner's MetaMask. */
export function withdrawExecution(owner, asset, amount) {
  if (asset.symbol === config.nativeSymbol) return createExecution({ target: getAddress(owner), value: amount, callData: "0x" });
  return createExecution({
    target: asset.address,
    callData: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(owner), amount] }),
  });
}

// Bot executions
export const approveExecution = (token) =>
  createExecution({
    target: token.address,
    callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ADDRESSES.swapRouter, maxUint256] }),
  });

/** Pays the bot back, in BNB from the smart account, for the gas it spent sending the trade. */
export const gasRepayExecution = (botAddress, amount) => createExecution({ target: getAddress(botAddress), value: amount, callData: "0x" });

export const sameAddress = (a, b) => isAddressEqual(getAddress(a), getAddress(b));
