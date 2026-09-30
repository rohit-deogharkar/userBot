import { decodeRevertReason } from "@metamask/smart-accounts-kit/utils";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Reasons MetaMask's permission contracts (caveat enforcers) and PancakeSwap give, in plain words.
const REASONS = {
  "NonceEnforcer:invalid-nonce": "The bot is stopped for this account.",
  "NativeTokenPeriodTransferEnforcer:transfer-amount-exceeded": "Blocked by the permission: today's gas budget is used up.",
  "ExactCalldataEnforcer:invalid-calldata": "Blocked by the permission: the gas repayment can only be a plain BNB transfer.",
  "AllowedCalldataEnforcer:invalid-calldata": "Blocked by the permission: the transaction details are not what the user allowed.",
  "AllowedTargetsEnforcer:target-address-not-allowed": "Blocked by the permission: that contract is not allowed.",
  "AllowedMethodsEnforcer:method-not-allowed": "Blocked by the permission: that function is not allowed.",
  "ValueLteEnforcer:value-too-high": "Blocked by the permission: sending BNB is not allowed.",
  InvalidDelegate: "Blocked: only the holder of this permission can use it.",
  InvalidDelegator: "Blocked: the permission is not for this account.",
  CannotUseADisabledDelegation: "Blocked: this permission was switched off.",
  STF: "The account does not hold enough of the token, or the token is not approved.",
  "Too little received": "The price moved more than the allowed slippage.",
};

/** Explains why the blockchain rejected a call, or returns null if it wasn't a contract revert. */
export function describeRevert(error) {
  const decoded = decodeRevertReason(error);
  const reason = decoded?.message || decoded?.errorName;
  if (reason) return REASONS[reason] ?? REASONS[decoded.errorName] ?? `Blocked: ${reason}`;
  const viemRevert = error?.walk?.((e) => e?.data?.errorName || e?.reason);
  const name = viemRevert?.data?.errorName === "Error" ? viemRevert.data.args?.[0] : viemRevert?.data?.errorName ?? viemRevert?.reason;
  if (name) return REASONS[name] ?? `Blocked: ${name}`;
  return null;
}

/** True when the blockchain node could not be reached at all, for example because anvil isn't running. */
export function isNodeUnreachable(error) {
  return Boolean(error?.walk?.((e) => e?.name === "HttpRequestError" || e?.name === "TimeoutError" || e?.code === "ECONNREFUSED"));
}

/** Turns viem and contract errors into a short message that is safe to show users. */
export function describeError(error) {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  if (isNodeUnreachable(error)) return { status: 503, message: "The blockchain node is not responding. Please try again in a moment." };
  const revert = describeRevert(error);
  if (revert) return { status: 400, message: revert };
  return { status: 500, message: error?.shortMessage || error?.message || "Unexpected error" };
}
