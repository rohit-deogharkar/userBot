// The browser checks everything MetaMask is asked to send or sign, before MetaMask opens.
// It rebuilds each item itself from MetaMask's own contract registry and hard-coded token
// addresses, so a compromised backend cannot slip anything else past the user.
import { DELEGATOR_CONTRACTS } from "@metamask/delegation-deployments";
import {
  createAllowedCalldataTerms,
  createAllowedMethodsTerms,
  createAllowedTargetsTerms,
  createExactCalldataTerms,
  createLogicalOrWrapperTerms,
  createNativeTokenPeriodTransferTerms,
  createNonceTerms,
  createValueLteTerms,
  decodeLogicalOrWrapperTerms,
  decodeNativeTokenPeriodTransferTerms,
} from "@metamask/delegation-core";
import { DelegationManager as delegationManagerAbis } from "@metamask/delegation-abis";
import { ROOT_AUTHORITY, getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { decodeDelegations, getCounterfactualAccountData } from "@metamask/smart-accounts-kit/utils";
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  hexToBigInt,
  isAddressEqual,
  keccak256,
  pad,
  parseAbi,
  size,
  slice,
  toFunctionSelector,
  toHex,
} from "viem";
import testnetContracts from "./testnetContracts.json";

// Must match the backend's salt, so both work out the same smart account address.
const ACCOUNT_SALT = keccak256(toHex("userDexBot:mm-account:v1"));
const POOL_FEE = 10_000;
const DAY = 86_400;
const SINGLE_DEFAULT_MODE = pad("0x00", { size: 32 });

const MAINNET = {
  metamaskChainId: 56,
  tokens: {
    DEOD: "0x3510FbBC13090F991Ffa523527113A166161683e",
    USDT: "0x55d398326f99059fF775485246999027B3197955",
  },
  // PancakeSwap Smart Router.
  router: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
};
const TESTNET = {
  metamaskChainId: 97,
  tokens: {
    DEOD: "0x3fb98B9DaebFdaA06b72Df9704aDe353500e7CFf",
    // Written by "npm run testnet:setup" in the backend.
    USDT: testnetContracts.usdt,
  },
  router: "0x9a489505a00cE272eAa5e07Dba6491314CaE3796",
};
// BNB Chain, its local fork, and BNB testnet.
const BY_CHAIN = { 56: MAINNET, 561337: MAINNET, 97: TESTNET };

const APPROVE = toFunctionSelector("approve(address,uint256)");
const SWAP = toFunctionSelector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))");
const nonceAbi = parseAbi(["function incrementNonce(address _delegationManager)"]);
const dmAbi = delegationManagerAbis.abi ?? delegationManagerAbis;

class RefuseToSend extends Error {}
function must(condition, reason) {
  if (!condition) throw new RefuseToSend(`Refusing to continue: ${reason}`);
}
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const word = (value) => pad(value, { size: 32 });
const EMPTY = new Uint8Array(0);

function contextFor(chainId) {
  const expected = BY_CHAIN[chainId];
  must(expected && Object.values(expected.tokens).every(Boolean), "this app does not know the contracts for this network.");
  const env = getSmartAccountsEnvironment(expected.metamaskChainId);
  const orWrapper = DELEGATOR_CONTRACTS["1.3.0"][String(expected.metamaskChainId)].LogicalOrWrapperEnforcer;
  return { ...expected, env, E: { ...env.caveatEnforcers, LogicalOrWrapperEnforcer: orWrapper }, DM: env.DelegationManager };
}

function checkTypedData(delegation, typedData, ctx, chainId) {
  const { domain, message } = typedData;
  must(
    domain.name === "DelegationManager" && domain.version === "1" && Number(domain.chainId) === chainId && same(domain.verifyingContract, ctx.DM),
    "the signature is not for MetaMask's DelegationManager on this network.",
  );
  must(
    same(message.delegate, delegation.delegate) &&
      same(message.delegator, delegation.delegator) &&
      same(message.authority, delegation.authority) &&
      BigInt(message.salt) === BigInt(delegation.salt) &&
      message.caveats.length === delegation.caveats.length &&
      message.caveats.every((c, i) => same(c.enforcer, delegation.caveats[i].enforcer) && same(c.terms, delegation.caveats[i].terms)),
    "what MetaMask would sign is different from the permission shown.",
  );
}

/** The owner's own permission, rebuilt here exactly as the backend should have built it. */
function expectedOwnerCaveats(owner, ctx) {
  const targets = [ctx.tokens.DEOD, ctx.tokens.USDT, ctx.E.NonceEnforcer, getAddress(owner)];
  return [{ enforcer: ctx.E.AllowedTargetsEnforcer, terms: createAllowedTargetsTerms({ targets }) }];
}

function checkOwnerDelegation(delegation, { owner, account, ctx }) {
  must(same(delegation.delegate, owner), "the owner permission is not for your MetaMask.");
  must(same(delegation.delegator, account), "the owner permission is not for your smart account.");
  must(same(delegation.authority, ROOT_AUTHORITY), "the owner permission is not a top-level permission.");
  const expected = expectedOwnerCaveats(owner, ctx);
  must(
    delegation.caveats.length === expected.length &&
      delegation.caveats.every((c, i) => same(c.enforcer, expected[i].enforcer) && same(c.terms, expected[i].terms)),
    "the owner permission has unexpected rules.",
  );
}

/**
 * Checks the smart account creation: the standard MetaMask smart account, owned only by the user,
 * and the owner permission that goes with it.
 */
export async function verifyCreateAccount({ created, owner, chainId }) {
  const ctx = contextFor(chainId);
  const { address, factoryData } = await getCounterfactualAccountData({
    factory: ctx.env.SimpleFactory,
    implementations: ctx.env.implementations,
    implementation: "Hybrid",
    deployParams: [getAddress(owner), [], [], []],
    deploySalt: ACCOUNT_SALT,
  });
  must(same(created.account, address), "the smart account is not the one your MetaMask would own.");
  must(
    same(created.tx.to, ctx.env.SimpleFactory) && same(created.tx.data, factoryData) && BigInt(created.tx.value ?? 0) === 0n,
    "the transaction does not create the standard MetaMask smart account.",
  );
  checkOwnerDelegation(created.ownerDelegation, { owner, account: address, ctx });
  checkTypedData(created.ownerDelegation, created.typedData, ctx, chainId);
}

function swapGroup(ctx, account, tokenIn, tokenOut) {
  const { E } = ctx;
  return [
    { enforcer: E.AllowedTargetsEnforcer, terms: createAllowedTargetsTerms({ targets: [ctx.router] }), args: EMPTY },
    { enforcer: E.AllowedMethodsEnforcer, terms: createAllowedMethodsTerms({ selectors: [SWAP] }), args: EMPTY },
    { enforcer: E.ValueLteEnforcer, terms: createValueLteTerms({ maxValue: 0n }), args: EMPTY },
    { enforcer: E.AllowedCalldataEnforcer, terms: createAllowedCalldataTerms({ startIndex: 4, value: word(tokenIn) }), args: EMPTY },
    { enforcer: E.AllowedCalldataEnforcer, terms: createAllowedCalldataTerms({ startIndex: 36, value: word(tokenOut) }), args: EMPTY },
    { enforcer: E.AllowedCalldataEnforcer, terms: createAllowedCalldataTerms({ startIndex: 68, value: word(toHex(POOL_FEE)) }), args: EMPTY },
    { enforcer: E.AllowedCalldataEnforcer, terms: createAllowedCalldataTerms({ startIndex: 100, value: word(account) }), args: EMPTY },
  ];
}

/**
 * Checks the bot's permission before the user signs it, and returns the limits it grants in plain numbers
 * so the page can show exactly what is being signed.
 */
export function verifyBotPermission({ request, account, botAddress, chainId, currentNonce }) {
  const ctx = contextFor(chainId);
  const d = request.delegation;
  must(same(d.delegate, botAddress), "the permission is not for this app's bot.");
  must(same(d.delegator, account), "the permission is not for your smart account.");
  must(same(d.authority, ROOT_AUTHORITY), "the permission is not a top-level permission.");
  must(d.caveats.length === 2, "the permission has unexpected rules.");
  must(same(d.caveats[0].enforcer, ctx.E.NonceEnforcer), "the permission cannot be stopped with one transaction.");
  must(same(d.caveats[0].terms, createNonceTerms({ nonce: toHex(currentNonce) })), "the permission uses an outdated stop switch.");
  must(same(d.caveats[1].enforcer, ctx.E.LogicalOrWrapperEnforcer), "the permission has unexpected rules.");

  // Read the daily gas cap the user is being asked to grant, then rebuild the whole permission around it.
  const { caveatGroups } = decodeLogicalOrWrapperTerms(d.caveats[1].terms);
  must(caveatGroups.length === 4 && caveatGroups[1].length === 7 && caveatGroups[2].length === 7 && caveatGroups[3].length === 3, "the permission has unexpected rules.");
  const gas = decodeNativeTokenPeriodTransferTerms(caveatGroups[3][0].terms);
  must(Number(gas.periodDuration) === DAY, "the gas cap does not reset daily.");

  const { E } = ctx;
  const expectedGroups = [
    [
      { enforcer: E.AllowedTargetsEnforcer, terms: createAllowedTargetsTerms({ targets: [ctx.tokens.DEOD, ctx.tokens.USDT] }), args: EMPTY },
      { enforcer: E.AllowedMethodsEnforcer, terms: createAllowedMethodsTerms({ selectors: [APPROVE] }), args: EMPTY },
      { enforcer: E.ValueLteEnforcer, terms: createValueLteTerms({ maxValue: 0n }), args: EMPTY },
      { enforcer: E.AllowedCalldataEnforcer, terms: createAllowedCalldataTerms({ startIndex: 4, value: word(ctx.router) }), args: EMPTY },
    ],
    swapGroup(ctx, account, ctx.tokens.USDT, ctx.tokens.DEOD),
    swapGroup(ctx, account, ctx.tokens.DEOD, ctx.tokens.USDT),
    // Gas repayment: plain BNB, only to the bot's own address.
    [
      {
        enforcer: E.NativeTokenPeriodTransferEnforcer,
        terms: createNativeTokenPeriodTransferTerms({ periodAmount: gas.periodAmount, periodDuration: DAY, startDate: Number(gas.startDate) }),
        args: EMPTY,
      },
      { enforcer: E.AllowedTargetsEnforcer, terms: createAllowedTargetsTerms({ targets: [getAddress(botAddress)] }), args: EMPTY },
      { enforcer: E.ExactCalldataEnforcer, terms: createExactCalldataTerms({ calldata: "0x" }, { out: "bytes" }), args: EMPTY },
    ],
  ];
  must(same(createLogicalOrWrapperTerms({ caveatGroups: expectedGroups }), d.caveats[1].terms), "the permission allows more than DEOD/USDT trading and the capped gas.");
  checkTypedData(d, request.typedData, ctx, chainId);
  return { dailyGasCap: gas.periodAmount };
}

/** Splits a single execution back into target, value and call data. */
function decodeSingleExecution(encoded) {
  return {
    target: getAddress(slice(encoded, 0, 20)),
    value: hexToBigInt(slice(encoded, 20, 52)),
    callData: size(encoded) > 52 ? slice(encoded, 52) : "0x",
  };
}

/**
 * Checks a stop or withdraw transaction: it must go through MetaMask's DelegationManager using the user's
 * own permission, and do exactly what they asked, with funds going only to their MetaMask.
 */
export function verifyOwnerAction({ kind, request, tx, owner, account, chainId, nativeSymbol }) {
  const ctx = contextFor(chainId);
  must(same(tx.to, ctx.DM) && BigInt(tx.value ?? 0) === 0n, "the transaction does not go to MetaMask's DelegationManager.");
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: dmAbi, data: tx.data });
  } catch {
    must(false, "the transaction is not a permission redemption.");
  }
  must(decoded.functionName === "redeemDelegations", "the transaction is not a permission redemption.");
  const [contexts, modes, executions] = decoded.args;
  must(contexts.length === 1 && modes.length === 1 && executions.length === 1 && same(modes[0], SINGLE_DEFAULT_MODE), "the transaction does more than one thing.");

  const [delegation, ...rest] = decodeDelegations(contexts[0]);
  must(rest.length === 0, "the transaction uses a chain of permissions.");
  checkOwnerDelegation(delegation, { owner, account, ctx });

  const execution = decodeSingleExecution(executions[0]);
  if (kind === "stop-bot") {
    must(
      same(execution.target, ctx.E.NonceEnforcer) &&
        execution.value === 0n &&
        same(execution.callData, encodeFunctionData({ abi: nonceAbi, functionName: "incrementNonce", args: [ctx.DM] })),
      "it does not stop the bot.",
    );
  } else if (kind === "withdraw") {
    const token = ctx.tokens[request.token];
    if (!token) {
      must(request.token === nativeSymbol, "unknown token.");
      must(same(execution.target, owner) && execution.callData === "0x", `the ${nativeSymbol} is not going to your MetaMask.`);
    } else {
      must(same(execution.target, token) && execution.value === 0n, "it is not a transfer of the token you chose.");
      let transfer;
      try {
        transfer = decodeFunctionData({ abi: erc20Abi, data: execution.callData });
      } catch {
        must(false, "it is not a token transfer.");
      }
      must(transfer.functionName === "transfer" && isAddressEqual(transfer.args[0], owner), "the funds are not going to your MetaMask.");
    }
  } else {
    must(false, `unknown action "${kind}".`);
  }
}
