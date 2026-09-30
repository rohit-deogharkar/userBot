import { useState } from "react";

/** Username and password, for logging in or creating a new login. */
export default function LoginForm({ busy, onSubmit }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const signup = mode === "signup";
  const mismatch = signup && confirm !== "" && confirm !== password;
  const valid = username.trim() !== "" && password !== "" && (!signup || confirm === password);

  const submit = async (event) => {
    event.preventDefault();
    if (!valid) return;
    const ok = await onSubmit(mode, username.trim(), password);
    if (ok) {
      setPassword("");
      setConfirm("");
    }
  };

  const switchMode = () => {
    setMode(signup ? "login" : "signup");
    setConfirm("");
  };

  return (
    <form className="login-form" onSubmit={submit}>
      <label className="field">
        <span>Username</span>
        <input id="login-username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label className="field">
        <span>Password</span>
        <input
          id="login-password"
          type="password"
          autoComplete={signup ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {signup && (
        <>
          <label className="field">
            <span>Confirm password</span>
            <input id="login-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
          <p className="muted small-text">Usernames need 3 to 32 letters, numbers, dots, dashes or underscores. Passwords need at least 8 characters.</p>
        </>
      )}
      {mismatch && <p className="error-text">The passwords don't match.</p>}
      <button className="primary" type="submit" disabled={Boolean(busy) || !valid}>
        {signup ? "Create login" : "Log in"}
      </button>
      <button type="button" className="link-button" onClick={switchMode}>
        {signup ? "I already have a login" : "New here? Create a login"}
      </button>
    </form>
  );
}
