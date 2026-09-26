import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getContractAddress,
  isAddressEqual,
  keccak256,
} from "viem";
import { Clearance, flattenCondition, processPermissions } from "zodiac-roles-sdk";
import { moduleProxyFactoryAbi, rolesAbi, safeAbi } from "./abis.js";
import { botAccount, publicClient } from "./chain.js";
import { ADDRESSES, config } from "./config.js";
import { ALLOWANCE_KEYS, ALLOWANCE_PERIOD_SECONDS, FEE_ALLOWANCE_KEY, ROLE_KEY, tradePermissions } from "./permissions.js";
import { SALT_NONCE, isDeployed, previousModule } from "./safe.js";

// The Roles module's owner, avatar and target are all the user's Safe.
// Only the Safe, meaning only the user's MetaMask, can change its rules.
export function rolesInitializer(safe) {
  const initParams = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }],
    [safe, safe, safe],
  );
  return encodeFunctionData({ abi: rolesAbi, functionName: "setUp", args: [initParams] });
}

/** Zodiac's factory deploys a minimal proxy with CREATE2, so the address is known in advance. */
export function predictRolesAddress(safe) {
  const initializer = rolesInitializer(safe);
  const salt = keccak256(encodePacked(["bytes32", "uint256"], [keccak256(initializer), SALT_NONCE]));
  const bytecode = concat([
    "0x602d8060093d393df3363d3d373d3d3d363d73",
    ADDRESSES.rolesMastercopy,
    "0x5af43d82803e903d91602b57fd5bf3",
  ]);
  return getContractAddress({ opcode: "CREATE2", from: ADDRESSES.moduleProxyFactory, salt, bytecode });
}

export async function assertRolesLinkedTo(roles, safe) {
  const [owner, avatar, target] = await Promise.all(
    ["owner", "avatar", "target"].map((functionName) => publicClient.readContract({ address: roles, abi: rolesAbi, functionName })),
  );
  if (![owner, avatar, target].every((a) => isAddressEqual(a, safe))) {
    throw new Error(`Roles module ${roles} is not controlled by bot wallet ${safe}`);
  }
}

const call = (to, functionName, args) => ({ to, data: encodeFunctionData({ abi: rolesAbi, functionName, args }) });

/**
 * The calls the user's Safe makes when they click "Enable bot", all in one MetaMask transaction:
 * deploy the Roles module the first time, give the bot key its role, write the trade-only rules,
 * set the daily limits and fee cap, then switch the module on.
 */
export async function buildEnableBotCalls(safe, roles) {
  const calls = [];
  if (!(await isDeployed(roles))) {
    // Anyone may call Zodiac's factory. The Roles module it creates is owned by this Safe.
    calls.push({
      to: ADDRESSES.moduleProxyFactory,
      data: encodeFunctionData({
        abi: moduleProxyFactoryAbi,
        functionName: "deployModule",
        args: [ADDRESSES.rolesMastercopy, rolesInitializer(safe), SALT_NONCE],
      }),
    });
  }
  calls.push(call(roles, "assignRoles", [botAccount.address, [ROLE_KEY], [true]]));

  const { targets } = processPermissions(tradePermissions());
  for (const target of targets) {
    if (target.clearance === Clearance.Target) {
      calls.push(call(roles, "allowTarget", [ROLE_KEY, target.address, target.executionOptions]));
      continue;
    }
    calls.push(call(roles, "scopeTarget", [ROLE_KEY, target.address]));
    for (const fn of target.functions) {
      if (fn.wildcarded) {
        calls.push(call(roles, "allowFunction", [ROLE_KEY, target.address, fn.selector, fn.executionOptions]));
      } else {
        const conditions = flattenCondition(fn.condition).map(({ parent, paramType, operator, compValue }) => ({
          parent,
          paramType,
          operator,
          compValue: compValue ?? "0x",
        }));
        calls.push(call(roles, "scopeFunction", [ROLE_KEY, target.address, fn.selector, conditions, fn.executionOptions]));
      }
    }
  }

  const { timestamp } = await publicClient.getBlock();
  for (const [symbol, key] of Object.entries(ALLOWANCE_KEYS)) {
    const limit = config.rules.dailyLimits[symbol];
    calls.push(call(roles, "setAllowance", [key, limit, limit, limit, ALLOWANCE_PERIOD_SECONDS, timestamp]));
  }
  const feeCap = config.rules.dailyFeeCap;
  calls.push(call(roles, "setAllowance", [FEE_ALLOWANCE_KEY, feeCap, feeCap, feeCap, ALLOWANCE_PERIOD_SECONDS, timestamp]));

  calls.push({ to: safe, data: encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [roles] }) });
  return calls;
}

/** "Stop bot" switches the Roles module off. The rules stay stored for a later restart. */
export async function buildStopBotCall(safe, roles) {
  const prev = await previousModule(safe, roles);
  if (!prev) return null;
  return { to: safe, data: encodeFunctionData({ abi: safeAbi, functionName: "disableModule", args: [prev, roles] }) };
}

// Mirrors the Roles contract's refill logic so the UI can show what is left today.
function accruedBalance([refill, maxRefill, period, balance, timestamp], now) {
  if (period === 0n || now < timestamp + period) return balance;
  const intervals = (now - timestamp) / period;
  if (balance >= maxRefill) return balance;
  const next = balance + refill * intervals;
  return next < maxRefill ? next : maxRefill;
}

/** How much network fee the bot may still take today, or 0 if the rules aren't set up. */
export async function feeRemainingToday(roles) {
  if (!roles || !(await isDeployed(roles))) return 0n;
  const [allowance, block] = await Promise.all([
    publicClient.readContract({ address: roles, abi: rolesAbi, functionName: "allowances", args: [FEE_ALLOWANCE_KEY] }),
    publicClient.getBlock(),
  ]);
  return accruedBalance(allowance, block.timestamp);
}

export async function getRolesState(safe, roles) {
  if (!roles || !(await isDeployed(roles))) return { deployed: false, botEnabled: false, remainingToday: {}, feeRemainingToday: 0n };
  const [botEnabled, block] = await Promise.all([
    publicClient.readContract({ address: safe, abi: safeAbi, functionName: "isModuleEnabled", args: [roles] }),
    publicClient.getBlock(),
  ]);
  const remainingToday = {};
  for (const [symbol, key] of Object.entries(ALLOWANCE_KEYS)) {
    const allowance = await publicClient.readContract({ address: roles, abi: rolesAbi, functionName: "allowances", args: [key] });
    remainingToday[symbol] = accruedBalance(allowance, block.timestamp);
  }
  return { deployed: true, botEnabled, remainingToday, feeRemainingToday: await feeRemainingToday(roles) };
}
