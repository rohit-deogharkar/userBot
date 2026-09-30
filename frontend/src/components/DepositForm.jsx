import { parseEther } from "viem";
import { allSymbols } from "../lib/format.js";
import AmountForm from "./AmountForm.jsx";

// Max leaves this much BNB in MetaMask, to pay for the deposit transaction itself.
const KEEP_FOR_GAS = parseEther("0.001");

export default function DepositForm({ config, busy, ownerBalances, onDeposit }) {
  const native = BigInt(ownerBalances[config.nativeSymbol] ?? 0);
  const available = { ...ownerBalances, [config.nativeSymbol]: native > KEEP_FOR_GAS ? native - KEEP_FOR_GAS : 0n };

  return (
    <section className="card">
      <h2>Deposit</h2>
      <p className="muted">
        Move only what you want the bot to trade, plus a little {config.nativeSymbol} for the gas of its trades. MetaMask sends it
        straight to your smart account, and you pay the network fee in {config.nativeSymbol}.
      </p>
      <AmountForm
        id="deposit"
        config={config}
        tokens={allSymbols(config)}
        balances={available}
        balanceLabel="Available to deposit"
        submitLabel="Deposit"
        busy={busy}
        onSubmit={onDeposit}
      />
    </section>
  );
}
