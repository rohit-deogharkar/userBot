import { shortAddress } from "../lib/format.js";
import LoginForm from "./LoginForm.jsx";

const STEPS = [
  { key: "login", title: "Log in", text: "With your userDexBot username and password." },
  { key: "connect", title: "Connect MetaMask", text: "Your existing account works as it is." },
  { key: "link", title: "Link MetaMask to your login", text: "One free signature, the first time only. It proves the wallet is yours." },
  { key: "create", title: "Create your smart account", text: "One MetaMask transaction plus one free signature. Your MetaMask is its only owner." },
];

/**
 * `step` is where the user is: "login", "loading", "connect", "switch" (MetaMask is on a different
 * account than the one linked to this login), "link" or "create".
 */
export default function Onboarding({ step, hasMetaMask, ready, account, linked, busy, onLogin, onConnect, onLink, onCreateWallet }) {
  const shownStep = step === "switch" ? "connect" : step === "loading" ? "connect" : step;
  const currentIndex = STEPS.findIndex((s) => s.key === shownStep);

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
          {STEPS.map((s, index) => {
            const done = currentIndex > index;
            return (
              <li key={s.key} className={s.key === shownStep ? "active" : done ? "done" : ""}>
                <span className="step-dot">{done ? "✓" : index + 1}</span>
                <div>
                  <strong>{s.title}</strong>
                  <p>{s.text}</p>
                </div>
              </li>
            );
          })}
        </ol>

        {step === "login" ? (
          <LoginForm busy={busy || !ready} onSubmit={onLogin} />
        ) : step === "loading" ? (
          <p className="muted">Loading your account…</p>
        ) : !hasMetaMask ? (
          <p className="banner warning">MetaMask is not installed in this browser. Install it from metamask.io, then reload this page.</p>
        ) : step === "connect" ? (
          <button className="primary" disabled={busy} onClick={onConnect}>
            Connect MetaMask
          </button>
        ) : step === "switch" ? (
          <p className="banner warning">
            MetaMask is on {shortAddress(account)}, but this login is linked to <span className="mono">{linked}</span>. Switch to that
            account in MetaMask.
          </p>
        ) : step === "link" ? (
          <>
            <p className="muted small-text">
              MetaMask account <span className="mono">{account}</span> will be linked to this login, and can't be changed later. To use
              a different one, switch accounts in MetaMask first.
            </p>
            <button className="primary" disabled={busy} onClick={onLink}>
              Link this MetaMask
            </button>
          </>
        ) : (
          <button className="primary" disabled={busy} onClick={onCreateWallet}>
            Create smart account
          </button>
        )}
      </div>
    </section>
  );
}
