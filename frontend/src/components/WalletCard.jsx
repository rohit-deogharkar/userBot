import { useState } from "react";
import { allSymbols, explorerLink, formatToken, shortAddress, tradingSymbols } from "../lib/format.js";

export default function WalletCard({ config, owner, wallet }) {
  const [copied, setCopied] = useState(false);
  const link = explorerLink(config, "address", wallet.account);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet.account);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked. The address is still selectable on screen.
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Smart account</h2>
        <span className={`pill ${wallet.botEnabled ? "on" : "off"}`}>{wallet.botEnabled ? "Bot running" : "Bot stopped"}</span>
      </div>

      <div className="address-row">
        <code className="mono selectable">{wallet.account}</code>
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
        A MetaMask smart account on {config.chain.name}, owned only by your MetaMask <span className="mono">{shortAddress(owner)}</span>.
      </p>

      <dl className="balances">
        {allSymbols(config).map((symbol) => (
          <div key={symbol}>
            <dt>{symbol}</dt>
            <dd className="num">{formatToken(config, wallet.balances[symbol], symbol)}</dd>
          </div>
        ))}
      </dl>

      {BigInt(wallet.balances[config.nativeSymbol] ?? 0) === 0n ? (
        <p className="warning-text small-text">
          Deposit a little {config.nativeSymbol}: in Deposit below, choose {config.nativeSymbol} as the token. The bot pays each
          trade's gas from it, and can't trade without it.
        </p>
      ) : (
        wallet.botEnabled && (
          <p className="muted small-text">
            The bot pays each trade's gas from the {config.nativeSymbol} in this account.{" "}
            <span className="num">{formatToken(config, wallet.gasBudgetLeftToday, config.nativeSymbol)}</span> {config.nativeSymbol} of
            today's {formatToken(config, config.gas.dailyCap, config.nativeSymbol)} {config.nativeSymbol} gas limit left.
          </p>
        )
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
