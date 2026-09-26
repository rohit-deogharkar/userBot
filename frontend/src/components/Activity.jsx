import { explorerLink, formatToken, timeAgo } from "../lib/format.js";

const STATUS_LABEL = {
  awaiting_signature: "Not signed",
  confirming: "Confirming",
  executed: "Done",
  success: "Done",
  failed: "Failed",
  expired: "Expired",
};

function describeTrade(config, trade) {
  const sold = `${formatToken(config, trade.amountIn, trade.tokenIn)} ${trade.tokenIn}`;
  if (trade.status !== "success") return `Bot tried to sell ${sold}`;
  return `Bot sold ${sold} for ${formatToken(config, trade.amountOut, trade.tokenOut)} ${trade.tokenOut}`;
}

export default function Activity({ config, actions, trades }) {
  const items = [
    ...actions.map((a) => ({ key: `a-${a.id}`, text: a.summary, status: a.status, error: a.error, hash: a.txHash, at: a.createdAt })),
    ...trades.map((t) => ({ key: `t-${t.id}`, text: describeTrade(config, t), status: t.status, error: t.error, hash: t.txHash, at: t.createdAt })),
  ]
    .filter((item) => item.status !== "awaiting_signature")
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 15);

  return (
    <section className="card">
      <h2>Activity</h2>
      {items.length === 0 ? (
        <p className="muted">Nothing yet. Wallet actions and bot trades will show up here.</p>
      ) : (
        <ul className="activity">
          {items.map((item) => {
            const link = item.hash && explorerLink(config, "tx", item.hash);
            return (
              <li key={item.key}>
                <span className={`dot ${item.status === "failed" || item.status === "expired" ? "bad" : "good"}`} />
                <div className="activity-body">
                  <span>{item.text}</span>
                  {item.error && <span className="error-text">{item.error}</span>}
                </div>
                <div className="activity-meta">
                  <span>{STATUS_LABEL[item.status] ?? item.status}</span>
                  <span className="muted">{link ? <a href={link} target="_blank" rel="noreferrer">{timeAgo(item.at)}</a> : timeAgo(item.at)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
