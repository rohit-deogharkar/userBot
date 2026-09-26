import { useState } from "react";
import { formatUnits } from "viem";
import { decimalsOf, formatToken } from "../lib/format.js";

/**
 * Token picker plus amount input, shared by deposit, withdraw and test trade.
 * `balances` is optional. When given, it shows the available amount and a Max button.
 */
export default function AmountForm({ id, config, tokens, balances, balanceLabel, submitLabel, busy, disabled, onSubmit, maxSendsAll }) {
  const [token, setToken] = useState(tokens[0]);
  const [amount, setAmount] = useState("");
  const [useMax, setUseMax] = useState(false);

  const available = balances?.[token];
  const valid = useMax || (/^\d*\.?\d+$/.test(amount) && Number(amount) > 0);

  const submit = async (event) => {
    event.preventDefault();
    if (!valid) return;
    const ok = await onSubmit(token, useMax && maxSendsAll ? "max" : amount);
    if (ok) {
      setAmount("");
      setUseMax(false);
    }
  };

  const setMax = () => {
    if (available == null) return;
    setAmount(formatUnits(BigInt(available), decimalsOf(config, token)));
    setUseMax(true);
  };

  return (
    <form className="amount-form" onSubmit={submit}>
      <div className="field-row">
        <label className="field">
          <span>Token</span>
          <select
            id={`${id}-token`}
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setUseMax(false);
            }}
          >
            {tokens.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>Amount</span>
          <div className="input-with-button">
            <input
              id={`${id}-amount`}
              inputMode="decimal"
              placeholder="0.0"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value.trim());
                setUseMax(false);
              }}
            />
            {available != null && (
              <button type="button" className="small" onClick={setMax}>
                Max
              </button>
            )}
          </div>
        </label>
      </div>
      {available != null && (
        <p className="muted small-text">
          {balanceLabel}: <span className="num">{formatToken(config, available, token)}</span> {token}
        </p>
      )}
      <button className="secondary" type="submit" disabled={Boolean(busy) || disabled || !valid}>
        {submitLabel}
      </button>
    </form>
  );
}
