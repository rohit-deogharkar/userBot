import { formatToken } from "../lib/format.js";

const intervalText = (ms) => (ms % 60_000 === 0 ? `${ms / 60_000 === 1 ? "minute" : `${ms / 60_000} minutes`}` : `${Math.round(ms / 1000)} seconds`);

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
      {wallet.botEnabled && config.automaticTrading?.enabled && (
        <p className="auto-note small-text">
          Trading automatically: {config.automaticTrading.description} every {intervalText(config.automaticTrading.intervalMs)}.
          It keeps going while you're logged out, and pauses when the {config.nativeSymbol} for gas or today's gas limit runs out.
        </p>
      )}
      {wallet.botEnabled && config.automaticTrading && !config.automaticTrading.enabled && (
        <p className="muted small-text">Automatic trading is switched off on the server, so the bot only trades when asked.</p>
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
