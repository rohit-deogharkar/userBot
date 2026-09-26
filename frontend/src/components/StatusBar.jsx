export default function StatusBar({ busy, notice, onDismiss }) {
  if (!busy && !notice) return null;
  const kind = busy ? "busy" : notice.type;
  return (
    <div className={`status-bar ${kind}`} role="status" aria-live="polite">
      {busy && <span className="spinner" aria-hidden="true" />}
      <span>{busy || notice.text}</span>
      {!busy && (
        <button className="link-button" onClick={onDismiss} aria-label="Dismiss">
          Dismiss
        </button>
      )}
    </div>
  );
}
