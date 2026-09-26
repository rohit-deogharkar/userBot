import { tradingSymbols } from "../lib/format.js";
import AmountForm from "./AmountForm.jsx";

export default function TestTrade({ config, busy, botEnabled, onTrade }) {
  return (
    <section className="card dev-card">
      <div className="card-head">
        <h2>Test trade</h2>
        <span className="pill dev">Development only</span>
      </div>
      <p className="muted">
        Makes the bot sell the token you pick for the other one, right now, using the same trade-only key the strategy will use. Turn this
        off in production.
      </p>
      <AmountForm
        id="test-trade"
        config={config}
        tokens={tradingSymbols(config)}
        submitLabel={botEnabled ? "Sell with the bot" : "Enable the bot first"}
        busy={busy}
        disabled={!botEnabled}
        onSubmit={onTrade}
      />
    </section>
  );
}
