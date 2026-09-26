export default function BotControl({ config, wallet, busy, onEnable, onStop }) {
  const { rules } = config;

  return (
    <section className="card bot-card">
      <div className="card-head">
        <h2>Bot permission</h2>
        <span className={`pill ${wallet.botEnabled ? "on" : "off"}`}>{wallet.botEnabled ? "Enabled" : "Off"}</span>
      </div>
      <p className="muted">
        These rules are stored on the blockchain in your wallet. The bot key <span className="mono">{config.botAddress.slice(0, 10)}…</span>{" "}
        cannot break them, and neither can we.
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

      {wallet.botEnabled ? (
        <button className="danger" disabled={Boolean(busy)} onClick={onStop}>
          Stop bot
        </button>
      ) : (
        <>
          <button className="primary" disabled={Boolean(busy)} onClick={onEnable}>
            Enable bot
          </button>
          <p className="muted small-text">MetaMask will ask for one signature. Signing is free, and we pay the network fee.</p>
        </>
      )}
    </section>
  );
}
