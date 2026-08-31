"use client";

// The brand console — the owner and manager dashboard.
//
// Same screens for both roles, scoped by the tested predicates in lib/tenancy:
// an outlet manager sees only their outlets, cannot create outlets, cannot edit
// the master menu, and cannot see billing. Nothing here decides permissions on
// its own; it asks can() and canInvite() and renders accordingly, while the
// security rules enforce the same thing independently.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { AuthGuard } from "@/lib/auth-guard";
import {
  fetchOutlets, fetchBrandToday, createOutlet, renameOutlet,
  fetchMasterMenu, addMasterItem, deleteMasterItem,
} from "@/lib/brand";
import { can, canAccessOutlet, ROLE_LABELS, TIER_LABELS, tierLimits, canAddOutlet } from "@/lib/tenancy";
import { listInvites } from "@/lib/invites";

const money = (n) => `₹${(n || 0).toLocaleString("en-IN")}`;

const card = { background: "#fff", border: "1px solid #e6e1d6", borderRadius: 16, padding: 22, marginBottom: 16 };
const label = { fontSize: 11.5, fontWeight: 800, color: "#6b6b7b", textTransform: "uppercase", letterSpacing: 0.4, display: "block", marginBottom: 6 };
const input = { width: "100%", padding: "11px 13px", border: "1px solid #e6e1d6", borderRadius: 10, fontSize: 14, boxSizing: "border-box", fontFamily: "inherit" };
const btn = { padding: "10px 16px", borderRadius: 10, border: "1px solid #e6e1d6", background: "#fff", fontWeight: 700, fontSize: 13.5, cursor: "pointer", fontFamily: "inherit" };
const btnPrimary = { ...btn, background: "#1a1a2e", color: "#fff", border: "1px solid #1a1a2e" };

function Stat({ k, v, sub }) {
  return (
    <div style={{ ...card, marginBottom: 0, padding: 18 }}>
      <div style={label}>{k}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: "#1a1a2e", lineHeight: 1.1 }}>{v}</div>
      {sub && <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function BrandConsoleInner() {
  const { access, brand, brandId, outletId, setActiveOutlet, logout, refresh } = useAuth();
  const router = useRouter();

  const [tab, setTab] = useState("overview");
  const [outlets, setOutlets] = useState([]);
  const [today, setToday] = useState(null);
  const [master, setMaster] = useState([]);
  const [invites, setInvites] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [newOutlet, setNewOutlet] = useState({ name: "", address: "" });
  const [newItem, setNewItem] = useState({ name: "", price: "", category: "Mains", foodType: "veg", description: "" });

  // Only outlets this person actually reaches. An owner reaches all of them;
  // a manager reaches the ones they were assigned.
  const visibleOutletIds = (brand?.outletIds || []).filter((id) => canAccessOutlet(access, id));
  // A stable primitive for the dependency list — an array literal would be a
  // fresh reference every render and re-fetch forever.
  const outletKey = visibleOutletIds.join(",");
  const roleKey = access.role;

  const load = useCallback(async () => {
    if (!brandId) return;
    const ids = outletKey ? outletKey.split(",") : [];

    // Each section is loaded independently. One failed read used to blank the
    // whole console and report a single vague message; now the parts that work
    // still render and the banner names exactly what did not.
    const failures = [];
    const attempt = async (what, fn, fallback) => {
      try {
        return await fn();
      } catch (e) {
        failures.push(`${what} (${e?.code || e.message})`);
        return fallback;
      }
    };

    const [o, t, m, inv] = await Promise.all([
      attempt("outlets", () => fetchOutlets(ids), []),
      attempt("today's figures", () => fetchBrandToday(ids), null),
      can(access, "editMasterMenu")
        ? attempt("master menu", () => fetchMasterMenu(brandId), [])
        : Promise.resolve([]),
      can(access, "inviteFloorStaff")
        ? attempt("invitations", () => listInvites(brandId), [])
        : Promise.resolve([]),
    ]);

    setOutlets(o);
    setToday(t);
    setMaster(m);
    setInvites(inv);
    setError(failures.length === 0 ? "" :
      `Could not load ${failures.join(", ")}. If these say permission-denied, deploy the latest rules: firebase deploy --only firestore:rules`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // Primitives only. `brand` is an object; putting it here makes the callback
    // a new identity whenever auth state refreshes, which re-runs the effect.
  }, [brandId, outletKey, roleKey]);

  useEffect(() => {
    load();
  }, [load]);

  async function run(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
      await load();
    } catch (e) {
      setError(e?.code === "permission-denied" ? `permission-denied: ${e.message}` : e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!brandId || !brand) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#faf9f7", padding: 24 }}>
        <div style={{ ...card, maxWidth: 460, textAlign: "center" }}>
          <div style={{ fontSize: 30, marginBottom: 12 }}>🏢</div>
          <h1 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 8px" }}>No brand linked</h1>
          <p style={{ color: "#6b6b7b", fontSize: 14, lineHeight: 1.6, marginBottom: 18 }}>
            This account was created before brands existed. Run the one-time upgrade to
            add one — nothing about your menu, tables, or QR codes changes.
          </p>
          <button style={btnPrimary} onClick={() => router.push("/setup/migrate")}>Run the upgrade</button>
        </div>
      </div>
    );
  }

  const limits = tierLimits(brand.tier);
  const atCeiling = !canAddOutlet(brand.tier, (brand.outletIds || []).length);
  const sub = brand.subscription || {};

  const TABS = [
    { key: "overview", label: "Overview" },
    { key: "outlets", label: `Outlets (${outlets.length})` },
    ...(can(access, "editMasterMenu") ? [{ key: "menu", label: "Master menu" }] : []),
    { key: "team", label: "Team" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#faf9f7" }}>
      <header style={{ background: "#fff", borderBottom: "1px solid #e6e1d6", padding: "16px 24px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: "#1a1a2e" }}>{brand.name}</div>
            <div style={{ fontSize: 12, color: "#888" }}>
              {TIER_LABELS[brand.tier] || brand.tier} · {ROLE_LABELS[access.role]}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button style={btn} onClick={() => router.push("/receptionist")}>Open POS →</button>
          <button style={btn} onClick={logout}>Sign out</button>
        </div>
      </header>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px" }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ ...btn, background: tab === t.key ? "#1a1a2e" : "#fff", color: tab === t.key ? "#fff" : "#1a1a2e", border: tab === t.key ? "1px solid #1a1a2e" : "1px solid #e6e1d6" }}>
              {t.label}
            </button>
          ))}
        </div>

        {error && (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", padding: 14, borderRadius: 10, marginBottom: 16, fontSize: 13.5 }}>{error}</div>
        )}

        {/* ------------------------------------------------------ overview */}
        {tab === "overview" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 20 }}>
              <Stat k="Sales today" v={money(today?.totals.sales)} sub={`across ${outlets.length} outlet${outlets.length === 1 ? "" : "s"}`} />
              <Stat k="Orders today" v={today?.totals.orderCount ?? "—"} />
              <Stat k="Avg order value" v={money(today?.totals.avgOrderValue)} />
              <Stat k="Awaiting confirm" v={today?.totals.pending ?? "—"} sub={today?.totals.pending ? "needs attention" : "all clear"} />
            </div>

            <div style={card}>
              <h2 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 4px" }}>Outlets today</h2>
              <p style={{ fontSize: 12.5, color: "#888", margin: "0 0 14px" }}>
                Live figures for today. Longer ranges need the daily rollups — summing months of
                orders across every outlet in a browser is the thing that makes dashboards slow.
              </p>
              {outlets.length === 0 ? (
                <p style={{ color: "#888", fontSize: 14 }}>No outlets yet.</p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: "#888", fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4 }}>
                        <th style={{ padding: "0 10px 8px" }}>Outlet</th>
                        <th style={{ padding: "0 10px 8px", textAlign: "right" }}>Sales</th>
                        <th style={{ padding: "0 10px 8px", textAlign: "right" }}>Orders</th>
                        <th style={{ padding: "0 10px 8px", textAlign: "right" }}>Items</th>
                        <th style={{ padding: "0 10px 8px", textAlign: "right" }}>Pending</th>
                        <th style={{ padding: "0 10px 8px" }} />
                      </tr>
                    </thead>
                    <tbody>
                      {outlets.map((o) => {
                        const s = today?.perOutlet.find((p) => p.outletId === o.id);
                        return (
                          <tr key={o.id} style={{ borderTop: "1px solid #f0ebe3" }}>
                            <td style={{ padding: "12px 10px", fontWeight: 600 }}>
                              {o.name}
                              {o.id === outletId && <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 800, color: "#166534", background: "#dcfce7", padding: "2px 7px", borderRadius: 5 }}>ACTIVE</span>}
                            </td>
                            <td style={{ padding: "12px 10px", textAlign: "right", fontWeight: 700 }}>{money(s?.sales)}</td>
                            <td style={{ padding: "12px 10px", textAlign: "right" }}>{s?.orderCount ?? 0}</td>
                            <td style={{ padding: "12px 10px", textAlign: "right" }}>{s?.itemsSold ?? 0}</td>
                            <td style={{ padding: "12px 10px", textAlign: "right", color: s?.pending ? "#b45309" : "#888", fontWeight: s?.pending ? 700 : 400 }}>{s?.pending ?? 0}</td>
                            <td style={{ padding: "12px 10px", textAlign: "right" }}>
                              <button style={{ ...btn, padding: "6px 12px", fontSize: 12.5 }}
                                onClick={() => { setActiveOutlet(o.id); router.push("/receptionist"); }}>
                                Open
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {can(access, "manageBilling") && (
              <div style={card}>
                <h2 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 12px" }}>Subscription</h2>
                <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: "8px 16px", fontSize: 14 }}>
                  <span style={{ color: "#888" }}>Plan</span><span>{sub.plan || "—"} · {TIER_LABELS[brand.tier]}</span>
                  <span style={{ color: "#888" }}>Status</span><span style={{ textTransform: "capitalize" }}>{(sub.status || "—").replace("_", " ")}</span>
                  <span style={{ color: "#888" }}>Renews</span><span>{sub.planEndDate ? new Date(sub.planEndDate).toLocaleDateString() : "no expiry set"}</span>
                  <span style={{ color: "#888" }}>Outlets</span><span>{(brand.outletIds || []).length} of {limits.maxOutlets === Infinity ? "unlimited" : limits.maxOutlets}</span>
                </div>
              </div>
            )}
          </>
        )}

        {/* ------------------------------------------------------- outlets */}
        {tab === "outlets" && (
          <>
            {can(access, "createOutlet") && (
              <div style={card}>
                <h2 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 12px" }}>Add an outlet</h2>
                {atCeiling ? (
                  <div style={{ background: "#fef3c7", border: "1px solid #fde68a", color: "#92400e", padding: 14, borderRadius: 10, fontSize: 13.5 }}>
                    Your {TIER_LABELS[brand.tier]} plan allows {limits.maxOutlets} outlet{limits.maxOutlets === 1 ? "" : "s"}.
                    Contact us to move up a tier.
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, alignItems: "end" }}>
                    <div>
                      <label style={label}>Outlet name</label>
                      <input style={input} value={newOutlet.name} placeholder="Andheri West"
                        onChange={(e) => setNewOutlet((p) => ({ ...p, name: e.target.value }))} />
                    </div>
                    <div>
                      <label style={label}>Address</label>
                      <input style={input} value={newOutlet.address}
                        onChange={(e) => setNewOutlet((p) => ({ ...p, address: e.target.value }))} />
                    </div>
                    <button style={btnPrimary} disabled={busy}
                      onClick={() => run(async () => {
                        await createOutlet({ brand: { ...brand, id: brandId }, ...newOutlet });
                        setNewOutlet({ name: "", address: "" });
                      })}>
                      {busy ? "Adding…" : "Add outlet"}
                    </button>
                  </div>
                )}
              </div>
            )}

            <div style={card}>
              <h2 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 14px" }}>Your outlets</h2>
              {outlets.map((o) => (
                <div key={o.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderTop: "1px solid #f0ebe3", flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontWeight: 700 }}>{o.name}</div>
                    <div style={{ fontSize: 11.5, color: "#aaa", fontFamily: "monospace" }}>{o.id}</div>
                  </div>
                  <button style={{ ...btn, padding: "7px 12px", fontSize: 12.5 }}
                    onClick={() => {
                      const name = window.prompt("Rename outlet:", o.name);
                      if (name && name !== o.name) run(() => renameOutlet(o.id, name));
                    }}>
                    Rename
                  </button>
                  <button style={{ ...btn, padding: "7px 12px", fontSize: 12.5 }}
                    onClick={() => { setActiveOutlet(o.id); router.push("/receptionist"); }}>
                    Open POS
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {/* --------------------------------------------------- master menu */}
        {tab === "menu" && can(access, "editMasterMenu") && (
          <>
            <div style={card}>
              <h2 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 4px" }}>Master menu</h2>
              <p style={{ fontSize: 12.5, color: "#888", margin: "0 0 16px", lineHeight: 1.6 }}>
                A template your outlets can pull from. Each outlet still owns its own menu and can
                price, hide, and customise items freely — reception has a <strong>Seed from master
                menu</strong> button that copies anything it does not already have.
                <br />
                Editing an item here does <strong>not</strong> change outlets that already seeded it.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr auto", gap: 10, alignItems: "end" }}>
                <div>
                  <label style={label}>Item name</label>
                  <input style={input} value={newItem.name} placeholder="Paneer Tikka"
                    onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))} />
                </div>
                <div>
                  <label style={label}>Price</label>
                  <input style={input} type="number" value={newItem.price}
                    onChange={(e) => setNewItem((p) => ({ ...p, price: e.target.value }))} />
                </div>
                <div>
                  <label style={label}>Category</label>
                  <input style={input} value={newItem.category}
                    onChange={(e) => setNewItem((p) => ({ ...p, category: e.target.value }))} />
                </div>
                <button style={btnPrimary} disabled={busy}
                  onClick={() => run(async () => {
                    await addMasterItem(brandId, newItem);
                    setNewItem({ name: "", price: "", category: newItem.category, foodType: "veg", description: "" });
                  })}>
                  Add
                </button>
              </div>
            </div>

            <div style={card}>
              <h3 style={{ fontSize: 14.5, fontWeight: 800, margin: "0 0 12px" }}>{master.length} item{master.length === 1 ? "" : "s"}</h3>
              {master.length === 0 ? (
                <p style={{ color: "#888", fontSize: 14 }}>Nothing here yet. Items you add become available to every outlet.</p>
              ) : master.map((m) => (
                <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid #f0ebe3" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{m.name}</div>
                    <div style={{ fontSize: 12, color: "#888" }}>{m.category} · {money(m.price)}</div>
                  </div>
                  <button style={{ ...btn, padding: "6px 11px", fontSize: 12.5, color: "#dc2626", borderColor: "#fecaca" }}
                    onClick={() => { if (confirm(`Remove ${m.name} from the master menu?`)) run(() => deleteMasterItem(brandId, m.id)); }}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ---------------------------------------------------------- team */}
        {tab === "team" && (
          <div style={card}>
            <h2 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 4px" }}>Team</h2>
            <p style={{ fontSize: 12.5, color: "#888", margin: "0 0 16px" }}>
              Staff are invited from each outlet&rsquo;s POS, where you pick the role and which
              outlets the person can work at.
            </p>
            {invites.length === 0 ? (
              <p style={{ color: "#888", fontSize: 14 }}>No outstanding invitations.</p>
            ) : (
              <>
                <div style={label}>Invited, not yet signed in</div>
                {invites.map((i) => (
                  <div key={i.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 10, marginBottom: 8 }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{i.email}</div>
                      <div style={{ fontSize: 11.5, color: "#9a6a34" }}>
                        {ROLE_LABELS[i.role] || i.role} · {(i.outletIds || []).length} outlet{(i.outletIds || []).length === 1 ? "" : "s"}
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}
            <button style={{ ...btnPrimary, marginTop: 14 }} onClick={() => router.push("/receptionist")}>
              Manage staff in the POS →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function BrandConsole() {
  return (
    <AuthGuard allowedRoles={["reception"]}>
      <BrandConsoleInner />
    </AuthGuard>
  );
}
