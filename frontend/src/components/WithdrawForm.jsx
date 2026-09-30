import { allSymbols } from "../lib/format.js";
import AmountForm from "./AmountForm.jsx";

export default function WithdrawForm({ config, busy, balances, onWithdraw }) {
  return (
    <section className="card">
      <h2>Withdraw</h2>
      <p className="muted">
        Funds always go back to your own MetaMask. You confirm in MetaMask and pay the small network fee.
      </p>
      <AmountForm
        id="withdraw"
        config={config}
        tokens={allSymbols(config)}
        balances={balances}
        balanceLabel="In your smart account"
        submitLabel="Withdraw to MetaMask"
        busy={busy}
        maxSendsAll
        onSubmit={onWithdraw}
      />
    </section>
  );
}
