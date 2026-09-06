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
  fetchMasterMenu, addMasterItem, updateMasterItem, deleteMasterItem,
  listBrandMembers, listOutletStaff, removeBrandMember, removeOutletStaff,
  importMasterItems, updateMyProfile, updateBrandIdentity,
} from "@/lib/brand";
import {
  parseMenuText, MENU_CSV_TEMPLATE, extractZipEntries, matchImageFile, uploadWithConcurrency,
} from "@/lib/menu-import";
import { uploadToCloudinary } from "@/lib/firebase";
import JSZip from "jszip";
import VariationsAddonsEditor, { cleanRows } from "@/components/VariationsAddonsEditor";
import {
  can, canAccessOutlet, canInvite, ROLE_LABELS, TIER_LABELS, ROLES,
  tierLimits, canAddOutlet,
} from "@/lib/tenancy";
import { listInvites, createInvite, revokeInvite, INVITABLE_ROLES } from "@/lib/invites";

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
  const { access, brand, brandId, outletId, user, setActiveOutlet, logout, refresh } = useAuth();
  const router = useRouter();

  const [tab, setTab] = useState("overview");
  const [outlets, setOutlets] = useState([]);
  const [today, setToday] = useState(null);
  const [master, setMaster] = useState([]);
  const [invites, setInvites] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [members, setMembers] = useState([]);
  const [staff, setStaff] = useState([]);
  const [newOutlet, setNewOutlet] = useState({ name: "", address: "" });
  const [inviteForm, setInviteForm] = useState({ email: "", role: "", outletIds: [] });
  const [inviteError, setInviteError] = useState("");
  const [importText, setImportText] = useState("");
  const [importFormat, setImportFormat] = useState("csv");
  const [importPreview, setImportPreview] = useState(null);
  // ZIP (CSV + photos) — the outlet POS importer already had this; the master
  // menu didn't, which meant a brand-wide catalog with photos had no way in
  // except CSV/JSON rows carrying already-hosted image links.
  const [zipFile, setZipFile] = useState(null);
  const [zipImages, setZipImages] = useState({});
  const [zipParsing, setZipParsing] = useState(false);
  const [zipUploadProgress, setZipUploadProgress] = useState(null);
  const [myProfile, setMyProfile] = useState({ name: "", phone: "" });
  const [identity, setIdentity] = useState({ name: "", logoUrl: "", accentColor: "#e8a33d" });
  const [savedNote, setSavedNote] = useState("");
  const [newItem, setNewItem] = useState({
    name: "", price: "", category: "Mains", foodType: "veg", description: "", etaMinutes: "",
    chefSpecial: false, featured: false, bogoEnabled: false, variations: [], addons: [],
  });
  // Master-menu item edit — the list below only ever supported Add/Remove;
  // an item's sizes/add-ons/chef-special/featured could be set on the way
  // in (bulk import) but never seen or changed again afterward.
  const [editingMasterId, setEditingMasterId] = useState(null);
  const [editMasterForm, setEditMasterForm] = useState(null);

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

    const [o, t, m, inv, mem, st] = await Promise.all([
      attempt("outlets", () => fetchOutlets(ids), []),
      attempt("today's figures", () => fetchBrandToday(ids), null),
      can(access, "editMasterMenu")
        ? attempt("master menu", () => fetchMasterMenu(brandId), [])
        : Promise.resolve([]),
      attempt("invitations", () => listInvites(brandId), []),
      attempt("managers", () => listBrandMembers(brandId), []),
      Promise.all(ids.map((id) => listOutletStaff(id))).then((r) => r.flat()),
    ]);

    setOutlets(o);
    setToday(t);
    setMaster(m);
    setInvites(inv);
    setMembers(mem);
    setStaff(st);

    const me = mem.find((x) => x.uid === user?.uid);
    if (me) setMyProfile({ name: me.name || "", phone: me.phone || "" });
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

  // === Master-menu item edit ===
  // Previously the only two operations here were Add and Remove — an item's
  // sizes, add-ons, chef-special or featured flag could be set going in (a
  // bulk import writes them fine) but never seen or changed again once it
  // landed, since the list below never rendered them and there was no edit
  // form to open.
  function startEditMaster(item) {
    setEditingMasterId(item.id);
    setEditMasterForm({
      name: item.name || "", price: item.price || "", category: item.category || "Mains",
      foodType: item.foodType || "veg", description: item.description || "",
      etaMinutes: item.etaMinutes || "", chefSpecial: !!item.chefSpecial, featured: !!item.featured,
      bogoEnabled: !!item.bogoEnabled, variations: item.variations || [], addons: item.addons || [],
    });
  }
  function cancelEditMaster() {
    setEditingMasterId(null);
    setEditMasterForm(null);
  }
  async function saveEditMaster() {
    if (!editMasterForm.name.trim() || !editMasterForm.price) return;
    await run(async () => {
      await updateMasterItem(brandId, editingMasterId, {
        name: editMasterForm.name.trim(),
        price: parseFloat(editMasterForm.price) || 0,
        category: editMasterForm.category.trim() || "Mains",
        foodType: editMasterForm.foodType || "veg",
        description: editMasterForm.description || "",
        etaMinutes: parseInt(editMasterForm.etaMinutes) || 15,
        chefSpecial: !!editMasterForm.chefSpecial,
        featured: !!editMasterForm.featured,
        bogoEnabled: !!editMasterForm.bogoEnabled,
        variations: cleanRows(editMasterForm.variations),
        addons: cleanRows(editMasterForm.addons),
      });
      setEditingMasterId(null);
      setEditMasterForm(null);
    });
  }

  // === ZIP (CSV + photos) master-menu import ===
  // Mirrors the outlet POS importer's zip flow — see app/receptionist/page.js
  // and lib/menu-import.js's extractZipEntries/uploadWithConcurrency, shared
  // by both rather than duplicated a second time.
  async function handleZipFileSelected(file) {
    if (!file) return;
    setZipFile(file);
    setZipParsing(true);
    setImportPreview(null);
    try {
      const { csvText, imagesMap } = await extractZipEntries(file);
      setZipImages(imagesMap);
      const result = parseMenuText(csvText, "csv");
      if (result.error) { setImportPreview(result); return; }
      const itemsWithImageStatus = result.items.map((item) => {
        const zipEntry = item.imageFile ? matchImageFile(item.imageFile, imagesMap) : null;
        return { ...item, imageMatchStatus: zipEntry ? "matched" : item.imageFile ? "missing" : "none", _zipEntry: zipEntry };
      });
      setImportPreview({ ...result, items: itemsWithImageStatus, isZip: true });
    } catch (err) {
      setImportPreview({ items: [], skipped: [], error: err.message });
    } finally {
      setZipParsing(false);
    }
  }

  async function downloadZipTemplate() {
    const zip = new JSZip();
    zip.file("menu.csv",
`Name,Price,Category,Description,FoodType,ChefSpecial,Featured,ImageFile,Variations,Addons,ETA,BOGO
Paneer Tikka,320,Starters,Cottage cheese marinated in spices,veg,no,no,paneer-tikka.jpg,,,15,no
Margherita Pizza,320,Mains,Classic tomato and mozzarella,veg,no,yes,pizza.jpg,"Small:220|Medium:320|Large:420","Extra Cheese:40|Extra Olives:30",20,no
Garlic Naan,80,Breads & Rice,Soft naan brushed with garlic butter,veg,no,no,,,,10,yes
`);
    zip.file("images/README.txt", "Put your photos in this folder.\nName each file to exactly match the ImageFile column in menu.csv (e.g. paneer-tikka.jpg).\nSupported formats: jpg, jpeg, png, webp, gif.\nThese photos are uploaded to Cloudinary automatically during import — you don't need to upload them anywhere yourself.");
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "master-menu-import-template.zip";
    a.click();
    URL.revokeObjectURL(url);
  }

  // Uploads every matched photo to Cloudinary first, then writes the master
  // menu items with real hosted URLs — same order of operations as the
  // outlet importer, so a failed upload never leaves a half-written item.
  async function importZipItems() {
    const toUpload = importPreview.items.filter((it) => it.imageMatchStatus === "matched" && it._zipEntry);
    setZipUploadProgress({ done: 0, total: toUpload.length });
    const results = await uploadWithConcurrency(
      toUpload.map((it) => async () => {
        const blob = await it._zipEntry.async("blob");
        const file = new File([blob], it.imageFile || it.name, { type: blob.type || "image/jpeg" });
        try { return await uploadToCloudinary(file); }
        catch { return await uploadToCloudinary(file); } // one retry
      }),
      5,
      (done, total) => setZipUploadProgress({ done, total }),
    );
    toUpload.forEach((it, i) => { if (typeof results[i] === "string") it.imageUrl = results[i]; });

    const cleanItems = importPreview.items.map(({ imageFile, imageMatchStatus, _zipEntry, ...rest }) => rest);
    const res = await importMasterItems(brandId, cleanItems, master);
    setZipUploadProgress(null);
    return res;
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

  const isOwner = access.role === ROLES.BRAND_OWNER;
  // Roles this person may actually grant, over the outlets they hold. An owner
  // gets managers plus floor staff; a manager gets floor staff only. Filtering
  // here means the picker can never offer a grant the rules would reject.
  const grantableRoles = INVITABLE_ROLES.filter((r) => canInvite(access, r.role, visibleOutletIds));

  // Somebody who has already joined is not "invited, not yet signed in", even
  // if their invitation document still says active. Accepting marks the invite
  // consumed, but that write is deliberately non-fatal, so this cross-check
  // against the actual roster is what keeps the list honest either way.
  const joinedEmails = new Set(
    [...members, ...staff].map((m) => (m.email || "").trim().toLowerCase()).filter(Boolean)
  );
  const outstandingInvites = invites.filter((i) => !joinedEmails.has((i.email || "").toLowerCase()));

  const limits = tierLimits(brand.tier);
  const atCeiling = !canAddOutlet(brand.tier, (brand.outletIds || []).length);
  const sub = brand.subscription || {};

  const TABS = [
    { key: "overview", label: "Overview" },
    { key: "outlets", label: `Outlets (${outlets.length})` },
    ...(can(access, "editMasterMenu") ? [{ key: "menu", label: "Master menu" }] : []),
    { key: "team", label: "Team" },
    { key: "settings", label: isOwner ? "Brand & profile" : "My profile" },
  ];

  const accent = brand.accentColor || "#e8a33d";

  return (
    <div style={{ minHeight: "100vh", background: "#faf9f7" }}>
      <header style={{ background: "#fff", borderBottom: "1px solid #e6e1d6", padding: "16px 24px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {brand.logoUrl ? (
              <img src={brand.logoUrl} alt="" style={{ width: 40, height: 40, borderRadius: 10, objectFit: "cover", border: `2px solid ${accent}` }} />
            ) : (
              <div style={{ width: 40, height: 40, borderRadius: 10, background: accent, display: "grid", placeItems: "center", color: "#fff", fontWeight: 800, fontSize: 17 }}>
                {(brand.name || "?").charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <div style={{ fontSize: 17, fontWeight: 800, color: "#1a1a2e" }}>{brand.name}</div>
              <div style={{ fontSize: 12, color: "#888" }}>
                {TIER_LABELS[brand.tier] || brand.tier} · {ROLE_LABELS[access.role]}
              </div>
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
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 10 }}>
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
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 10 }}>
                <div>
                  <label style={label}>Description</label>
                  <input style={input} value={newItem.description} placeholder="Optional"
                    onChange={(e) => setNewItem((p) => ({ ...p, description: e.target.value }))} />
                </div>
                <div>
                  <label style={label}>Food type</label>
                  <select style={input} value={newItem.foodType}
                    onChange={(e) => setNewItem((p) => ({ ...p, foodType: e.target.value }))}>
                    <option value="veg">Veg</option>
                    <option value="nonveg">Non-veg</option>
                  </select>
                </div>
                <div>
                  <label style={label}>Prep time (min)</label>
                  <input style={input} type="number" placeholder="15" value={newItem.etaMinutes}
                    onChange={(e) => setNewItem((p) => ({ ...p, etaMinutes: e.target.value }))} />
                </div>
              </div>

              <div style={{ display: "flex", gap: 18, marginBottom: 14, flexWrap: "wrap" }}>
                {[["chefSpecial", "👨‍🍳 Chef's Special"], ["featured", "⭐ Featured"], ["bogoEnabled", "🎁 Buy 1 Get 1 Free"]].map(([key, lbl]) => (
                  <label key={key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                    <input type="checkbox" checked={!!newItem[key]} onChange={(e) => setNewItem((p) => ({ ...p, [key]: e.target.checked }))} />
                    {lbl}
                  </label>
                ))}
              </div>

              <VariationsAddonsEditor form={newItem} setForm={setNewItem} inputStyle={input} labelStyle={label} />

              <button style={btnPrimary} disabled={busy || !newItem.name.trim() || !newItem.price}
                onClick={() => run(async () => {
                  await addMasterItem(brandId, { ...newItem, variations: cleanRows(newItem.variations), addons: cleanRows(newItem.addons) });
                  setNewItem({
                    name: "", price: "", category: newItem.category, foodType: "veg", description: "", etaMinutes: "",
                    chefSpecial: false, featured: false, bogoEnabled: false, variations: [], addons: [],
                  });
                })}>
                Add item
              </button>
            </div>

            <div style={card}>
              <h3 style={{ fontSize: 14.5, fontWeight: 800, margin: "0 0 4px" }}>Bulk import</h3>
              <p style={{ fontSize: 12.5, color: "#888", margin: "0 0 14px", lineHeight: 1.6 }}>
                Paste a CSV or JSON menu, upload a file, or a ZIP with photos included. Rows without a
                name or a usable price are skipped rather than imported broken, and names already on
                the master menu are left alone so you can re-import a corrected file safely. A dish
                with sizes or add-ons stays <strong>one row</strong> — see the Variations/Addons columns
                in the template, e.g. <code>Small:220|Medium:320|Large:420</code> — rather than one row
                per size, which would import as separate, unrelated items.
              </p>

              <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                {["csv", "json", "zip"].map((f) => (
                  <button key={f} onClick={() => { setImportFormat(f); setImportPreview(null); setImportText(""); }}
                    style={{ ...btn, padding: "7px 14px", fontSize: 12.5, background: importFormat === f ? "#1a1a2e" : "#fff", color: importFormat === f ? "#fff" : "#1a1a2e", border: importFormat === f ? "1px solid #1a1a2e" : "1px solid #e6e1d6" }}>
                    {f === "zip" ? "ZIP (CSV + Photos)" : f.toUpperCase()}
                  </button>
                ))}
                {importFormat !== "zip" && (
                  <input type="file" accept=".csv,.json,.txt" style={{ fontSize: 12.5 }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      const text = await f.text();
                      setImportText(text);
                      setImportFormat(f.name.toLowerCase().endsWith(".json") ? "json" : "csv");
                      setImportPreview(null);
                    }} />
                )}
                <button style={{ ...btn, padding: "7px 14px", fontSize: 12.5, marginLeft: importFormat === "zip" ? "auto" : 0 }}
                  onClick={importFormat === "zip" ? downloadZipTemplate : () => {
                    const blob = new Blob([MENU_CSV_TEMPLATE], { type: "text/csv" });
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = "master-menu-template.csv";
                    a.click();
                  }}>
                  ↓ Download {importFormat === "zip" ? "ZIP" : ""} template
                </button>
              </div>

              {importFormat === "zip" ? (
                <div style={{ marginBottom: 10 }}>
                  <input type="file" accept=".zip" style={{ fontSize: 13 }}
                    onChange={(e) => handleZipFileSelected(e.target.files?.[0])} />
                  {zipParsing && <p style={{ fontSize: 13, color: "#888", marginTop: 8 }}>Reading zip file…</p>}
                  {zipFile && !zipParsing && !importPreview?.error && <p style={{ fontSize: 12.5, color: "#16a34a", fontWeight: 600, marginTop: 8 }}>Loaded {zipFile.name}</p>}
                  <p style={{ fontSize: 12, color: "#999", marginTop: 8, lineHeight: 1.6 }}>
                    One menu.csv (with an ImageFile column, e.g. paneer-tikka.jpg) plus an images/
                    folder of matching photos. Photos are uploaded to Cloudinary automatically.
                  </p>
                </div>
              ) : (
                <textarea value={importText} onChange={(e) => { setImportText(e.target.value); setImportPreview(null); }}
                  rows={6} placeholder={importFormat === "csv" ? "Name,Price,Category,Description,FoodType,Variations,Addons" : '[{ "name": "Paneer Tikka", "price": 280 }]'}
                  style={{ ...input, fontFamily: "monospace", fontSize: 12.5, resize: "vertical" }} />
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                {importFormat !== "zip" && (
                  <button style={btn} disabled={!importText.trim()}
                    onClick={() => setImportPreview(parseMenuText(importText, importFormat))}>
                    Preview
                  </button>
                )}
                {importPreview?.items?.length > 0 && (
                  <button style={btnPrimary} disabled={busy || zipParsing}
                    onClick={() => run(async () => {
                      const res = importFormat === "zip"
                        ? await importZipItems()
                        : await importMasterItems(brandId, importPreview.items, master);
                      setImportPreview(null);
                      setImportText("");
                      setZipFile(null);
                      setZipImages({});
                      setSavedNote(res.added === 0
                        ? `Nothing added — all ${res.duplicates} were already on the master menu.`
                        : `Added ${res.added} item${res.added === 1 ? "" : "s"}${res.duplicates ? `, skipped ${res.duplicates} already present` : ""}.`);
                    })}>
                    Import {importPreview.items.length} item{importPreview.items.length === 1 ? "" : "s"}
                  </button>
                )}
              </div>

              {zipUploadProgress && (
                <p style={{ fontSize: 12.5, color: "#888", marginTop: 10 }}>
                  Uploading photos… {zipUploadProgress.done}/{zipUploadProgress.total}
                </p>
              )}

              {importPreview && (
                <div style={{ marginTop: 12, padding: 12, borderRadius: 10, fontSize: 13,
                  background: importPreview.error ? "#fef2f2" : "#f0fdf4",
                  border: `1px solid ${importPreview.error ? "#fecaca" : "#bbf7d0"}`,
                  color: importPreview.error ? "#b91c1c" : "#166534" }}>
                  {importPreview.error || `Ready to import ${importPreview.items.length} item${importPreview.items.length === 1 ? "" : "s"}.`}
                  {importPreview.isZip && !importPreview.error && (
                    <div style={{ marginTop: 4, fontSize: 12 }}>
                      {importPreview.items.filter((it) => it.imageMatchStatus === "matched").length} photo{importPreview.items.filter((it) => it.imageMatchStatus === "matched").length === 1 ? "" : "s"} matched.
                      {importPreview.items.some((it) => it.imageMatchStatus === "missing") &&
                        ` ${importPreview.items.filter((it) => it.imageMatchStatus === "missing").length} listed an ImageFile not found in the zip.`}
                    </div>
                  )}
                  {importPreview.skipped?.length > 0 && (
                    <div style={{ marginTop: 6, fontSize: 12 }}>
                      Skipping {importPreview.skipped.length} row{importPreview.skipped.length === 1 ? "" : "s"}:{" "}
                      {importPreview.skipped.slice(0, 4).map((sk) => `line ${sk.line} (${sk.reason})`).join(", ")}
                      {importPreview.skipped.length > 4 ? "…" : ""}
                    </div>
                  )}
                </div>
              )}

              {savedNote && (
                <div style={{ marginTop: 12, padding: 12, borderRadius: 10, fontSize: 13, background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534" }}>
                  {savedNote}
                </div>
              )}
            </div>

            <div style={card}>
              <h3 style={{ fontSize: 14.5, fontWeight: 800, margin: "0 0 12px" }}>{master.length} item{master.length === 1 ? "" : "s"}</h3>
              {master.length === 0 ? (
                <p style={{ color: "#888", fontSize: 14 }}>Nothing here yet. Items you add become available to every outlet.</p>
              ) : master.map((m) => editingMasterId === m.id ? (
                <div key={m.id} style={{ padding: "14px 0", borderTop: "1px solid #f0ebe3" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 10 }}>
                    <div>
                      <label style={label}>Item name</label>
                      <input style={input} value={editMasterForm.name} onChange={(e) => setEditMasterForm((p) => ({ ...p, name: e.target.value }))} />
                    </div>
                    <div>
                      <label style={label}>Price</label>
                      <input style={input} type="number" value={editMasterForm.price} onChange={(e) => setEditMasterForm((p) => ({ ...p, price: e.target.value }))} />
                    </div>
                    <div>
                      <label style={label}>Category</label>
                      <input style={input} value={editMasterForm.category} onChange={(e) => setEditMasterForm((p) => ({ ...p, category: e.target.value }))} />
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 10 }}>
                    <div>
                      <label style={label}>Description</label>
                      <input style={input} value={editMasterForm.description} onChange={(e) => setEditMasterForm((p) => ({ ...p, description: e.target.value }))} />
                    </div>
                    <div>
                      <label style={label}>Food type</label>
                      <select style={input} value={editMasterForm.foodType} onChange={(e) => setEditMasterForm((p) => ({ ...p, foodType: e.target.value }))}>
                        <option value="veg">Veg</option>
                        <option value="nonveg">Non-veg</option>
                      </select>
                    </div>
                    <div>
                      <label style={label}>Prep time (min)</label>
                      <input style={input} type="number" value={editMasterForm.etaMinutes} onChange={(e) => setEditMasterForm((p) => ({ ...p, etaMinutes: e.target.value }))} />
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 18, marginBottom: 14, flexWrap: "wrap" }}>
                    {[["chefSpecial", "👨‍🍳 Chef's Special"], ["featured", "⭐ Featured"], ["bogoEnabled", "🎁 Buy 1 Get 1 Free"]].map(([key, lbl]) => (
                      <label key={key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                        <input type="checkbox" checked={!!editMasterForm[key]} onChange={(e) => setEditMasterForm((p) => ({ ...p, [key]: e.target.checked }))} />
                        {lbl}
                      </label>
                    ))}
                  </div>
                  <VariationsAddonsEditor form={editMasterForm} setForm={setEditMasterForm} inputStyle={input} labelStyle={label} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button style={btnPrimary} disabled={busy || !editMasterForm.name.trim() || !editMasterForm.price} onClick={saveEditMaster}>Save</button>
                    <button style={btn} onClick={cancelEditMaster}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid #f0ebe3" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 600 }}>{m.name}</span>
                      {m.chefSpecial && <span style={{ background: "#7c2d12", color: "#fff", fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 100 }}>👨‍🍳 CHEF&apos;S</span>}
                      {m.featured && <span style={{ background: "#a16207", color: "#fff", fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 100 }}>⭐ FEATURED</span>}
                      {m.bogoEnabled && <span style={{ background: "#166534", color: "#fff", fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 100 }}>🎁 BOGO</span>}
                      {m.variations?.length > 0 && <span style={{ background: "#0369a1", color: "#fff", fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 100 }}>{m.variations.length} SIZES</span>}
                      {m.addons?.length > 0 && <span style={{ background: "#4338ca", color: "#fff", fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 100 }}>+{m.addons.length} ADD-ONS</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
                      {m.category} · {m.variations?.length > 0 ? `From ${money(Math.min(...m.variations.map((v) => v.price)))}` : money(m.price)}
                    </div>
                  </div>
                  <button style={{ ...btn, padding: "6px 11px", fontSize: 12.5 }} onClick={() => startEditMaster(m)}>
                    Edit
                  </button>
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
          <>
            <div style={card}>
              <h2 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 4px" }}>
                {isOwner ? "Invite a manager or staff member" : "Invite floor staff"}
              </h2>
              <p style={{ fontSize: 12.5, color: "#888", margin: "0 0 16px", lineHeight: 1.6 }}>
                {isOwner
                  ? "Managers run the outlets you assign them and invite their own reception and kitchen staff. Any outlet without a manager stays yours to run."
                  : "You can invite reception and kitchen staff for the outlets you manage. Only your brand owner can add managers."}
              </p>

              {inviteError && (
                <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", padding: 12, borderRadius: 10, marginBottom: 14, fontSize: 13 }}>{inviteError}</div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 200px auto", gap: 10, alignItems: "end", marginBottom: 14 }}>
                <div>
                  <label style={label}>Email</label>
                  <input style={input} type="email" placeholder="person@example.com" value={inviteForm.email}
                    onChange={(e) => setInviteForm((p) => ({ ...p, email: e.target.value }))} />
                </div>
                <div>
                  <label style={label}>Role</label>
                  <select style={input} value={inviteForm.role}
                    onChange={(e) => setInviteForm((p) => ({ ...p, role: e.target.value }))}>
                    {grantableRoles.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
                  </select>
                </div>
                <button style={btnPrimary} disabled={busy || grantableRoles.length === 0}
                  onClick={() => run(async () => {
                    setInviteError("");
                    const email = inviteForm.email.trim().toLowerCase();
                    const chosen = inviteForm.outletIds.length > 0 ? inviteForm.outletIds : visibleOutletIds;
                    const role = inviteForm.role || grantableRoles[0]?.role;
                    if (!email) { setInviteError("Email is required"); return; }
                    if (joinedEmails.has(email)) { setInviteError("That person is already on your team."); return; }
                    if (outstandingInvites.some((i) => i.email === email)) { setInviteError("That email already has an invitation waiting."); return; }
                    if (!canInvite(access, role, chosen)) { setInviteError("You cannot grant that role for those outlets."); return; }
                    await createInvite({ email, role, brandId, outletIds: chosen, invitedByUid: user.uid });
                    setInviteForm({ email: "", role: "", outletIds: [] });
                  })}>
                  {busy ? "Sending..." : "Send invite"}
                </button>
              </div>

              <label style={label}>Outlets this person can work at</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {outlets.map((o) => {
                  const on = inviteForm.outletIds.length === 0 || inviteForm.outletIds.includes(o.id);
                  return (
                    <button key={o.id}
                      onClick={() => setInviteForm((p) => {
                        const base = p.outletIds.length === 0 ? visibleOutletIds : p.outletIds;
                        const next = base.includes(o.id) ? base.filter((x) => x !== o.id) : [...base, o.id];
                        return { ...p, outletIds: next };
                      })}
                      style={{
                        padding: "7px 13px", borderRadius: 999, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
                        border: on ? "1.5px solid #1a1a2e" : "1.5px solid #e6e1d6",
                        background: on ? "#1a1a2e" : "transparent", color: on ? "#fff" : "#1a1a2e", fontFamily: "inherit",
                      }}>
                      {o.name}
                    </button>
                  );
                })}
              </div>
              <p style={{ fontSize: 11.5, color: "#999", marginTop: 8, marginBottom: 0 }}>
                All selected by default. You can only grant outlets you manage yourself.
              </p>
            </div>

            {isOwner && (
              <div style={card}>
                <h3 style={{ fontSize: 14.5, fontWeight: 800, margin: "0 0 12px" }}>Managers &amp; owners</h3>
                {members.length === 0 ? (
                  <p style={{ color: "#888", fontSize: 14 }}>Nobody yet.</p>
                ) : members.map((m) => {
                  const names = (m.outletIds || []).map((id) => outlets.find((o) => o.id === id)?.name || id.slice(0, 6));
                  const isSelf = m.uid === user.uid;
                  return (
                    <div key={m.uid} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderTop: "1px solid #f0ebe3" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                          {m.name || m.email || m.uid.slice(0, 8)}
                          {isSelf && <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 800, color: "#166534", background: "#dcfce7", padding: "2px 7px", borderRadius: 5 }}>YOU</span>}
                        </div>
                        <div style={{ fontSize: 11.5, color: "#888" }}>
                          {ROLE_LABELS[m.role] || m.role}
                          {m.role === ROLES.BRAND_OWNER ? " · all outlets" : names.length ? ` · ${names.join(", ")}` : " · no outlets assigned"}
                        </div>
                      </div>
                      {m.role !== ROLES.BRAND_OWNER && (
                        <button style={{ ...btn, padding: "6px 11px", fontSize: 12.5, color: "#dc2626", borderColor: "#fecaca" }}
                          onClick={() => { if (confirm(`Remove ${m.email || "this manager"}?`)) run(() => removeBrandMember(brandId, m.uid)); }}>
                          Remove
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div style={card}>
              <h3 style={{ fontSize: 14.5, fontWeight: 800, margin: "0 0 12px" }}>Floor staff</h3>
              {staff.length === 0 ? (
                <p style={{ color: "#888", fontSize: 14 }}>No reception or kitchen staff yet.</p>
              ) : staff.map((st) => (
                <div key={`${st.outletId}-${st.uid}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderTop: "1px solid #f0ebe3" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{st.name || st.email || st.uid.slice(0, 8)}</div>
                    <div style={{ fontSize: 11.5, color: "#888" }}>
                      {ROLE_LABELS[st.role] || st.role} {"·"} {outlets.find((o) => o.id === st.outletId)?.name || st.outletId.slice(0, 6)}
                    </div>
                  </div>
                  <button style={{ ...btn, padding: "6px 11px", fontSize: 12.5, color: "#dc2626", borderColor: "#fecaca" }}
                    onClick={() => { if (confirm(`Remove ${st.email || "this person"}?`)) run(() => removeOutletStaff(st.outletId, st.uid)); }}>
                    Remove
                  </button>
                </div>
              ))}
            </div>

            <div style={card}>
              <h3 style={{ fontSize: 14.5, fontWeight: 800, margin: "0 0 12px" }}>Invited, not yet signed in</h3>
              {outstandingInvites.length === 0 ? (
                <p style={{ color: "#888", fontSize: 14 }}>No outstanding invitations.</p>
              ) : outstandingInvites.map((i) => (
                <div key={i.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 10, marginBottom: 8 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{i.email}</div>
                    <div style={{ fontSize: 11.5, color: "#9a6a34" }}>
                      {ROLE_LABELS[i.role] || i.role} {"·"} {(i.outletIds || []).map((id) => outlets.find((o) => o.id === id)?.name || id.slice(0, 6)).join(", ") || "no outlets"}
                    </div>
                  </div>
                  <button style={{ ...btn, padding: "6px 11px", fontSize: 12.5, color: "#dc2626", borderColor: "#fecaca" }}
                    onClick={() => run(() => revokeInvite(i.email))}>
                    Cancel
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
        {/* ------------------------------------------------------ settings */}
        {tab === "settings" && (
          <>
            {/* Everyone edits their own name and contact. The rules pin role and
                outlet assignment to their current values, so this can never
                become a route to self-promotion. */}
            <div style={card}>
              <h2 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 4px" }}>Your profile</h2>
              <p style={{ fontSize: 12.5, color: "#888", margin: "0 0 16px" }}>
                How you appear to the rest of the team. Your role and outlets are set by
                whoever invited you.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, alignItems: "end" }}>
                <div>
                  <label style={label}>Name</label>
                  <input style={input} value={myProfile.name}
                    onChange={(e) => setMyProfile((p) => ({ ...p, name: e.target.value }))} />
                </div>
                <div>
                  <label style={label}>Contact number</label>
                  <input style={input} value={myProfile.phone} placeholder="+91…"
                    onChange={(e) => setMyProfile((p) => ({ ...p, phone: e.target.value }))} />
                </div>
                <button style={btnPrimary} disabled={busy}
                  onClick={() => run(async () => {
                    await updateMyProfile({
                      brandId, uid: user.uid, scope: access.scope,
                      outletIds: access.outletIds.length ? access.outletIds : visibleOutletIds,
                      ...myProfile,
                    });
                    setSavedNote("Profile saved.");
                  })}>
                  Save
                </button>
              </div>
              <div style={{ fontSize: 12, color: "#aaa", marginTop: 10 }}>
                {user?.email} · {ROLE_LABELS[access.role]}
              </div>
            </div>

            {isOwner && (
              <div style={card}>
                <h2 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 4px" }}>Your brand</h2>
                <p style={{ fontSize: 12.5, color: "#888", margin: "0 0 16px", lineHeight: 1.6 }}>
                  Your name, logo, and colour appear across this console and on your
                  staff&rsquo;s screens. Each outlet keeps its own logo and address for the
                  diner-facing menu, set from that outlet&rsquo;s POS.
                </p>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 12, marginBottom: 14 }}>
                  <div>
                    <label style={label}>Brand name</label>
                    <input style={input} value={identity.name || brand.name || ""}
                      onChange={(e) => setIdentity((p) => ({ ...p, name: e.target.value }))} />
                  </div>
                  <div>
                    <label style={label}>Accent colour</label>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input type="color" value={identity.accentColor || accent}
                        onChange={(e) => setIdentity((p) => ({ ...p, accentColor: e.target.value }))}
                        style={{ width: 46, height: 40, padding: 2, border: "1px solid #e6e1d6", borderRadius: 10, cursor: "pointer", background: "#fff" }} />
                      <span style={{ fontFamily: "monospace", fontSize: 12.5, color: "#888" }}>
                        {identity.accentColor || accent}
                      </span>
                    </div>
                  </div>
                </div>

                <label style={label}>Logo</label>
                <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 16 }}>
                  {(identity.logoUrl || brand.logoUrl) ? (
                    <img src={identity.logoUrl || brand.logoUrl} alt="" style={{ width: 64, height: 64, borderRadius: 12, objectFit: "cover", border: "1px solid #e6e1d6" }} />
                  ) : (
                    <div style={{ width: 64, height: 64, borderRadius: 12, background: identity.accentColor || accent, display: "grid", placeItems: "center", color: "#fff", fontWeight: 800, fontSize: 26 }}>
                      {(identity.name || brand.name || "?").charAt(0).toUpperCase()}
                    </div>
                  )}
                  <input type="file" accept="image/*" style={{ fontSize: 12.5 }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      if (!f.type.startsWith("image/")) return setSavedNote("That file is not an image.");
                      if (f.size > 5 * 1024 * 1024) return setSavedNote("Logo must be under 5MB.");
                      try {
                        const url = await uploadToCloudinary(f);
                        setIdentity((p) => ({ ...p, logoUrl: url }));
                      } catch (err) {
                        setSavedNote(`Logo upload failed: ${err.message}`);
                      }
                    }} />
                </div>

                <button style={btnPrimary} disabled={busy}
                  onClick={() => run(async () => {
                    await updateBrandIdentity(brandId, {
                      name: identity.name || brand.name,
                      logoUrl: identity.logoUrl ?? brand.logoUrl ?? "",
                      accentColor: identity.accentColor || accent,
                    });
                    setSavedNote("Brand updated.");
                  })}>
                  Save brand
                </button>
              </div>
            )}

            {savedNote && (
              <div style={{ ...card, background: "#f0fdf4", borderColor: "#bbf7d0", color: "#166534", fontSize: 13.5 }}>
                {savedNote}
              </div>
            )}
          </>
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
