import { useState } from "react";
import { allSymbols, explorerLink, formatToken, shortAddress, tradingSymbols } from "../lib/format.js";

export default function WalletCard({ config, owner, wallet }) {
  const [copied, setCopied] = useState(false);
  const link = explorerLink(config, "address", wallet.safeAddress);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet.safeAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked. The address is still selectable on screen.
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Bot wallet</h2>
        <span className={`pill ${wallet.botEnabled ? "on" : "off"}`}>{wallet.botEnabled ? "Bot running" : "Bot stopped"}</span>
      </div>

      <div className="address-row">
        <code className="mono selectable">{wallet.safeAddress}</code>
        <button className="small" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
        {link && (
          <a className="small-link" href={link} target="_blank" rel="noreferrer">
            Explorer
          </a>
        )}
      </div>
      <p className="muted small-text">
        Owned only by your MetaMask <span className="mono">{shortAddress(owner)}</span>. A Safe smart wallet on {config.chain.name}.
      </p>

      <dl className="balances">
        {allSymbols(config).map((symbol) => (
          <div key={symbol}>
            <dt>{symbol}</dt>
            <dd className="num">{formatToken(config, wallet.balances[symbol], symbol)}</dd>
          </div>
        ))}
      </dl>

      {wallet.botEnabled && config.fees && (
        <p className="muted small-text">
          Bot network fees: {formatToken(config, config.fees.perTrade, "USDT")} USDT per trade, paid from this wallet.{" "}
          <span className="num">{formatToken(config, wallet.feeRemainingToday, "USDT")}</span> USDT of today's{" "}
          {formatToken(config, config.fees.dailyCap, "USDT")} USDT cap left.
        </p>
      )}
      {wallet.botEnabled && (
        <p className="muted small-text">
          Left to sell today:{" "}
          {tradingSymbols(config).map((symbol, i) => (
            <span key={symbol}>
              {i > 0 && " and "}
              <span className="num">{formatToken(config, wallet.remainingToday[symbol], symbol)}</span> {symbol}
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
