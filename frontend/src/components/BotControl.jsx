import { formatToken } from "../lib/format.js";

export default function BotControl({ config, wallet, busy, onEnable, onStop, permission }) {
  const { rules } = config;

  return (
    <section className="card bot-card">
      <div className="card-head">
        <h2>Bot permission</h2>
        <span className={`pill ${wallet.botEnabled ? "on" : "off"}`}>{wallet.botEnabled ? "Enabled" : "Off"}</span>
      </div>
      <p className="muted">
        You give the bot these rules as a MetaMask permission that you sign. The blockchain enforces them, so the bot key{" "}
        <span className="mono">{config.botAddress.slice(0, 10)}…</span> cannot break them, and neither can we.
      </p>

      <div className="rules">
        <div>
          <h3>The bot can</h3>
          <ul className="rule-list allowed">
            {rules.allowed.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3>The bot can never</h3>
          <ul className="rule-list blocked">
            {rules.blocked.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </div>
      </div>

      {permission && (
        <p className="muted small-text">
          The permission you were shown lets the bot take at most {formatToken(config, permission.dailyGasCap, config.nativeSymbol)}{" "}
          {config.nativeSymbol} per day for gas, paid back only to the bot's address.
        </p>
      )}
      {wallet.botEnabled ? (
        <>
          <button className="danger" disabled={Boolean(busy)} onClick={onStop}>
            Stop bot
          </button>
          <p className="muted small-text">Stopping is one MetaMask transaction. It switches off the bot's permission immediately.</p>
        </>
      ) : (
        <>
          <button className="primary" disabled={Boolean(busy)} onClick={onEnable}>
            Enable bot
          </button>
          <p className="muted small-text">
            MetaMask asks for one signature. It's free and sends no transaction. After that the bot keeps trading, even when you
            are logged out, until you stop it.
          </p>
        </>
      )}
    </section>
  );
}
