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
    collection("members").createIndex({ username: 1 }, { unique: true }),
    // One MetaMask can be linked to only one login.
    collection("members").createIndex({ address: 1 }, { unique: true, partialFilterExpression: { address: { $type: "string" } } }),
    collection("users").createIndex({ address: 1, chainId: 1 }, { unique: true }),
    collection("walletActions").createIndex({ owner: 1, createdAt: -1 }),
    // One blockchain transaction can confirm only one wallet action.
    collection("walletActions").createIndex({ txHash: 1 }, { unique: true, partialFilterExpression: { txHash: { $type: "string" } } }),
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

const isDuplicate = (error) => error?.code === 11000;

/** Logins: a username, a password hash, and the MetaMask address linked to them (null until linked). */
export const members = {
  /** Creates a login. Returns null if the username is taken. */
  async create({ id, username, passwordHash }) {
    const doc = { _id: id, username, passwordHash, address: null, createdAt: new Date() };
    try {
      await collection("members").insertOne(doc);
      return doc;
    } catch (error) {
      if (isDuplicate(error)) return null;
      throw error;
    }
  },
  async get(id) {
    return collection("members").findOne({ _id: id });
  },
  async findByUsername(username) {
    return collection("members").findOne({ username });
  },
  /**
   * Links a MetaMask address to a login that has none yet.
   * Returns the updated login, "already-linked" if the login has an address, or "address-taken" if another login has this one.
   */
  async linkAddress(id, address) {
    try {
      const doc = await collection("members").findOneAndUpdate(
        { _id: id, address: null },
        { $set: { address: address.toLowerCase(), linkedAt: new Date() } },
        { returnDocument: "after" },
      );
      return doc ?? "already-linked";
    } catch (error) {
      if (isDuplicate(error)) return "address-taken";
      throw error;
    }
  },
};

/** Smart accounts and bot permissions, one per MetaMask address. */
export const users = {
  async get(address) {
    return collection("users").findOne({ address: address.toLowerCase(), chainId: config.chain.id });
  },
  /** Records the user's smart account and the owner delegation they signed for it. */
  async saveAccount(address, account, ownerDelegation) {
    return collection("users").findOneAndUpdate(
      { address: address.toLowerCase(), chainId: config.chain.id },
      { $set: { account, ownerDelegation }, $setOnInsert: { botDelegation: null, createdAt: new Date() } },
      { upsert: true, returnDocument: "after" },
    );
  },
  /** Stores the bot permission the user signed, or clears it. */
  async setBotDelegation(address, botDelegation) {
    return collection("users").findOneAndUpdate(
      { address: address.toLowerCase(), chainId: config.chain.id },
      { $set: { botDelegation } },
      { returnDocument: "after" },
    );
  },
  /** Users whose bot the strategy runner should consider. */
  async withBotPermission() {
    return collection("users").find({ chainId: config.chain.id, botDelegation: { $ne: null } }).toArray();
  },
};

const actionView = ({ _id, owner, account, kind, summary, status, txHash, error, createdAt }) => ({
  id: _id,
  owner,
  account,
  kind,
  summary,
  status,
  txHash: txHash ?? null,
  error: error ?? null,
  createdAt,
});

export const walletActions = {
  /**
   * A pending action for the user: either a transaction to send from MetaMask (tx),
   * or a bot permission to sign (delegation).
   */
  async create({ id, owner, account, kind, summary, tx = null, delegation = null }) {
    await collection("walletActions").insertOne({
      _id: id,
      owner: owner.toLowerCase(),
      account,
      kind,
      summary,
      tx: tx ? withBigintsAsStrings(tx) : null,
      delegation,
      status: "awaiting_signature",
      createdAt: new Date(),
    });
  },
  /**
   * Atomically moves an action from "awaiting_signature" to "confirming" and returns it.
   * Returns null if it doesn't exist, belongs to someone else, or was already claimed,
   * so the same action can never be confirmed twice.
   */
  async claimForConfirm(id, owner) {
    const doc = await collection("walletActions").findOneAndUpdate(
      { _id: id, owner: owner.toLowerCase(), status: "awaiting_signature" },
      { $set: { status: "confirming" } },
      { returnDocument: "after" },
    );
    if (!doc) return null;
    return { ...actionView(doc), tx: doc.tx ? { ...doc.tx, value: BigInt(doc.tx.value) } : null, delegation: doc.delegation };
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
      account: trade.account,
      tokenIn: trade.tokenIn,
      tokenOut: trade.tokenOut,
      amountIn: String(trade.amountIn),
      minOut: trade.minOut == null ? null : String(trade.minOut),
      amountOut: trade.amountOut == null ? null : String(trade.amountOut),
      // BNB the user's smart account paid for this trade's gas.
      gasFee: trade.gasFee == null ? null : String(trade.gasFee),
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
  /** How much of a token the bot sold for this user in the last 24 hours. */
  async soldInLastDay(owner, tokenSymbol) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const docs = await collection("trades")
      .find({ owner: owner.toLowerCase(), tokenIn: tokenSymbol, status: "success", createdAt: { $gte: since } })
      .project({ amountIn: 1 })
      .toArray();
    return docs.reduce((sum, d) => sum + BigInt(d.amountIn), 0n);
  },
};
