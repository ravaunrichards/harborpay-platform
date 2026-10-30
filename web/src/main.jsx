import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  CreditCard,
  History,
  LogOut,
  ShieldCheck,
  Wallet,
  X
} from "lucide-react";
import { supabase, supabaseConfigured } from "./lib/supabase.js";
import "./styles.css";

const rawApiUrl = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? "http://localhost:4000" : "");
const API_URL = rawApiUrl.endsWith("/") ? rawApiUrl.slice(0, -1) : rawApiUrl;

async function apiRequest(path, accessToken, options = {}) {
  if (!API_URL) throw new Error("The HarborPay API URL is not configured.");
  const headers = {
    Accept: "application/json",
    ...(options.headers || {})
  };
  if (accessToken) headers.Authorization = "Bearer " + accessToken;
  if (options.body) headers["Content-Type"] = "application/json";

  const response = await fetch(API_URL + path, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "HarborPay request failed.");
  return payload;
}

function formatMoney(payment) {
  const amount = Number(payment.amount_minor) / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: payment.currency || "USD"
  }).format(amount);
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">h</span>
      <span>harbor<span className="brand-light">pay</span></span>
    </div>
  );
}

function AuthScreen() {
  const [mode, setMode] = useState("signin");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (mode === "signup") {
        if (fullName.trim().length < 2) throw new Error("Enter your full name.");
        const { data, error: authError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { full_name: fullName.trim() } }
        });
        if (authError) throw authError;
        if (!data.session) {
          setNotice("Your account request was received. Confirm your email address before signing in.");
        } else {
          setNotice("Your HarborPay account is ready.");
        }
      } else {
        const { error: authError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password
        });
        if (authError) throw authError;
      }
    } catch (submitError) {
      setError(submitError.message || "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <Brand />
        <div className="auth-copy">
          <p className="eyebrow">SECURE PAYMENTS</p>
          <h1>{mode === "signup" ? "Create your account" : "Welcome back"}</h1>
          <p>Sign in securely to manage your HarborPay payments.</p>
        </div>
        <form className="auth-form" onSubmit={submit}>
          {mode === "signup" && (
            <label>
              Full name
              <input value={fullName} onChange={(event) => setFullName(event.target.value)} autoComplete="name" required />
            </label>
          )}
          <label>
            Email address
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={8} required />
          </label>
          {error && <p className="message error">{error}</p>}
          {notice && <p className="message success">{notice}</p>}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
          </button>
        </form>
        <button className="link-button" type="button" onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(""); setNotice(""); }}>
          {mode === "signup" ? "Already registered? Sign in" : "New to HarborPay? Create an account"}
        </button>
        <p className="auth-foot"><ShieldCheck size={15} /> Account access is protected by Supabase Auth.</p>
      </section>
    </main>
  );
}

function SetupScreen() {
  return (
    <main className="setup-page">
      <section className="setup-card">
        <Brand />
        <div className="setup-icon"><CircleAlert size={24} /></div>
        <p className="eyebrow">CONFIGURATION REQUIRED</p>
        <h1>HarborPay is not connected yet</h1>
        <p>This deployment has no HarborPay Supabase project keys configured. Account creation and payment actions are intentionally unavailable until the dedicated database and authentication project is connected.</p>
        <p className="setup-note">No sample account, balance, or transaction history is being displayed.</p>
        <p className="setup-help">Complete the isolated Supabase and PayPal setup in the repository's operations guide.</p>
      </section>
    </main>
  );
}

function PaymentModal({ onClose, onSubmit, busy, error }) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  function submit(event) {
    event.preventDefault();
    onSubmit({ amount, description, idempotencyKey });
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="payment-modal" role="dialog" aria-modal="true" aria-labelledby="payment-title">
        <button className="modal-close" type="button" onClick={onClose} aria-label="Close payment form"><X size={20} /></button>
        <span className="modal-icon"><CreditCard size={21} /></span>
        <h2 id="payment-title">Make a payment</h2>
        <p>Continue to PayPal to approve your payment securely. HarborPay does not collect or store card numbers.</p>
        <form className="payment-form" onSubmit={submit}>
          <label>
            Amount (USD)
            <div className="amount-field"><span>$</span><input inputMode="decimal" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value)} required /></div>
          </label>
          <label>
            Payment description
            <input maxLength={120} placeholder="What is this payment for?" value={description} onChange={(event) => setDescription(event.target.value)} required />
          </label>
          {error && <p className="message error">{error}</p>}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "Connecting to PayPal…" : "Continue to PayPal"}
            <ArrowUpRight size={17} />
          </button>
        </form>
        <p className="modal-foot"><ShieldCheck size={14} /> Payment approval and capture are confirmed by PayPal.</p>
      </section>
    </div>
  );
}

function App() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [payments, setPayments] = useState([]);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [health, setHealth] = useState(null);
  const [section, setSection] = useState("Overview");
  const [showPayment, setShowPayment] = useState(false);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [paymentError, setPaymentError] = useState("");
  const [notice, setNotice] = useState("");
  const processedCapture = useRef(false);

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true);
      return undefined;
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthReady(true);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!API_URL) return undefined;
    let active = true;
    fetch(API_URL + "/api/health")
      .then((response) => response.json())
      .then((payload) => { if (active) setHealth(payload); })
      .catch(() => { if (active) setHealth({ ok: false }); });
    return () => { active = false; };
  }, []);

  async function loadPayments(accessToken) {
    setPaymentsLoading(true);
    try {
      const result = await apiRequest("/api/payments", accessToken);
      setPayments(result.items || []);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setPaymentsLoading(false);
    }
  }

  useEffect(() => {
    if (!session) {
      setPayments([]);
      processedCapture.current = false;
      return;
    }

    const query = new URLSearchParams(window.location.search);
    const orderId = query.get("token");
    const paymentState = query.get("payment");

    if (paymentState === "cancelled") {
      if (orderId) {
        apiRequest("/api/payments/cancel", session.access_token, {
          method: "POST",
          body: { orderId }
        }).catch(() => {});
      }
      setNotice("The PayPal checkout was cancelled. No completed payment was recorded.");
      window.history.replaceState({}, "", window.location.pathname);
    }

    if (orderId && !processedCapture.current && paymentState !== "cancelled") {
      processedCapture.current = true;
      apiRequest("/api/payments/capture", session.access_token, {
        method: "POST",
        body: { orderId }
      }).then((result) => {
        if (result.payment?.status === "completed") {
          setNotice("PayPal confirmed your payment.");
        } else if (result.payment?.status === "review_required") {
          setNotice("PayPal returned details that need manual review. The payment is not shown as completed.");
        } else {
          setNotice("PayPal returned the capture status: " + (result.providerStatus || result.payment?.status || "unknown") + ".");
        }
        return loadPayments(session.access_token);
      }).catch((error) => {
        setNotice(error.message);
        return loadPayments(session.access_token);
      }).finally(() => {
        window.history.replaceState({}, "", window.location.pathname);
      });
      return;
    }

    loadPayments(session.access_token);
  }, [session]);

  async function createPayment(values) {
    setPaymentBusy(true);
    setPaymentError("");
    try {
      const { idempotencyKey, ...body } = values;
      const result = await apiRequest("/api/payments/orders", session.access_token, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body
      });
      window.location.assign(result.approvalUrl);
    } catch (error) {
      setPaymentError(error.message);
      setPaymentBusy(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  if (!authReady) {
    return <main className="loading-page"><div className="loader" /><span>Loading secure account…</span></main>;
  }

  if (!supabaseConfigured) return <SetupScreen />;
  if (!session) return <AuthScreen />;

  const completedCount = payments.filter((payment) => payment.status === "completed").length;
  const pendingCount = payments.filter((payment) => ["created", "approved", "pending"].includes(payment.status)).length;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="account-card">
          <div className="account-avatar">{(session.user.email || "H").slice(0, 1).toUpperCase()}</div>
          <div className="account-copy"><strong>{session.user.user_metadata?.full_name || "HarborPay account"}</strong><small>{session.user.email}</small></div>
        </div>
        <p className="nav-caption">ACCOUNT</p>
        <nav className="side-nav">
          <button className={section === "Overview" ? "active" : ""} onClick={() => setSection("Overview")}><Wallet size={18} /> Overview</button>
          <button className={section === "Transactions" ? "active" : ""} onClick={() => setSection("Transactions")}><History size={18} /> Transactions</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="security-note"><ShieldCheck size={19} /><span><strong>Provider-secured checkout</strong><small>Payment approval stays on PayPal.</small></span></div>
          <button className="signout-button" onClick={signOut}><LogOut size={17} /> Sign out</button>
          <small className="side-legal">HarborPay · Payment records are not stored-value balances.</small>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div><span className="crumb">HarborPay</span><span className="crumb-separator">/</span><strong>{section}</strong></div>
          <div className="topbar-right">
            <span className={"connection-state " + (health?.configured?.paypal && health?.configured?.supabase ? "ready" : "warning")}>
              <i /> {health?.configured?.paypal && health?.configured?.supabase ? "Providers configured" : "Setup incomplete"}
            </span>
            <div className="user-pill">{session.user.email}</div>
          </div>
        </header>

        <div className="page-content">
          <section className="page-heading">
            <div>
              <p className="eyebrow">YOUR PAYMENT SPACE</p>
              <h1>{section === "Overview" ? "Welcome to HarborPay" : "Your transactions"}</h1>
              <p>Secure checkout, clear payment records, and real provider status.</p>
            </div>
            {section === "Overview" && <button className="primary-button top-pay" onClick={() => { setPaymentError(""); setShowPayment(true); }}>Make a payment <ArrowUpRight size={17} /></button>}
          </section>

          {notice && <div className="notice-bar"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss notice"><X size={16} /></button></div>}

          {section === "Overview" && (
            <>
              <section className="balance-grid">
                <div className="balance-card">
                  <div className="balance-title"><span>HarborPay stored balance</span><Wallet size={19} /></div>
                  <strong className="balance-value">Not offered</strong>
                  <p>Funds are processed by PayPal and settle to the merchant account. HarborPay is not presenting a customer-held wallet balance.</p>
                </div>
                <div className="stat-card">
                  <span className="stat-icon"><CheckCircle2 size={20} /></span>
                  <small>Completed payments</small>
                  <strong>{completedCount}</strong>
                  <span className="stat-foot">Confirmed by PayPal capture</span>
                </div>
                <div className="stat-card">
                  <span className="stat-icon pending"><History size={20} /></span>
                  <small>Awaiting provider update</small>
                  <strong>{pendingCount}</strong>
                  <span className="stat-foot">Not counted as completed</span>
                </div>
              </section>
              <section className="information-panel">
                <div className="information-icon"><ShieldCheck size={21} /></div>
                <div><strong>Your payment is handled by PayPal</strong><p>HarborPay sends you to PayPal for approval. A payment is marked completed only after PayPal confirms the capture. Your card details are not entered into HarborPay.</p></div>
              </section>
            </>
          )}

          <section className="activity-section">
            <div className="section-heading">
              <div><h2>{section === "Overview" ? "Recent transactions" : "Transaction history"}</h2><p>Records associated with your signed-in account.</p></div>
              <button className="text-button" onClick={() => loadPayments(session.access_token)} disabled={paymentsLoading}>{paymentsLoading ? "Refreshing…" : "Refresh"} <ArrowDownLeft size={15} /></button>
            </div>
            <div className="activity-card">
              <div className="table-head"><span>PAYMENT</span><span>DATE</span><span>STATUS</span><span className="align-right">AMOUNT</span></div>
              {paymentsLoading && <div className="empty-state">Loading payment records…</div>}
              {!paymentsLoading && payments.length === 0 && <div className="empty-state">No payment records found for this account.</div>}
              {!paymentsLoading && payments.map((payment) => (
                <div className="transaction-row" key={payment.id}>
                  <div className="payment-description"><span className="transaction-icon"><CreditCard size={17} /></span><span><strong>{payment.description}</strong><small>PayPal order {payment.provider_order_id || "pending setup"}</small></span></div>
                  <span className="date-cell">{formatDate(payment.created_at)}</span>
                  <span><em className={"status-pill " + payment.status}>{payment.status.replaceAll("_", " ")}</em></span>
                  <strong className="amount-cell">{formatMoney(payment)}</strong>
                </div>
              ))}
              <div className="table-foot">Payment statuses come from PayPal capture responses and verified webhook events.</div>
            </div>
          </section>
          <footer className="app-footer"><span>HarborPay</span><span>Secure payments · No fabricated balances</span></footer>
        </div>
      </main>

      {showPayment && <PaymentModal onClose={() => setShowPayment(false)} onSubmit={createPayment} busy={paymentBusy} error={paymentError} />}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
