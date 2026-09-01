"use client";


import { useEffect, useState, useRef } from "react";
import { startOfDay } from "@/lib/orders";
import { orderTypeMeta, isDelivery, orderDestinationLabel } from "@/lib/order-types";
import { db } from "@/lib/firebase";
import { AuthGuard } from "@/lib/auth-guard";
import { useAuth } from "@/lib/auth-context";
import { requestNotificationPermission, showPopupNotification } from "@/lib/notifications";
import { collection, onSnapshot, query, orderBy, where, doc, updateDoc } from "firebase/firestore";

const MAX_CONCURRENT_PREPARING = 5;

export default function KitchenPageWrapper() {
  return (
    <AuthGuard allowedRoles={["kitchen"]}>
      <KitchenPage />
    </AuthGuard>
  );
}

function playKitchenAlert() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const beep = (freq, start, dur) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.28, ctx.currentTime + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.05);
    };
    beep(880, 0, 0.16);
    beep(1046, 0.2, 0.16);
    beep(880, 0.4, 0.16);
    beep(1046, 0.6, 0.26);
  } catch {}
}

function OrderBanner({ table, count, onDismiss }) {
  return (
    <div onClick={onDismiss} style={{ position: "fixed", top: 14, left: "50%", transform: "translateX(-50%)", zIndex: 300, cursor: "pointer", background: "linear-gradient(135deg, #f59e0b, #ea580c)", color: "#fff", padding: "16px 22px", borderRadius: 18, boxShadow: "0 14px 40px rgba(234,88,12,0.4)", display: "flex", alignItems: "center", gap: 14, animation: "bannerDrop 0.45s cubic-bezier(0.22,1,0.36,1)", maxWidth: "92vw" }}>
      <div style={{ fontSize: 30, animation: "bannerRing 0.6s ease 0.3s 2" }}>🔔</div>
      <div>
        <div style={{ fontWeight: 800, fontSize: 16 }}>New Order — Table {table}</div>
        <div style={{ fontSize: 12.5, opacity: 0.9 }}>{count} item{count > 1 ? "s" : ""} just came in · tap to dismiss</div>
      </div>
    </div>
  );
}

// Sort VIP orders to the front, otherwise keep arrival order (list is already
// createdAt-ascending from the Firestore query, so this is a stable sort).
function sortByVip(list) {
  return [...list].sort((a, b) => (b.isVIP ? 1 : 0) - (a.isVIP ? 1 : 0));
}

function getCountdown(o) {
  if (!o.etaMinutes || !o.preparingAt) return null;
  const totalSeconds = o.etaMinutes * 60;
  const elapsed = Math.floor((Date.now() - o.preparingAt) / 1000);
  const remaining = totalSeconds - elapsed;
  if (remaining <= 0) return "Overdue!";
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function getElapsed(o) {
  const elapsed = Math.floor((Date.now() - o.createdAt) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Kitchen Order Ticket (KOT) auto-print
// ---------------------------------------------------------------------------
// This builds a small 80mm-wide printable HTML ticket in a hidden iframe and
// calls window.print() on it. Most thermal receipt printers (Epson TM-series,
// Xprinter, etc.) install as a normal OS printer via USB/Ethernet/Bluetooth,
// so as long as that printer is set as the DEFAULT PRINTER on this kitchen
// device, the browser print dialog will default to it — hit Enter/Print and
// it comes out the thermal printer.
//
// NOTE — true "silent" printing (no dialog at all) is NOT possible from a
// plain web page for security reasons. Two ways to get a fully silent,
// zero-click print:
//   1. Run Chrome/Edge on the kitchen device with the --kiosk-printing flag
//      (or as a kiosk-mode PWA) — this skips the dialog and prints straight
//      to the default printer.
//   2. Use a local print bridge like QZ Tray or a small Node/ESC-POS service
//      running on the kitchen PC, and POST the ticket data to it instead of
//      calling window.print(). That gives you raw ESC/POS control (auto-cut,
//      cash-drawer kick, etc.) but needs that extra local service installed.
// This implementation uses approach with window.print() so it works out of
// the box with zero extra installs — swap the internals for a QZ Tray call
// later if you want silent kiosk printing.
function printKitchenTicket(order) {
  try {
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.setAttribute("aria-hidden", "true");
    document.body.appendChild(iframe);

    const itemsHtml = order.items
      .map((it) => {
        const spice = it.spiceLevel ? `<div class="sub">Spice: ${escapeHtml(it.spiceLevel)}</div>` : "";
        const notes = it.notes ? `<div class="sub">Note: ${escapeHtml(it.notes)}</div>` : "";
        return `
          <div class="line">
            <span class="qty">${it.qty}x</span>
            <span class="name">${escapeHtml(it.name)}</span>
          </div>
          ${spice}${notes}
        `;
      })
      .join("");

    const html = `
      <html>
        <head>
          <title>KOT - Table ${escapeHtml(order.table)}</title>
          <style>
            @page { size: 80mm auto; margin: 0; }
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: 'Courier New', monospace; width: 80mm; padding: 8px 10px; color: #000; }
            .center { text-align: center; }
            .title { font-size: 17px; font-weight: 800; letter-spacing: 1px; }
            .divider { border-top: 1px dashed #000; margin: 8px 0; }
            .row { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 3px; }
            .line { display: flex; gap: 8px; font-size: 15px; font-weight: 800; margin-top: 8px; }
            .qty { min-width: 30px; }
            .sub { font-size: 12px; padding-left: 38px; font-style: italic; }
            .vip { text-align: center; font-weight: 900; margin-top: 6px; font-size: 13px; }
            .footer { margin-top: 12px; font-size: 10px; text-align: center; }
          </style>
        </head>
        <body>
          <div class="center title">KITCHEN ORDER TICKET</div>
          <div class="divider"></div>
          <div class="row"><span>${order.orderType === "delivery" ? "DELIVERY" : order.orderType === "takeaway" ? "TAKEAWAY" : "Table"}</span><span>${escapeHtml(order.orderType === "delivery" || order.orderType === "takeaway" ? "" : order.table)}</span></div>
          ${order.orderType === "delivery" ? '<div class="vip">*** FOR DELIVERY - PACK TO TRAVEL ***</div>' : ""}
          <div class="row"><span>Time</span><span>${new Date(order.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
          ${order.isVIP ? `<div class="vip">★ VIP ORDER ★</div>` : ""}
          <div class="divider"></div>
          ${itemsHtml}
          <div class="divider"></div>
          <div class="footer">Printed ${new Date().toLocaleString()}</div>
        </body>
      </html>
    `;

    const cleanup = () => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    };

    // An iframe with no src fires `load` for its initial about:blank AND again
    // after document.write()/close(). Without this guard every ticket printed
    // twice.
    let printStarted = false;
    iframe.onload = () => {
      if (printStarted) return;
      printStarted = true;
      setTimeout(() => {
        try {
          iframe.contentWindow.focus();
          iframe.contentWindow.print();
        } catch (e) {
          console.error("KOT print failed", e);
        }
        setTimeout(cleanup, 1500);
      }, 200);
    };

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
  } catch (e) {
    console.error("printKitchenTicket failed", e);
  }
}

// Which orders this device has already printed a ticket for.
//
// This has to survive a page reload: the kitchen tablet gets refreshed, put to
// sleep, and reopened constantly, and without persistence every one of those
// reprinted the entire waiting queue. Capped so the key cannot grow forever.
const PRINTED_KEY = (restaurantId) => `cabadra:kot-printed:${restaurantId}`;

function loadPrintedIds(restaurantId) {
  try {
    return new Set(JSON.parse(localStorage.getItem(PRINTED_KEY(restaurantId)) || "[]"));
  } catch {
    return new Set();
  }
}

function savePrintedIds(restaurantId, ids) {
  try {
    localStorage.setItem(PRINTED_KEY(restaurantId), JSON.stringify([...ids].slice(-300)));
  } catch {}
}

// Module-scope on purpose — see the note in receptionist/page.js above
// StatCard/OrderCard/MenuItemCard for why. Here it matters even more: this
// page re-renders every second (the currentTime clock), so a component
// defined *inside* KitchenPage would remount every ticket card once a
// second, restarting animations and dropping any focus/scroll state.
function TicketCard({ order, type, isMobile, menuImageMap, children }) {
  const countdown = type === "preparing" ? getCountdown(order) : null;
  const isOverdue = countdown === "Overdue!";
  let borderColor = type === "confirmed" ? "#f59e0b" : type === "preparing" ? (isOverdue ? "#ef4444" : "#3b82f6") : "#22c55e";
  if (order.isVIP) borderColor = "#eab308";

  return (
    <div className="card" style={{ padding: isMobile ? 16 : 20, marginBottom: isMobile ? 14 : 16, borderLeft: `4px solid ${borderColor}`, transition: "all 0.2s ease", animation: "cardIn 0.3s ease", position: "relative" }}>
      {order.isVIP && (
        <div style={{ position: "absolute", top: -8, right: 14, background: "#eab308", color: "#1a1a2e", fontSize: 10.5, fontWeight: 800, padding: "3px 10px", borderRadius: 100, letterSpacing: 0.3 }}>★ VIP</div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: isMobile ? 12 : 14 }}>
        <div>
          <div style={{ fontSize: isMobile ? 24 : 28, fontWeight: 800, color: isDelivery(order) ? orderTypeMeta("delivery").color : "var(--primary)" }}>
            {orderDestinationLabel(order)}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
            {new Date(order.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {getElapsed(order)} ago
          </div>
        </div>
        {type === "preparing" && countdown && (
          <div style={{ fontFamily: "monospace", fontSize: isMobile ? 20 : 24, fontWeight: 700, color: isOverdue ? "#ef4444" : "#3b82f6", background: isOverdue ? "#fee2e2" : "#dbeafe", padding: "6px 14px", borderRadius: 10, animation: isOverdue ? "pulseRed 1s ease infinite" : "none" }}>
            {countdown}
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: isMobile ? 14 : 16 }}>
        {order.items.map((it, i) => {
          const img = menuImageMap[it.name];
          return (
            <div key={i} style={{ padding: isMobile ? "8px 10px" : "10px 14px", background: "var(--surface-2)", borderRadius: 10, fontSize: isMobile ? 14 : 15 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  {img ? (
                    <img src={img} alt="" style={{ width: isMobile ? 30 : 38, height: isMobile ? 30 : 38, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} />
                  ) : (
                    <div style={{ width: isMobile ? 30 : 38, height: isMobile ? 30 : 38, borderRadius: 8, background: "var(--surface)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>🍽️</div>
                  )}
                  <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
                </div>
                <span style={{ background: "var(--primary)", color: "#fff", padding: "2px 10px", borderRadius: 100, fontSize: 13, fontWeight: 700, flexShrink: 0, marginLeft: 8 }}>×{it.qty}</span>
              </div>
              {(it.spiceLevel || it.notes) && (
                <div style={{ marginTop: 6, paddingLeft: isMobile ? 40 : 48, display: "flex", flexDirection: "column", gap: 2 }}>
                  {it.spiceLevel && <span style={{ fontSize: 11.5, color: "#c2410c", fontWeight: 700 }}>🌶 {it.spiceLevel}</span>}
                  {it.notes && <span style={{ fontSize: 11.5, color: "#666", fontStyle: "italic" }}>"{it.notes}"</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {children}
    </div>
  );
}

function KitchenPage() {
  const { role, logout, restaurantId } = useAuth();
  const [orders, setOrders] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [ordersLoaded, setOrdersLoaded] = useState(false); // gates auto-print until real data has landed
  const [autoStartError, setAutoStartError] = useState(null); // surfaced so a denied write is visible, not silent
  const [etaInputs, setEtaInputs] = useState({});
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isMobile, setIsMobile] = useState(false);
  const [mobileTab, setMobileTab] = useState("confirmed");
  const [banner, setBanner] = useState(null);

  const autoPromotingRef = useRef(new Set()); // in-flight lock so the auto-promote effect can't double-write the same order
  const autoPromoteFailedRef = useRef(new Set()); // orders whose auto-start failed permanently — never retried
  const printedIdsRef = useRef(new Set());   // orders this device has already printed a KOT for
  const printedSeededRef = useRef(false);    // false until the first snapshot has been absorbed
  const DEFAULT_ETA = 20;
  const ETA_PRESETS = [10, 15, 20, 25, 30];

  useEffect(() => {
    if (!restaurantId) return;
    // Rehydrate what this device has already printed before any snapshot lands,
    // so a reload cannot reprint tickets that already came out of the printer.
    printedIdsRef.current = loadPrintedIds(restaurantId);
    // Re-seed on the next snapshot. ordersLoaded is intentionally not reset
    // here: seeding is gated on printedSeededRef, so resetting it as well would
    // only add a redundant render.
    printedSeededRef.current = false;

    // Bounded to the current service. The kitchen has no use for last month's
    // orders, and this listener previously pulled every order ever written.
    const q = query(
      collection(db, "restaurants", restaurantId, "orders"),
      where("createdAt", ">=", startOfDay()),
      orderBy("createdAt", "asc"),
    );
    const unsub = onSnapshot(q, (snap) => {
      setOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setOrdersLoaded(true);
    });
    return () => unsub();
  }, [restaurantId]);

  useEffect(() => {
    if (!restaurantId) return;
    const q = query(collection(db, "restaurants", restaurantId, "menuItems"));
    const unsub = onSnapshot(q, (snap) => setMenuItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    return () => unsub();
  }, [restaurantId]);

  useEffect(() => {
    const t = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 900);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => { requestNotificationPermission(); }, []);

  const confirmed = sortByVip(orders.filter((o) => o.status === "confirmed"));
  const preparing = sortByVip(orders.filter((o) => o.status === "preparing"));
  const ready = sortByVip(orders.filter((o) => o.status === "ready"));

  // Auto-print a Kitchen Order Ticket for each newly confirmed order — exactly
  // once per order, per device, ever.
  //
  // The previous version keyed off a ref that started as null and was seeded on
  // the first effect run. That run happened while `orders` was still the empty
  // initial state, so the ref was seeded EMPTY — and the moment real data
  // arrived, every order already waiting looked brand new and got printed. A
  // page refresh therefore reprinted the whole queue, which is the "it keeps
  // printing again and again" behaviour.
  //
  // Now: nothing is considered new until the first Firestore snapshot has
  // landed, whatever is already waiting at that moment is marked as handled
  // without printing, and the printed set is persisted so a reload is a no-op.
  useEffect(() => {
    if (!restaurantId || !ordersLoaded) return;

    if (!printedSeededRef.current) {
      confirmed.forEach((o) => printedIdsRef.current.add(o.id));
      savePrintedIds(restaurantId, printedIdsRef.current);
      printedSeededRef.current = true;
      return;
    }

    const newOnes = confirmed.filter((o) => !printedIdsRef.current.has(o.id));
    if (newOnes.length === 0) return;

    const latest = newOnes[newOnes.length - 1];
    const itemCount = latest.items.reduce((s, it) => s + it.qty, 0);
    playKitchenAlert();
    setBanner({ table: latest.table, count: itemCount });
    showPopupNotification("🔔 New Order!", `Table ${latest.table} — ${itemCount} item(s)`, { tag: "kitchen-new-order", renotify: true });
    setMobileTab("confirmed");
    setTimeout(() => setBanner(null), 5500);

    newOnes.forEach((o) => {
      printedIdsRef.current.add(o.id);
      printKitchenTicket(o);
    });
    savePrintedIds(restaurantId, printedIdsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmed.map((o) => o.id).join(","), ordersLoaded, restaurantId]);

  // Deliberate reprint, for a jammed printer or a lost ticket. Bypasses the
  // printed-once guard because the operator is explicitly asking for it.
  function reprintTicket(order) {
    printKitchenTicket(order);
  }

  const menuImageMap = {};
  menuItems.forEach((m) => { if (m.imageUrl) menuImageMap[m.name] = m.imageUrl; });

  async function startCooking(id, presetMins) {
    const mins = presetMins || parseInt(etaInputs[id]) || DEFAULT_ETA;
    await updateDoc(doc(db, "restaurants", restaurantId, "orders", id), { status: "preparing", etaMinutes: mins, preparingAt: Date.now() });
  }
  async function markReady(id) {
    await updateDoc(doc(db, "restaurants", restaurantId, "orders", id), { status: "ready" });
  }
  // NEW: bump a running timer's total duration without resetting preparingAt —
  // the countdown recalculates from (original start time + new duration), so
  // extending/shortening mid-cook doesn't restart the clock.
  async function adjustEta(id, currentEta, delta) {
    const next = Math.max(1, (currentEta || DEFAULT_ETA) + delta);
    await updateDoc(doc(db, "restaurants", restaurantId, "orders", id), { etaMinutes: next });
  }
  async function setEtaExact(id, currentEta) {
    const input = window.prompt("New ETA in minutes:", String(currentEta || DEFAULT_ETA));
    if (input === null) return;
    const n = parseInt(input);
    if (!isNaN(n) && n > 0) {
      await updateDoc(doc(db, "restaurants", restaurantId, "orders", id), { etaMinutes: n });
    }
  }

  // NEW: auto-start queue. Whenever there's an open slot (fewer than
  // MAX_CONCURRENT_PREPARING orders cooking) AND at least one order waiting
  // in "confirmed", promote the front of the queue (VIP first, then oldest)
  // straight to "preparing" using its reception-computed presetEtaMinutes —
  // zero clicks. Re-runs every time the preparing count changes (an order
  // clears) or the queue's front order changes (a new one arrives, or the
  // previous front just got promoted), so it naturally drains the whole
  // backlog one at a time as slots free up.
  useEffect(() => {
    if (!restaurantId) return;
    if (preparing.length >= MAX_CONCURRENT_PREPARING) return;
    const next = confirmed[0];
    if (!next) return;
    if (autoPromotingRef.current.has(next.id)) return;
    // A write that failed for a reason that will not change on its own — a
    // permissions denial, a deleted order — must never be retried. Without
    // this the effect span-locked: updateDoc applies optimistically to the
    // local cache (so preparing.length changes), the server rejects it, the
    // cache rolls back (preparing.length changes again), and both flips
    // re-trigger this effect. The result was a permanent loop of denied
    // writes hammering Firestore.
    if (autoPromoteFailedRef.current.has(next.id)) return;
    autoPromotingRef.current.add(next.id);
    const mins = next.presetEtaMinutes || DEFAULT_ETA;
    updateDoc(doc(db, "restaurants", restaurantId, "orders", next.id), { status: "preparing", etaMinutes: mins, preparingAt: Date.now() })
      .catch((e) => {
        const permanent = e?.code === "permission-denied" || e?.code === "not-found" || e?.code === "invalid-argument";
        if (permanent) {
          autoPromoteFailedRef.current.add(next.id);
          setAutoStartError(
            e.code === "permission-denied"
              ? "This account cannot start orders. Ask your manager to re-invite you to this outlet."
              : `Could not auto-start an order (${e.code}).`
          );
        }
        console.error("Auto-start failed:", e.code || e.message);
      })
      .finally(() => autoPromotingRef.current.delete(next.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preparing.length, confirmed[0]?.id, restaurantId]);

  const columns = [
    { key: "confirmed", label: "Waiting to Start", icon: "🕒", color: "#f59e0b", bg: "#fef3c7", fg: "#92400e", list: confirmed, empty: { icon: "☕", msg: "Nothing waiting — new orders start cooking automatically." } },
    { key: "preparing", label: "On the Stove", icon: "🔥", color: "#3b82f6", bg: "#dbeafe", fg: "#1e40af", list: preparing, empty: { icon: "🍳", msg: "Nothing on the stove right now." } },
    { key: "ready", label: "Ready for Pickup", icon: "✅", color: "#22c55e", bg: "#dcfce7", fg: "#166534", list: ready, empty: { icon: "🍽️", msg: "Nothing plated yet." } },
  ];

  function renderTicketActions(type, order) {
    if (type === "confirmed") {
      const atCapacity = preparing.length >= MAX_CONCURRENT_PREPARING;
      const defaultEta = order.presetEtaMinutes || DEFAULT_ETA;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{
            fontSize: 12, fontWeight: 700, padding: "8px 12px", borderRadius: 10,
            background: atCapacity ? "#fef2f2" : "#eff6ff", color: atCapacity ? "#b91c1c" : "#1d4ed8",
          }}>
            {atCapacity
              ? `🔥 Kitchen at capacity (${preparing.length}/${MAX_CONCURRENT_PREPARING}) — will auto-start the moment a slot frees, or start it now below.`
              : `⚡ Preset ETA ${defaultEta}m — starting automatically…`}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {ETA_PRESETS.map((m) => (
              <button
                key={m}
                className="btn-preset"
                onClick={() => startCooking(order.id, m)}
                style={{ flex: isMobile ? "1 1 60px" : "0 0 auto", ...(m === defaultEta ? { background: "#3b82f6", color: "#fff" } : {}) }}
              >
                {m}m
              </button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: isMobile ? "wrap" : "nowrap" }}>
            <input type="number" placeholder={String(defaultEta)} defaultValue={defaultEta} onChange={(e) => setEtaInputs((prev) => ({ ...prev, [order.id]: e.target.value }))}
              style={{ width: isMobile ? 64 : 70, padding: isMobile ? "12px 10px" : "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: 15, fontWeight: 600, textAlign: "center" }} />
            <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>min (custom)</span>
            <button className="btn-preset" onClick={() => reprintTicket(order)} title="Print this ticket again">
              🖨 Reprint
            </button>
            <button className="btn btn-primary" onClick={() => startCooking(order.id, parseInt(etaInputs[order.id]) || defaultEta)} style={{ marginLeft: isMobile ? 0 : "auto", flex: isMobile ? "1 1 auto" : "none" }}>
              ▶ Start Preparing Now
            </button>
          </div>
        </div>
      );
    }
    if (type === "preparing") {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button className="btn-preset" onClick={() => adjustEta(order.id, order.etaMinutes, -5)}>-5m</button>
            <button className="btn-preset" onClick={() => adjustEta(order.id, order.etaMinutes, 5)}>+5m</button>
            <button className="btn-preset" onClick={() => setEtaExact(order.id, order.etaMinutes)}>✎ Set</button>
          </div>
          <button className="btn btn-success" onClick={() => markReady(order.id)} style={{ width: "100%" }}>✓ Mark Ready for Pickup</button>
        </div>
      );
    }
    return <div style={{ background: "#dcfce7", color: "#166534", padding: "12px 16px", borderRadius: 10, textAlign: "center", fontWeight: 600, fontSize: 14 }}>Waiting for server pickup</div>;
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: "sans-serif" }}>
      <style>{`
        @keyframes bannerDrop { from { opacity: 0; transform: translate(-50%, -130%); } to { opacity: 1; transform: translate(-50%, 0); } }
        @keyframes bannerRing { 0%, 100% { transform: rotate(0deg); } 25% { transform: rotate(-15deg); } 75% { transform: rotate(15deg); } }
        @keyframes cardIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulseRed { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
        @keyframes countBump { 0% { transform: scale(1); } 40% { transform: scale(1.3); } 100% { transform: scale(1); } }

        .btn {
          border: none;
          border-radius: 10px;
          font-weight: 700;
          cursor: pointer;
          padding: 14px 20px;
          font-size: 15px;
          transition: transform 0.12s ease, box-shadow 0.12s ease, filter 0.12s ease;
          box-shadow: 0 4px 14px rgba(0,0,0,0.12);
        }
        .btn:active { transform: translateY(1px) scale(0.99); }
        .btn:hover { filter: brightness(1.06); box-shadow: 0 6px 18px rgba(0,0,0,0.16); }
        .btn:disabled { opacity: 0.55; cursor: not-allowed; box-shadow: none; filter: none; transform: none; }

        .btn-primary {
          background: linear-gradient(135deg, #3b82f6, #2563eb);
          color: #fff;
        }
        .btn-success {
          background: linear-gradient(135deg, #22c55e, #16a34a);
          color: #fff;
          padding: 16px 20px;
          font-size: 16px;
        }
        .btn-preset {
          border: 1.5px solid #3b82f6;
          background: #eff6ff;
          color: #1d4ed8;
          font-weight: 800;
          font-size: 13.5px;
          padding: 9px 12px;
          border-radius: 100px;
          cursor: pointer;
          transition: all 0.12s ease;
        }
        .btn-preset:hover { background: #3b82f6; color: #fff; }
        .btn-preset:active { transform: scale(0.96); }
      `}</style>

      {banner && <OrderBanner table={banner.table} count={banner.count} onDismiss={() => setBanner(null)} />}

      <div style={{ background: "var(--primary)", color: "#fff", padding: isMobile ? "14px 16px" : "20px 24px", position: "sticky", top: 0, zIndex: 10, boxShadow: "0 2px 20px rgba(0,0,0,0.1)" }}>
        <div style={{ maxWidth: 1400, margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 10 : 14 }}>
            <div style={{ width: isMobile ? 36 : 44, height: isMobile ? 36 : 44, borderRadius: 12, background: "rgba(232,163,61,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: isMobile ? 18 : 24, flexShrink: 0 }}>👨‍🍳</div>
            <div>
              <h1 style={{ fontSize: isMobile ? 16 : 22, fontWeight: 800, margin: 0 }}>Kitchen Display</h1>
              {!isMobile && <div style={{ fontSize: 13, opacity: 0.7 }}>{currentTime.toLocaleTimeString()}</div>}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 10 : 24 }}>
            {!isMobile && (
              <div style={{ display: "flex", gap: 16, fontSize: 14 }}>
                <div style={{ textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 800 }}>{confirmed.length}</div><div style={{ opacity: 0.7 }}>Waiting</div></div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: preparing.length >= MAX_CONCURRENT_PREPARING ? "#fca5a5" : "#fff" }}>{preparing.length}/{MAX_CONCURRENT_PREPARING}</div>
                  <div style={{ opacity: 0.7 }}>Cooking</div>
                </div>
                <div style={{ textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 800 }}>{ready.length}</div><div style={{ opacity: 0.7 }}>Ready</div></div>
              </div>
            )}
            <button onClick={logout} style={{ background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", padding: isMobile ? "8px 12px" : "8px 16px", borderRadius: 10, cursor: "pointer", fontSize: isMobile ? 12 : 13, fontWeight: 600, whiteSpace: "nowrap" }}>
              🚪{!isMobile && ` Logout ${role ? `(${role})` : ""}`}
            </button>
          </div>
        </div>
      </div>

      {isMobile ? (
        <>
          <div style={{ position: "sticky", top: 64, zIndex: 9, background: "var(--bg)", padding: "10px 12px", display: "flex", gap: 8, borderBottom: "1px solid var(--border)" }}>
            {columns.map((col) => {
              const isActive = mobileTab === col.key;
              return (
                <button key={col.key} onClick={() => setMobileTab(col.key)} style={{ flex: 1, padding: "12px 6px", borderRadius: 12, border: "none", background: isActive ? col.color : "var(--surface-2)", color: isActive ? "#fff" : "var(--text-secondary)", fontSize: 12.5, fontWeight: 800, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, cursor: "pointer", transition: "all 0.15s ease" }}>
                  <span style={{ fontSize: 18 }}>{col.icon}</span>
                  <span>{col.label}</span>
                  <span key={col.list.length} style={{ background: isActive ? "rgba(255,255,255,0.25)" : col.bg, color: isActive ? "#fff" : col.fg, padding: "1px 9px", borderRadius: 100, fontSize: 12, fontWeight: 800, animation: "countBump 0.4s ease" }}>{col.list.length}</span>
                </button>
              );
            })}
          </div>

          <div style={{ padding: "16px 14px 40px" }}>
            {columns.find((c) => c.key === mobileTab).list.map((o) => (
              <TicketCard key={o.id} order={o} type={mobileTab} isMobile={isMobile} menuImageMap={menuImageMap}>{renderTicketActions(mobileTab, o)}</TicketCard>
            ))}
            {columns.find((c) => c.key === mobileTab).list.length === 0 && (
              <div className="card" style={{ padding: 44, textAlign: "center", color: "var(--text-secondary)" }}>
                <div style={{ fontSize: 42, marginBottom: 10 }}>{columns.find((c) => c.key === mobileTab).empty.icon}</div>
                <p style={{ margin: 0 }}>{columns.find((c) => c.key === mobileTab).empty.msg}</p>
              </div>
            )}
          </div>
        </>
      ) : (
        <div style={{ maxWidth: 1400, margin: "0 auto", padding: 24, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 24 }}>
          {columns.map((col) => (
            <div key={col.key}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: `2px solid ${col.color}` }}>
                <span style={{ fontSize: 20 }}>{col.icon}</span>
                <h2 style={{ fontSize: 16, fontWeight: 700 }}>{col.label}</h2>
                <span key={col.list.length} style={{ marginLeft: "auto", background: col.bg, color: col.fg, padding: "2px 10px", borderRadius: 100, fontSize: 13, fontWeight: 700, animation: "countBump 0.4s ease" }}>{col.list.length}</span>
              </div>
              {col.list.length === 0 && (
                <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--text-secondary)" }}>
                  <div style={{ fontSize: 40, marginBottom: 8 }}>{col.empty.icon}</div><p>{col.empty.msg}</p>
                </div>
              )}
              {col.list.map((o) => (
                <TicketCard key={o.id} order={o} type={col.key} isMobile={isMobile} menuImageMap={menuImageMap}>{renderTicketActions(col.key, o)}</TicketCard>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}