import { tradingSymbols } from "../lib/format.js";
import AmountForm from "./AmountForm.jsx";

export default function DepositForm({ config, busy, ownerBalances, onDeposit }) {
  return (
    <section className="card">
      <h2>Deposit</h2>
      <p className="muted">
        Move only the amount you want the bot to trade. MetaMask sends it straight to your bot wallet, and you pay the network fee in{" "}
        {config.nativeSymbol}.
      </p>
      <AmountForm
        id="deposit"
        config={config}
        tokens={tradingSymbols(config)}
        balances={ownerBalances}
        balanceLabel="In your MetaMask"
        submitLabel="Deposit"
        busy={busy}
        onSubmit={onDeposit}
      />
    </section>
  );
}
