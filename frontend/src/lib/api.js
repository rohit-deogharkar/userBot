let token = null;

export function setToken(value) {
  token = value;
}

async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON response, handled below.
  }
  if (!res.ok) {
    const error = new Error(json?.error || `Request failed with status ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return json;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body ?? {}),
};

const SESSION_KEY = "userDexBot.session";

/** The saved login, { token, username }, or null. */
export function loadSession() {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
    // Sessions from before username logins have no username, and need a fresh login.
    return session?.token && session?.username ? session : null;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage can be unavailable in private windows. The session then lasts until reload.
  }
}
