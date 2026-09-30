import { useCallback, useEffect, useMemo, useState } from "react";
import { erc20Abi, parseEther, parseUnits } from "viem";
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
import { verifyBotPermission, verifyCreateAccount, verifyOwnerAction } from "./lib/verifyMetaMask.js";
import {
  chainFromConfig,
  createClients,
  ensureChain,
  friendlyError,
  hasMetaMask,
  readCurrentNonce,
  reviveDelegationTypedData,
} from "./lib/wallet.js";

export default function App() {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [account, setAccount] = useState(null);
  const [session, setSession] = useState(() => loadSession());
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  // The limits read from the last bot permission the user was shown, straight from the permission itself.
  const [permission, setPermission] = useState(null);

  const chain = useMemo(() => (config ? chainFromConfig(config) : null), [config]);
  const clients = useMemo(() => (chain && hasMetaMask() ? createClients(chain) : null), [chain]);
  const signedIn = Boolean(session);
  // The MetaMask address linked to this login, once the user has linked one.
  const linked = me?.address ?? null;
  // Wallet actions need MetaMask connected on the linked account.
  const walletReady = Boolean(account && linked && account.toLowerCase() === linked.toLowerCase());

  // Keep trying until the backend answers, so starting the frontend first doesn't leave the page stuck.
  useEffect(() => {
    let stopped = false;
    let timer;
    const load = () =>
      api.get("/config").then(
        (value) => {
          if (stopped) return;
          setConfig(value);
          setConfigError(null);
        },
        (error) => {
          if (stopped) return;
          setConfigError(error.message);
          timer = setTimeout(load, 3000);
        },
      );
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  // Reconnect silently if MetaMask already trusts this site, and follow account switches.
  useEffect(() => {
    if (!hasMetaMask()) return;
    window.ethereum.request({ method: "eth_accounts" }).then((accounts) => setAccount(accounts[0] ?? null));
    const onAccounts = (accounts) => setAccount(accounts[0] ?? null);
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

  const logIn = (mode, username, password) =>
    run(mode === "signup" ? "Creating your login…" : "Logging in…", async () => {
      const result = await api.post(mode === "signup" ? "/auth/signup" : "/auth/login", { username, password });
      const next = { token: result.token, username: result.username };
      saveSession(next);
      setSession(next);
    });

  /** Links the connected MetaMask to this login with one free signature. Done once per login. */
  const linkWallet = () =>
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
        statement: `Link this MetaMask to the userDexBot login "${session.username}". Signing is free and does not give access to your funds.`,
      });
      const signature = await clients.wallet.signMessage({ account, message });
      await api.post("/auth/link-wallet", { message, signature });
      await refresh();
      return "MetaMask is linked to your login.";
    });

  /**
   * The user creates their MetaMask smart account (one transaction, they pay the gas), then signs the
   * owner permission that lets them withdraw and stop the bot later. Both are checked in the browser first.
   */
  const createWallet = () =>
    run("Confirm creating your smart account in MetaMask…", async () => {
      await ensureChain(clients.wallet, chain);
      const created = await api.post("/wallet/create-tx");
      await verifyCreateAccount({ created, owner: account, chainId: chain.id });
      const hash = await clients.wallet.sendTransaction({ account, to: created.tx.to, data: created.tx.data });
      setBusy("Waiting for your smart account to be created…");
      await clients.reader.waitForTransactionReceipt({ hash });
      setBusy("Sign the owner permission in MetaMask. It's free…");
      const signature = await clients.wallet.signTypedData({ account, ...reviveDelegationTypedData(created.typedData) });
      await api.post("/wallet", { signature });
      await refresh();
      return `Your smart account is ready. Deposit DEOD or USDT, plus a little ${config.nativeSymbol} for gas, then enable the bot.`;
    });

  const deposit = (symbol, amount) =>
    run("Confirm the deposit in MetaMask…", async () => {
      await ensureChain(clients.wallet, chain);
      const token = config.tokens[symbol];
      // BNB is a plain transfer. DEOD and USDT are token transfers.
      const hash = token
        ? await clients.wallet.writeContract({
            account,
            address: token.address,
            abi: erc20Abi,
            functionName: "transfer",
            args: [me.wallet.account, parseUnits(amount, token.decimals)],
          })
        : await clients.wallet.sendTransaction({ account, to: me.wallet.account, value: parseEther(amount) });
      setBusy("Waiting for the deposit to confirm…");
      await clients.reader.waitForTransactionReceipt({ hash });
      await refresh();
      return `Deposited ${amount} ${symbol} into your smart account.`;
    });

  /** Enabling the bot is one free signature: the browser checks the permission, then MetaMask signs it. */
  const enableBot = () =>
    run("Checking the bot's permission…", async () => {
      await ensureChain(clients.wallet, chain);
      const request = await api.post("/bot/permission");
      const currentNonce = await readCurrentNonce(clients.reader, {
        nonceEnforcer: request.delegation.caveats[0].enforcer,
        delegationManager: request.typedData.domain.verifyingContract,
        account: me.wallet.account,
      });
      const granted = verifyBotPermission({ request, account: me.wallet.account, botAddress: config.botAddress, chainId: chain.id, currentNonce });
      setPermission(granted);
      setBusy("Sign the bot's permission in MetaMask. It's free…");
      const signature = await clients.wallet.signTypedData({ account, ...reviveDelegationTypedData(request.typedData) });
      await api.post(`/bot/permission/${request.id}`, { signature });
      await refresh();
      return "The bot is enabled.";
    });

  /**
   * Stop and withdraw: the backend builds the transaction, the browser checks it, and the user sends it
   * from MetaMask through their own permission, paying the network fee.
   */
  const walletAction = (body, label, done) =>
    run(label, async () => {
      await ensureChain(clients.wallet, chain);
      const action = await api.post("/wallet/actions", body);
      verifyOwnerAction({
        kind: body.kind,
        request: body,
        tx: action.tx,
        owner: account,
        account: me.wallet.account,
        chainId: chain.id,
        nativeSymbol: config.nativeSymbol,
      });
      const hash = await clients.wallet.sendTransaction({ account, to: action.tx.to, data: action.tx.data });
      setBusy("Waiting for the transaction to confirm…");
      await clients.reader.waitForTransactionReceipt({ hash });
      await api.post(`/wallet/actions/${action.id}/confirm`, { txHash: hash });
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
  const onboardingStep = !signedIn
    ? "login"
    : !me
      ? "loading"
      : !account
        ? "connect"
        : !linked
          ? "link"
          : !walletReady
            ? "switch"
            : "create";
  // Deposit, withdraw, enable and stop all open MetaMask, so they wait until it's on the linked account.
  const walletBusy = busy || (walletReady ? null : "Connect MetaMask first");

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width="28" height="28" />
          <span>userDexBot</span>
        </div>
        <div className="topbar-right">
          {config && <span className="chip">{config.chain.name}</span>}
          {signedIn && <span className="chip">{session.username}</span>}
          {account && <span className="chip mono">{shortAddress(account)}</span>}
          {signedIn && (
            <button className="link-button" onClick={signOut}>
              Log out
            </button>
          )}
        </div>
      </header>

      <main>
        {configError && <p className="banner error">Cannot reach the backend: {configError}. Is it running on port 4000?</p>}

        {!signedIn || !me || !linked || !wallet ? (
          <Onboarding
            step={onboardingStep}
            hasMetaMask={hasMetaMask()}
            ready={Boolean(config)}
            account={account}
            linked={linked}
            busy={busy}
            onLogin={logIn}
            onConnect={connect}
            onLink={linkWallet}
            onCreateWallet={createWallet}
          />
        ) : (
          <>
            {!walletReady && (
              <div className="banner warning wallet-banner">
                {!account ? (
                  <>
                    <span>Connect MetaMask to deposit, withdraw or change the bot.</span>
                    <button className="small" disabled={Boolean(busy) || !hasMetaMask()} onClick={connect}>
                      Connect MetaMask
                    </button>
                  </>
                ) : (
                  <span>
                    MetaMask is on {shortAddress(account)}, but this login is linked to <span className="mono">{linked}</span>. Switch to that
                    account in MetaMask.
                  </span>
                )}
              </div>
            )}
            <div className="dashboard">
              <div className="column">
                <WalletCard config={config} owner={linked} wallet={wallet} />
                <DepositForm config={config} busy={walletBusy} ownerBalances={me.ownerBalances} onDeposit={deposit} />
                <WithdrawForm
                  config={config}
                  busy={walletBusy}
                  balances={wallet.balances}
                  onWithdraw={(token, amount) =>
                    walletAction({ kind: "withdraw", token, amount }, "Confirm the withdrawal in MetaMask…", "Withdrawal sent to your MetaMask.")
                  }
                />
              </div>
              <div className="column">
                <BotControl
                  config={config}
                  wallet={wallet}
                  busy={walletBusy}
                  onEnable={enableBot}
                  permission={permission}
                  onStop={() => walletAction({ kind: "stop-bot" }, "Confirm stopping the bot in MetaMask…", "The bot is stopped.")}
                />
                {config.testTradesEnabled && <TestTrade config={config} busy={busy} botEnabled={wallet.botEnabled} onTrade={testTrade} />}
                <Activity config={config} actions={me.actions} trades={me.trades} />
              </div>
            </div>
          </>
        )}
      </main>

      <StatusBar busy={busy} notice={notice} onDismiss={() => setNotice(null)} />
    </div>
  );
}
