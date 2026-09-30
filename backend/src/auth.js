import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";
import { getAddress, isAddressEqual } from "viem";
import { generateSiweNonce, parseSiweMessage } from "viem/siwe";
import { publicClient } from "./chain.js";
import { config } from "./config.js";
import { members, nonces } from "./db.js";
import { HttpError } from "./errors.js";

// Users log in with a username and password, then link their MetaMask once by signing a message.
// The login only identifies them to this app. Their funds stay under MetaMask's control:
// every deposit, withdrawal and bot permission still needs MetaMask's own confirmation.

const USERNAME = /^[a-z0-9_.-]{3,32}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
const SESSION_LENGTH = "12h";
const NONCE_TTL_MS = 10 * 60 * 1000;

// Passwords are stored only as salted scrypt hashes, never as they were typed.
const scryptAsync = promisify(scrypt);
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1 };

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function passwordMatches(password, stored) {
  const [, saltHex, hashHex] = stored.split("$");
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length, SCRYPT_OPTIONS);
  return timingSafeEqual(actual, expected);
}

// Unknown usernames are checked against this, so they take as long as a wrong password and don't reveal who has a login.
const UNKNOWN_USER_HASH = await hashPassword(randomBytes(16).toString("hex"));

// Slows down password guessing: 10 wrong passwords for one username from one IP address lock it for 15 minutes.
// Kept in memory, so it resets when the server restarts.
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;
const failures = new Map();

function checkNotLockedOut(key) {
  const entry = failures.get(key);
  if (!entry) return;
  if (Date.now() - entry.since > LOCKOUT_MS) failures.delete(key);
  else if (entry.count >= MAX_FAILURES) throw new HttpError(429, "Too many wrong passwords. Try again in 15 minutes.");
}

function recordFailure(key) {
  const entry = failures.get(key) ?? { count: 0, since: Date.now() };
  entry.count += 1;
  failures.set(key, entry);
}

function readCredentials(body) {
  return { username: String(body?.username ?? "").trim().toLowerCase(), password: String(body?.password ?? "") };
}

const addressOf = (member) => (member.address ? getAddress(member.address) : null);

function startSession(member) {
  return {
    token: jwt.sign({ sub: member._id }, config.jwtSecret, { expiresIn: SESSION_LENGTH }),
    username: member.username,
    address: addressOf(member),
  };
}

export async function signUp(body) {
  const { username, password } = readCredentials(body);
  if (!USERNAME.test(username)) {
    throw new HttpError(400, "Usernames need 3 to 32 characters: letters, numbers, dots, dashes or underscores.");
  }
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new HttpError(400, `Passwords need ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`);
  }
  const member = await members.create({ id: randomUUID(), username, passwordHash: await hashPassword(password) });
  if (!member) throw new HttpError(409, "That username is taken.");
  return startSession(member);
}

export async function logIn(body, ip) {
  const { username, password } = readCredentials(body);
  const key = `${ip}|${username}`;
  checkNotLockedOut(key);
  const member = username ? await members.findByUsername(username) : null;
  const tooLong = password.length > MAX_PASSWORD;
  const matches = !tooLong && (await passwordMatches(password, member?.passwordHash ?? UNKNOWN_USER_HASH));
  if (!member || !matches) {
    recordFailure(key);
    throw new HttpError(401, "Wrong username or password.");
  }
  failures.delete(key);
  return startSession(member);
}

// Linking MetaMask uses Sign-In with Ethereum: the user signs a one-time message, which proves they
// control the address. Without it, anyone could claim someone else's wallet. Signing is free and cannot move funds.

export async function issueNonce() {
  const nonce = generateSiweNonce();
  await nonces.add(nonce, NONCE_TTL_MS);
  return nonce;
}

async function verifySignedMessage(message, signature) {
  let fields;
  try {
    fields = parseSiweMessage(message);
  } catch {
    throw new HttpError(400, "Malformed message.");
  }
  if (!fields.nonce || !fields.address) throw new HttpError(400, "Malformed message.");
  if (fields.chainId !== config.chain.id) throw new HttpError(400, `Please switch MetaMask to ${config.chain.name}.`);

  const valid = await publicClient.verifySiweMessage({ message, signature, domain: config.appDomain, nonce: fields.nonce });
  if (!valid) throw new HttpError(401, "That signature is not from this MetaMask.");
  if (!(await nonces.consume(fields.nonce))) throw new HttpError(401, "The message expired or was already used. Try again.");
  return getAddress(fields.address);
}

/** Links the MetaMask that signed the message to the logged-in user. Each login gets one MetaMask. */
export async function linkWallet(user, { message, signature } = {}) {
  if (!message || !signature) throw new HttpError(400, "Missing message or signature.");
  const address = await verifySignedMessage(message, signature);
  if (user.address) {
    if (isAddressEqual(user.address, address)) return { address };
    throw new HttpError(400, `This login is already linked to MetaMask ${user.address}.`);
  }
  const result = await members.linkAddress(user.id, address);
  if (result === "address-taken") throw new HttpError(409, "This MetaMask is already linked to another login.");
  if (result === "already-linked") throw new HttpError(400, "This login is already linked to a MetaMask.");
  return { address };
}

/** Checks the login session and loads the user, with their linked MetaMask address if any. */
export async function requireAuth(req, _res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new HttpError(401, "Please log in.");
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    throw new HttpError(401, "Your session expired. Please log in again.");
  }
  const member = await members.get(String(payload.sub));
  if (!member) throw new HttpError(401, "Please log in again.");
  req.user = { id: member._id, username: member.username, address: addressOf(member) };
  next();
}

/** For routes that act on the user's wallet: they need a linked MetaMask. */
export function requireWallet(req, _res, next) {
  if (!req.user.address) throw new HttpError(400, "Link your MetaMask to this login first.");
  next();
}
