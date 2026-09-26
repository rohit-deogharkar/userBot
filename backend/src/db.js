import { MongoClient } from "mongodb";
import { config } from "./config.js";

const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 5_000 });
let database;

const collection = (name) => {
  if (!database) throw new Error("Database is not connected. Call connectDb() first.");
  return database.collection(name);
};

export async function connectDb() {
  if (database) return database;
  await client.connect();
  database = client.db(config.mongoDbName);
  await Promise.all([
    // MongoDB deletes each login nonce automatically once expiresAt has passed.
    collection("loginNonces").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    collection("users").createIndex({ address: 1, chainId: 1 }, { unique: true }),
    collection("walletActions").createIndex({ owner: 1, createdAt: -1 }),
    collection("trades").createIndex({ owner: 1, createdAt: -1 }),
  ]);
  return database;
}

export async function closeDb() {
  await client.close();
  database = undefined;
}

// MongoDB has no type for 256-bit numbers, so bigints are stored as decimal strings.
export const toJson = (value) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const withBigintsAsStrings = (value) => JSON.parse(toJson(value));

export const nonces = {
  async add(nonce, ttlMs) {
    await collection("loginNonces").insertOne({ _id: nonce, expiresAt: new Date(Date.now() + ttlMs) });
  },
  /** Returns true once per valid nonce, so a signed login message can't be replayed. */
  async consume(nonce) {
    const result = await collection("loginNonces").deleteOne({ _id: nonce, expiresAt: { $gte: new Date() } });
    return result.deletedCount === 1;
  },
};

export const users = {
  async get(address) {
    return collection("users").findOne({ address: address.toLowerCase(), chainId: config.chain.id });
  },
  async upsertWallet(address, safeAddress, rolesAddress) {
    return collection("users").findOneAndUpdate(
      { address: address.toLowerCase(), chainId: config.chain.id },
      { $set: { safeAddress, rolesAddress }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true, returnDocument: "after" },
    );
  },
  async withWallet() {
    return collection("users").find({ chainId: config.chain.id, rolesAddress: { $ne: null } }).toArray();
  },
};

const actionView = ({ _id, owner, safeAddress, kind, summary, status, txHash, error, createdAt }) => ({
  id: _id,
  owner,
  safeAddress,
  kind,
  summary,
  status,
  txHash: txHash ?? null,
  error: error ?? null,
  createdAt,
});

export const walletActions = {
  async create({ id, owner, safeAddress, kind, summary, safeTx }) {
    await collection("walletActions").insertOne({
      _id: id,
      owner: owner.toLowerCase(),
      safeAddress,
      kind,
      summary,
      safeTx: withBigintsAsStrings(safeTx),
      status: "awaiting_signature",
      createdAt: new Date(),
    });
  },
  /**
   * Atomically moves an action from "awaiting_signature" to "submitting" and returns it.
   * Returns null if it doesn't exist, belongs to someone else, or was already claimed,
   * so the same signed action can never be submitted twice.
   */
  async claimForSubmit(id, owner) {
    const doc = await collection("walletActions").findOneAndUpdate(
      { _id: id, owner: owner.toLowerCase(), status: "awaiting_signature" },
      { $set: { status: "submitting" } },
      { returnDocument: "after" },
    );
    if (!doc) return null;
    const tx = doc.safeTx;
    return {
      ...actionView(doc),
      safeTx: { ...tx, value: BigInt(tx.value), safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, nonce: BigInt(tx.nonce) },
    };
  },
  async find(id, owner) {
    const doc = await collection("walletActions").findOne({ _id: id, owner: owner.toLowerCase() });
    return doc ? actionView(doc) : null;
  },
  async finish(id, status, { txHash = null, error = null } = {}) {
    await collection("walletActions").updateOne({ _id: id }, { $set: { status, txHash, error, finishedAt: new Date() } });
  },
  async recent(owner) {
    const docs = await collection("walletActions").find({ owner: owner.toLowerCase() }).sort({ createdAt: -1 }).limit(20).toArray();
    return docs.map(actionView);
  },
};

export const trades = {
  async record(trade) {
    await collection("trades").insertOne({
      owner: trade.owner.toLowerCase(),
      safeAddress: trade.safeAddress,
      tokenIn: trade.tokenIn,
      tokenOut: trade.tokenOut,
      amountIn: String(trade.amountIn),
      minOut: trade.minOut == null ? null : String(trade.minOut),
      amountOut: trade.amountOut == null ? null : String(trade.amountOut),
      txHash: trade.txHash ?? null,
      status: trade.status,
      error: trade.error ?? null,
      source: trade.source,
      createdAt: new Date(),
    });
  },
  async recent(owner) {
    const docs = await collection("trades").find({ owner: owner.toLowerCase() }).sort({ createdAt: -1 }).limit(20).toArray();
    return docs.map(({ _id, ...rest }) => ({ id: _id.toString(), ...rest }));
  },
};
