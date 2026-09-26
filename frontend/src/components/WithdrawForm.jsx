import { allSymbols } from "../lib/format.js";
import AmountForm from "./AmountForm.jsx";

export default function WithdrawForm({ config, busy, balances, onWithdraw }) {
  return (
    <section className="card">
      <h2>Withdraw</h2>
      <p className="muted">
        Funds always go back to your own MetaMask. You sign in MetaMask, and we pay the network fee.
      </p>
      <AmountForm
        id="withdraw"
        config={config}
        tokens={allSymbols(config)}
        balances={balances}
        balanceLabel="In your bot wallet"
        submitLabel="Withdraw to MetaMask"
        busy={busy}
        maxSendsAll
        onSubmit={onWithdraw}
      />
    </section>
  );
}
