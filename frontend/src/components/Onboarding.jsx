const STEPS = [
  { key: "connect", title: "Connect MetaMask", text: "Your existing account works as it is." },
  { key: "signin", title: "Sign in", text: "One free signature proves the account is yours." },
  { key: "create", title: "Create your smart account", text: "One MetaMask transaction plus one free signature. Your MetaMask is its only owner." },
];

export default function Onboarding({ hasMetaMask, ready, account, signedIn, loadingWallet, busy, onConnect, onSignIn, onCreateWallet }) {
  const current = !account ? "connect" : !signedIn ? "signin" : "create";

  return (
    <section className="onboarding">
      <div className="pitch">
        <p className="eyebrow">Automated DEOD trading on BNB Chain, without handing over your keys</p>
        <h1>Your money stays in a wallet only your MetaMask controls.</h1>
        <p className="lead">
          You get a MetaMask smart account for trading, and sign the bot a trade-only permission. It can swap tokens inside
          that account, but it can never withdraw or send them anywhere. You can stop it or withdraw at any time.
        </p>
      </div>

      <div className="card steps-card">
        <ol className="steps">
          {STEPS.map((step, index) => {
            const done = STEPS.findIndex((s) => s.key === current) > index;
            return (
              <li key={step.key} className={step.key === current ? "active" : done ? "done" : ""}>
                <span className="step-dot">{done ? "✓" : index + 1}</span>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.text}</p>
                </div>
              </li>
            );
          })}
        </ol>

        {!hasMetaMask ? (
          <p className="banner warning">
            MetaMask is not installed in this browser. Install it from metamask.io, then reload this page.
          </p>
        ) : current === "connect" ? (
          <button className="primary" disabled={!ready || busy} onClick={onConnect}>
            Connect MetaMask
          </button>
        ) : current === "signin" ? (
          <button className="primary" disabled={busy} onClick={onSignIn}>
            Sign in with MetaMask
          </button>
        ) : loadingWallet ? (
          <p className="muted">Loading your account…</p>
        ) : (
          <button className="primary" disabled={busy} onClick={onCreateWallet}>
            Create smart account
          </button>
        )}
      </div>
    </section>
  );
}
