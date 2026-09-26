import { formatUnits } from "viem";

/** Decimals for a trading token or the chain's native coin, from the backend's /config. */
export function decimalsOf(config, symbol) {
  return config.tokens[symbol]?.decimals ?? config.chain.nativeCurrency.decimals;
}

/** Symbols shown in the app: the trading pair first, then the native coin (BNB). */
export const tradingSymbols = (config) => Object.keys(config.tokens);
export const allSymbols = (config) => [...tradingSymbols(config), config.nativeSymbol];

/** Formats a raw token amount (string or bigint) with at most `maxDecimals` decimals. */
export function formatAmount(raw, decimals = 18, maxDecimals = 2) {
  if (raw == null) return "–";
  const text = formatUnits(BigInt(raw), decimals);
  const [whole, fraction = ""] = text.split(".");
  const trimmed = fraction.slice(0, maxDecimals).replace(/0+$/, "");
  const wholeWithCommas = BigInt(whole).toLocaleString("en-US");
  return trimmed ? `${wholeWithCommas}.${trimmed}` : wholeWithCommas;
}

/** Formats an amount of a given symbol. Native coin shows more decimals since balances are small. */
export function formatToken(config, raw, symbol) {
  return formatAmount(raw, decimalsOf(config, symbol), symbol === config.nativeSymbol ? 4 : 2);
}

export const shortAddress = (address) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "");

export function explorerLink(config, kind, value) {
  return config?.chain?.explorer ? `${config.chain.explorer}/${kind}/${value}` : null;
}

export function timeAgo(isoTimestamp) {
  const then = new Date(isoTimestamp).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(then).toLocaleDateString();
}
