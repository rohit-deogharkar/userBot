import { Status } from "zodiac-roles-sdk";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Safe reports failures as short codes. These are the ones users can run into.
const SAFE_ERRORS = {
  GS013: "The wallet transaction failed.",
  GS025: "Only the wallet owner can send this.",
  GS026: "The signature is not from the wallet owner.",
  GS104: "The bot is not enabled on this wallet.",
};

/** Explains why the blockchain rejected a call, or returns null if it wasn't a contract revert. */
export function describeRevert(error) {
  const revert = error?.walk?.((e) => e?.data?.errorName);
  const data = revert?.data;
  if (!data?.errorName) return null;
  if (data.errorName === "ConditionViolation") {
    return `Blocked by the wallet's rules: ${Status[Number(data.args?.[0])] ?? data.args?.[0]}`;
  }
  if (data.errorName === "Error" && SAFE_ERRORS[data.args?.[0]]) {
    return `${SAFE_ERRORS[data.args[0]]} (${data.args[0]})`;
  }
  const args = data.args?.length ? `(${data.args.map(String).join(", ")})` : "";
  return `Blocked by contract: ${data.errorName}${args}`;
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
