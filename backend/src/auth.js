import jwt from "jsonwebtoken";
import { getAddress } from "viem";
import { generateSiweNonce, parseSiweMessage } from "viem/siwe";
import { publicClient } from "./chain.js";
import { config } from "./config.js";
import { nonces } from "./db.js";
import { HttpError } from "./errors.js";

// Sign-In with Ethereum: the user proves they control a MetaMask address by signing a
// one-time message. Signing a message costs nothing and cannot move funds.

const NONCE_TTL_MS = 10 * 60 * 1000;

export async function issueNonce() {
  const nonce = generateSiweNonce();
  await nonces.add(nonce, NONCE_TTL_MS);
  return nonce;
}

export async function verifyLogin(message, signature) {
  const fields = parseSiweMessage(message);
  if (!fields.nonce || !fields.address) throw new HttpError(400, "Malformed sign-in message.");
  if (fields.chainId !== config.chain.id) throw new HttpError(400, `Please sign in on ${config.chain.name}.`);

  const valid = await publicClient.verifySiweMessage({
    message,
    signature,
    domain: config.appDomain,
    nonce: fields.nonce,
  });
  if (!valid) throw new HttpError(401, "Sign-in signature is not valid.");
  if (!(await nonces.consume(fields.nonce))) throw new HttpError(401, "Sign-in message expired or was already used.");

  const address = getAddress(fields.address);
  const token = jwt.sign({ sub: address }, config.jwtSecret, { expiresIn: "12h" });
  return { address, token };
}

export function requireAuth(req, _res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, "Please sign in."));
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = { address: getAddress(payload.sub) };
    next();
  } catch {
    next(new HttpError(401, "Your session expired. Please sign in again."));
  }
}
