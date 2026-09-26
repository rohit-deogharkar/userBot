import cors from "cors";
import express from "express";
import { formatEther } from "viem";
import { botAccount, publicClient, relayerAccount } from "./chain.js";
import { config, networkProblem } from "./config.js";
import { closeDb, connectDb } from "./db.js";
import { describeError } from "./errors.js";
import { router } from "./routes.js";
import { startStrategyRunner } from "./strategy/runner.js";

const problem = networkProblem();
if (problem) {
  console.error(problem);
  process.exit(1);
}

try {
  await connectDb();
  console.log(`Connected to MongoDB database "${config.mongoDbName}"`);
} catch (error) {
  console.error(`Cannot connect to MongoDB at ${config.mongoUri}: ${error.message}`);
  console.error("Start MongoDB or set MONGODB_URI in .env, then try again.");
  process.exit(1);
}

const app = express();
app.use(cors({ origin: config.appOrigin }));
app.use(express.json());
app.use("/api", router);

app.use((error, req, res, _next) => {
  const { status, message } = describeError(error);
  if (status === 503) {
    console.warn(`${req.method} ${req.path}: cannot reach the blockchain node at ${config.rpcUrl}. Is anvil running?`);
  } else if (status >= 500) {
    console.error(error);
  }
  res.status(status).json({ error: message });
});

const server = app.listen(config.port, async () => {
  console.log(`userDexBot backend on http://localhost:${config.port} (network: ${config.networkName}, chain ${config.chain.id})`);
  try {
    const chainId = await publicClient.getChainId();
    if (chainId !== config.chain.id) {
      console.warn(`WARNING: RPC at ${config.rpcUrl} reports chain ${chainId}, expected ${config.chain.id}.`);
    }
    for (const [label, account] of [["Relayer", relayerAccount], ["Bot", botAccount]]) {
      const balance = await publicClient.getBalance({ address: account.address });
      console.log(`${label} ${account.address} has ${formatEther(balance)} ${config.nativeSymbol} for gas`);
      if (balance === 0n) console.warn(`WARNING: ${label} has no ${config.nativeSymbol} and cannot send transactions.`);
    }
  } catch (error) {
    console.warn(`WARNING: cannot reach the blockchain node at ${config.rpcUrl}: ${error.shortMessage || error.message}`);
    if (config.networkName === "bsc-fork") {
      console.warn(`For local testing, start the fork first: anvil --fork-url https://bsc-mainnet.public.blastapi.io --chain-id ${config.chain.id}`);
    }
  }
  startStrategyRunner();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    closeDb().finally(() => process.exit(0));
  });
}
