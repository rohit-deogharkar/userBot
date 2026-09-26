import { useCallback, useEffect, useMemo, useState } from "react";
import { erc20Abi, parseUnits } from "viem";
import { createSiweMessage } from "viem/siwe";
import Activity from "./components/Activity.jsx";
import BotControl from "./components/BotControl.jsx";
import DepositForm from "./components/DepositForm.jsx";
import Onboarding from "./components/Onboarding.jsx";
import StatusBar from "./components/StatusBar.jsx";
import TestTrade from "./components/TestTrade.jsx";
import WalletCard from "./components/WalletCard.jsx";
import WithdrawForm from "./components/WithdrawForm.jsx";
import { api, loadSession, saveSession, setToken } from "./lib/api.js";
import { shortAddress } from "./lib/format.js";
import { verifySafeTx } from "./lib/verifySafeTx.js";
import { chainFromConfig, createClients, ensureChain, friendlyError, hasMetaMask, reviveSafeTypedData } from "./lib/wallet.js";

export default function App() {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [account, setAccount] = useState(null);
  const [session, setSession] = useState(() => loadSession());
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);

  const chain = useMemo(() => (config ? chainFromConfig(config) : null), [config]);
  const clients = useMemo(() => (chain && hasMetaMask() ? createClients(chain) : null), [chain]);
  const signedIn = Boolean(session && account && session.address.toLowerCase() === account.toLowerCase());

  useEffect(() => {
    api.get("/config").then(setConfig, (error) => setConfigError(error.message));
  }, []);

  // Reconnect silently if MetaMask already trusts this site, and follow account switches.
  useEffect(() => {
    if (!hasMetaMask()) return;
    window.ethereum.request({ method: "eth_accounts" }).then((accounts) => setAccount(accounts[0] ?? null));
    const onAccounts = (accounts) => {
      setAccount(accounts[0] ?? null);
      setMe(null);
    };
    window.ethereum.on?.("accountsChanged", onAccounts);
    return () => window.ethereum.removeListener?.("accountsChanged", onAccounts);
  }, []);

  const signOut = useCallback(() => {
    saveSession(null);
    setSession(null);
    setToken(null);
    setMe(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setMe(await api.get("/me"));
    } catch (error) {
      if (error.status === 401) signOut();
      else setNotice({ type: "error", text: error.message });
    }
  }, [signOut]);

  useEffect(() => {
    if (!signedIn) return;
    setToken(session.token);
    refresh();
    const timer = setInterval(refresh, 20_000);
    return () => clearInterval(timer);
  }, [signedIn, session, refresh]);

  /** Runs one user action with a busy message, shows its result or error, and returns whether it worked. */
  const run = useCallback(async (label, task) => {
    setBusy(label);
    setNotice(null);
    try {
      const message = await task();
      if (message) setNotice({ type: "success", text: message });
      return true;
    } catch (error) {
      setNotice({ type: "error", text: friendlyError(error) });
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  const connect = () =>
    run("Waiting for MetaMask…", async () => {
      const [address] = await clients.wallet.requestAddresses();
      setAccount(address);
    });

  const signIn = () =>
    run("Sign the message in MetaMask…", async () => {
      await ensureChain(clients.wallet, chain);
      const { nonce } = await api.get("/auth/nonce");
      const message = createSiweMessage({
        address: account,
        chainId: chain.id,
        domain: window.location.host,
        nonce,
        uri: window.location.origin,
        version: "1",
        statement: "Sign in to userDexBot. Signing is free and does not give access to your funds.",
      });
      const signature = await clients.wallet.signMessage({ account, message });
      const result = await api.post("/auth/verify", { message, signature });
      const next = { address: result.address, token: result.token };
      saveSession(next);
      setSession(next);
    });

  const createWallet = () =>
    run("Creating your bot wallet…", async () => {
      await api.post("/wallet");
      await refresh();
      return "Your bot wallet is ready. Deposit funds, then enable the bot.";
    });

  const deposit = (symbol, amount) =>
    run("Confirm the deposit in MetaMask…", async () => {
      await ensureChain(clients.wallet, chain);
      const token = config.tokens[symbol];
      const hash = await clients.wallet.writeContract({
        account,
        address: token.address,
        abi: erc20Abi,
        functionName: "transfer",
        args: [me.wallet.safeAddress, parseUnits(amount, token.decimals)],
      });
      setBusy("Waiting for the deposit to confirm…");
      await clients.reader.waitForTransactionReceipt({ hash });
      await refresh();
      return `Deposited ${amount} ${symbol} into your bot wallet.`;
    });

  /** Enable, stop and withdraw all follow the same path: the backend builds it, the user signs it. */
  const walletAction = (body, label, done) =>
    run(label, async () => {
      await ensureChain(clients.wallet, chain);
      const action = await api.post("/wallet/actions", body);
      const typedData = reviveSafeTypedData(action.typedData);
      verifySafeTx({ kind: body.kind, request: body, typedData, owner: account, wallet: me.wallet, config });
      const signature = await clients.wallet.signTypedData({ account, ...typedData });
      setBusy("Submitting…");
      await api.post(`/wallet/actions/${action.id}/execute`, { signature });
      await refresh();
      return done;
    });

  const testTrade = (sell, amount) =>
    run("The bot is trading…", async () => {
      const result = await api.post("/bot/test-trade", { sell, amount });
      await refresh();
      return `Test trade done: sold ${amount} ${result.tokenIn}.`;
    });

  const wallet = me?.wallet;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width="28" height="28" />
          <span>userDexBot</span>
        </div>
        <div className="topbar-right">
          {config && <span className="chip">{config.chain.name}</span>}
          {account && <span className="chip mono">{shortAddress(account)}</span>}
          {signedIn && (
            <button className="link-button" onClick={signOut}>
              Sign out
            </button>
          )}
        </div>
      </header>

      <main>
        {configError && <p className="banner error">Cannot reach the backend: {configError}. Is it running on port 4000?</p>}

        {!signedIn || !wallet ? (
          <Onboarding
            hasMetaMask={hasMetaMask()}
            ready={Boolean(config)}
            account={account}
            signedIn={signedIn}
            loadingWallet={signedIn && !me}
            busy={busy}
            onConnect={connect}
            onSignIn={signIn}
            onCreateWallet={createWallet}
          />
        ) : (
          <div className="dashboard">
            <div className="column">
              <WalletCard config={config} owner={account} wallet={wallet} />
              <DepositForm config={config} busy={busy} ownerBalances={me.ownerBalances} onDeposit={deposit} />
              <WithdrawForm
                config={config}
                busy={busy}
                balances={wallet.balances}
                onWithdraw={(token, amount) =>
                  walletAction({ kind: "withdraw", token, amount }, "Sign the withdrawal in MetaMask…", "Withdrawal sent to your MetaMask.")
                }
              />
            </div>
            <div className="column">
              <BotControl
                config={config}
                wallet={wallet}
                busy={busy}
                onEnable={() => walletAction({ kind: "enable-bot" }, "Sign to enable the bot in MetaMask…", "The bot is enabled.")}
                onStop={() => walletAction({ kind: "stop-bot" }, "Sign to stop the bot in MetaMask…", "The bot is stopped.")}
              />
              {config.testTradesEnabled && <TestTrade config={config} busy={busy} botEnabled={wallet.botEnabled} onTrade={testTrade} />}
              <Activity config={config} actions={me.actions} trades={me.trades} />
            </div>
          </div>
        )}
      </main>

      <StatusBar busy={busy} notice={notice} onDismiss={() => setNotice(null)} />
    </div>
  );
}
