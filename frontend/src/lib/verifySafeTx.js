import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  hexToBigInt,
  hexToNumber,
  isAddressEqual,
  parseAbi,
  size,
  slice,
  toFunctionSelector,
  zeroAddress,
} from "viem";
import testnetContracts from "./testnetContracts.json";

// The browser checks every wallet action before asking MetaMask to sign it.
// These addresses are hard-coded here on purpose, so a compromised backend cannot change them.
const MULTISEND_CALL_ONLY = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
const MAINNET = {
  tokens: {
    DEOD: "0x3510FbBC13090F991Ffa523527113A166161683e",
    USDT: "0x55d398326f99059fF775485246999027B3197955",
  },
  // PancakeSwap Smart Router.
  router: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
};
const TESTNET = {
  tokens: {
    DEOD: "0x3fb98B9DaebFdaA06b72Df9704aDe353500e7CFf",
    // Written by "npm run testnet:setup" in the backend.
    USDT: testnetContracts.usdt,
  },
  router: "0x9a489505a00cE272eAa5e07Dba6491314CaE3796",
};
// BNB Chain, its local fork, and BNB testnet.
const EXPECTED_BY_CHAIN = { 56: MAINNET, 561337: MAINNET, 97: TESTNET };

// The only functions the bot's rules may cover: approve on the two tokens, and one swap function.
const APPROVE = toFunctionSelector("approve(address,uint256)");
const SWAP = toFunctionSelector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))");
const allowedScopes = (expected) => [
  [expected.tokens.DEOD, APPROVE],
  [expected.tokens.USDT, APPROVE],
  [expected.router, SWAP],
];

const safeAbi = parseAbi(["function enableModule(address module)", "function disableModule(address prevModule, address module)"]);
const multiSendAbi = parseAbi(["function multiSend(bytes transactions)"]);
const rolesAbi = parseAbi([
  "function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)",
  "function scopeTarget(bytes32 roleKey, address targetAddress)",
  "function scopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, (uint8 parent, uint8 paramType, uint8 operator, bytes compValue)[] conditions, uint8 options)",
  "function setAllowance(bytes32 key, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp)",
]);

class RefuseToSign extends Error {}

function must(condition, reason) {
  if (!condition) throw new RefuseToSign(`Refusing to sign: ${reason}`);
}

function decode(abi, data, reason) {
  try {
    return decodeFunctionData({ abi, data });
  } catch {
    throw new RefuseToSign(`Refusing to sign: ${reason}`);
  }
}

/** Splits a MultiSend payload back into its individual calls. */
function decodeMultiSend(data) {
  const { args } = decode(multiSendAbi, data, "the batch is not a MultiSend call.");
  const packed = args[0];
  const calls = [];
  let i = 0;
  while (i < size(packed)) {
    const operation = hexToNumber(slice(packed, i, i + 1));
    const to = getAddress(slice(packed, i + 1, i + 21));
    const value = hexToBigInt(slice(packed, i + 21, i + 53));
    const length = hexToNumber(slice(packed, i + 53, i + 85));
    const callData = length ? slice(packed, i + 85, i + 85 + length) : "0x";
    calls.push({ operation, to, value, data: callData });
    i += 85 + length;
  }
  return calls;
}

function checkEnableBot(message, wallet, config, expected) {
  const ALLOWED_SCOPES = allowedScopes(expected);
  must(message.operation === 1 && isAddressEqual(message.to, MULTISEND_CALL_ONLY), "the batch does not use the standard MultiSend contract.");
  let enablesModule = false;
  for (const call of decodeMultiSend(message.data)) {
    must(call.operation === 0 && call.value === 0n, "a call in the batch sends ETH or uses delegatecall.");
    if (isAddressEqual(call.to, wallet.safeAddress)) {
      const { functionName, args } = decode(safeAbi, call.data, "the batch changes your wallet in an unexpected way.");
      must(functionName === "enableModule" && isAddressEqual(args[0], wallet.rolesAddress), "the batch enables an unknown module.");
      enablesModule = true;
      continue;
    }
    must(isAddressEqual(call.to, wallet.rolesAddress), `the batch calls an unexpected contract ${call.to}.`);
    const { functionName, args } = decode(rolesAbi, call.data, "the batch calls an unexpected function on your rules module.");
    if (functionName === "assignRoles") {
      must(isAddressEqual(args[0], config.botAddress), "the batch gives the bot role to an unknown address.");
    }
    if (functionName === "scopeTarget") {
      must(ALLOWED_SCOPES.some(([target]) => isAddressEqual(target, args[1])), `the rules cover an unexpected contract ${args[1]}.`);
    }
    if (functionName === "scopeFunction") {
      must(
        ALLOWED_SCOPES.some(([target, selector]) => isAddressEqual(target, args[1]) && selector === args[2]),
        `the rules allow an unexpected function ${args[2]} on ${args[1]}.`,
      );
    }
  }
  must(enablesModule, "the batch does not switch the bot on.");
}

/**
 * Checks that what MetaMask is about to sign matches what the user asked for.
 * Withdraw and stop are checked exactly. For enable, it checks which contracts and functions
 * the rules touch, but not the details of each rule's conditions.
 */
export function verifySafeTx({ kind, request, typedData, owner, wallet, config }) {
  const { domain, message } = typedData;
  must(domain.chainId === config.chain.id, "it is for a different network.");
  const expected = EXPECTED_BY_CHAIN[domain.chainId];
  must(expected && Object.values(expected.tokens).every(Boolean), "this app does not know the contracts for this network.");
  must(isAddressEqual(domain.verifyingContract, wallet.safeAddress), "it is not for your bot wallet.");
  must(
    message.safeTxGas === 0n &&
      message.baseGas === 0n &&
      message.gasPrice === 0n &&
      isAddressEqual(message.gasToken, zeroAddress) &&
      isAddressEqual(message.refundReceiver, zeroAddress),
    "it would pay a gas refund out of your wallet.",
  );

  if (kind === "withdraw") {
    must(message.operation === 0, "a withdrawal must be a plain call.");
    const token = expected.tokens[request.token];
    if (!token) {
      // Not a trading token, so it must be the native coin (BNB) sent straight to the owner.
      must(request.token === config.nativeSymbol, "unknown token.");
      must(isAddressEqual(message.to, owner) && message.data === "0x", `the ${config.nativeSymbol} is not going to your MetaMask.`);
    } else {
      must(isAddressEqual(message.to, token) && message.value === 0n, "it is not a transfer of the token you chose.");
      const { functionName, args } = decode(erc20Abi, message.data, "it is not a token transfer.");
      must(functionName === "transfer" && isAddressEqual(args[0], owner), "the funds are not going to your MetaMask.");
    }
  } else if (kind === "stop-bot") {
    must(message.operation === 0 && message.value === 0n && isAddressEqual(message.to, wallet.safeAddress), "stopping the bot must be a call to your own wallet.");
    const { functionName, args } = decode(safeAbi, message.data, "it does not switch the bot off.");
    must(functionName === "disableModule" && isAddressEqual(args[1], wallet.rolesAddress), "it does not switch the bot off.");
  } else if (kind === "enable-bot") {
    checkEnableBot(message, wallet, config, expected);
  } else {
    must(false, `unknown action "${kind}".`);
  }
}
