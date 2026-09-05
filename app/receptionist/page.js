"use client";


import { useEffect, useState, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import CrmSection from "./sections/CrmSection";
import OnlineOrderingSection from "./sections/OnlineOrderingSection";
import {
  orderTypeMeta, isDelivery, formatDeliveryAddress, orderDestinationLabel,
  nextDeliveryAction, deliveryStage, DELIVERY_STAGES,
  isInFlightDelivery,
} from "@/lib/order-types";
import { activeRiders, riderById } from "@/lib/riders";
import {
  issueTableToken, openTableSession, closeTableSession, openSessionsFor, closeSessionsFor,
} from "@/lib/table-sessions-store";
import { tableUrl, isSessionOpen } from "@/lib/table-session";
import {
  useOrders, useMenuItems, useCategories, useTables, useFloors,
  useOfferBanners, useBundleRules, useWaiterCalls, useCustomers,
  useStaff, useBillCustomers, useOutletInfo, useDeliveryDetails, useTableSessions, useRiders,
  useRiderAssignments, useBillRequestDetails,
} from "@/lib/use-outlet-data";
import { PAYMENT_METHODS } from "@/lib/payment-methods";
import { db } from "@/lib/firebase";
import { uploadToCloudinary } from "@/lib/cloudinary";
import JSZip from "jszip"; // npm install jszip
import { playNotificationSound, requestNotificationPermission, showPopupNotification } from "@/lib/notifications";
import { AuthGuard } from "@/lib/auth-guard";
import { useAuth } from "@/lib/auth-context";
import {
  collection, onSnapshot, query, orderBy, where, doc, updateDoc, deleteDoc, setDoc, addDoc,
  getDoc, serverTimestamp, writeBatch,
} from "firebase/firestore";
import { computeBundleDiscounts, computeBillTotals, authoritativeItems } from "@/lib/pricing";
import { can } from "@/lib/tenancy";
import { fetchMasterMenu, seedOutletFromMaster } from "@/lib/brand";
import {
  parseCSV, parseCSVLine, truthy, cleanPrice, parseImportRows, matchImageFile,
  normalizeFoodType as normalizeFoodTypeShared, extractZipEntries, uploadWithConcurrency,
} from "@/lib/menu-import";
import {
  computeAnalytics as computeAnalyticsPure, buildTodayReport, filterLabel,
} from "@/lib/analytics";
import {
  itemHasOptions, addLine, adjustLineQty, cartLines, cartSubtotal, posLineKey,
  qtyForItem, plainQtyForItem, estimatedEta,
} from "@/lib/pos-cart";
import {
  startCooking as kdsStart, markReady as kdsReady, adjustEta as kdsAdjustEta,
  returnToQueue as kdsReturn, autoStartNext, ETA_PRESETS, DEFAULT_ETA,
  MAX_CONCURRENT_PREPARING,
} from "@/lib/kitchen";
import {
  isToday, filterRangeStart, receptionOrderWindowStart,
  withItemIds, mergeItemLines, revenueOrders, soldQtyByItem, collapseBillSiblings,
} from "@/lib/orders";

const DEFAULT_CATEGORIES = ["Starters", "Mains", "Breads & Rice", "Continental", "Beverages", "Desserts"];
const COMBO_CATEGORY = "Combo Packs";
const BAR_CATEGORY = "Bar";
const TAKEAWAY_TABLE = "TAKEAWAY";
const DAY_OPTIONS = [
  { key: "sun", label: "Sun" }, { key: "mon", label: "Mon" }, { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" }, { key: "thu", label: "Thu" }, { key: "fri", label: "Fri" }, { key: "sat", label: "Sat" },
];
const WAITER_REASONS = [
  { key: "bill", icon: "🧾", label: "Request Bill" },
  { key: "water", label: "Water", icon: "💧" },
  { key: "tissues", label: "Tissues", icon: "🧻" },
  { key: "cutlery", label: "Cutlery", icon: "🍴" },
  { key: "condiments", label: "Seasoning / Condiments", icon: "🧂" },
  { key: "other", label: "Something else", icon: "✋" },
];

// NEW: payment methods offered when marking a bill paid — single source of
// truth so the modal, CSV export, and PDF report all agree on labels.


const ORDER_SECTIONS = [
  { key: "pending", label: "New", color: "#f59e0b", emptyMsg: "No new orders waiting.", emptyIcon: "🔔" },
  { key: "active", label: "In Kitchen", color: "#3b82f6", emptyMsg: "Nothing cooking right now.", emptyIcon: "👨‍🍳" },
  { key: "served", label: "Served", color: "#6b7280", emptyMsg: "No tables waiting on a bill.", emptyIcon: "🍽️" },
  { key: "billRequested", label: "Bill Requests", color: "#e8a33d", emptyMsg: "No bills requested.", emptyIcon: "🧾" },
  { key: "billed", label: "Awaiting Payment", color: "#8b5cf6", emptyMsg: "Nothing awaiting payment.", emptyIcon: "💳" },
];

function getCountdown(o) {
  if (o.status !== "preparing" || !o.etaMinutes || !o.preparingAt) return null;
  const totalSeconds = o.etaMinutes * 60;
  const elapsed = Math.floor((Date.now() - o.preparingAt) / 1000);
  const remaining = totalSeconds - elapsed;
  if (remaining <= 0) return "Any moment now";
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// === shared styles (module scope on purpose) ===
const inputStyle = { width: "100%", padding: "11px 14px", border: "1px solid var(--border, #e6e1d6)", borderRadius: 10, fontSize: 14, marginBottom: 12, background: "var(--surface, #ffffff)", fontFamily: "inherit", boxSizing: "border-box" };
const labelStyle = { fontSize: 12, color: "var(--text-secondary, #6b6b7b)", fontWeight: 700, display: "block", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 };
const glassCard = { background: "rgba(255,255,255,0.55)", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", border: "1px solid rgba(255,255,255,0.5)" };
// NEW: shared centered-modal styles for the customer-details / payment-method popups
const modalOverlayStyle = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center" };
const modalBoxStyle = { background: "var(--surface, #fff)", borderRadius: 20, padding: 28, maxWidth: 360, width: "90%" };

// === shared components — MUST live at module scope ===
function StatCard({ label, value, color, sub, onClick }) {
  return (
    <div onClick={onClick} style={{ ...glassCard, padding: 20, display: "flex", alignItems: "center", gap: 16, borderRadius: 18, cursor: onClick ? "pointer" : "default", boxShadow: `0 8px 24px ${color}22` }}>
      <div style={{ width: 8, alignSelf: "stretch", borderRadius: 4, background: color, flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.1, color: "#1a1a2e" }}>{value}</div>
        <div style={{ fontSize: 12.5, color: "#555", marginTop: 4, fontWeight: 700 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: "#777", marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}

// `order` may be one order, or a merged party's orders presented as one.
// A party across tables 1 and 2 is ONE group of guests eating together and one
// bill, so showing it as two unrelated cards is both confusing on a busy floor
// and how you end up handing them two bills.
function OrderCard({ order, children, onMoveClick, groupTables, sourceTables, delivery, rider }) {
  const isGroup = groupTables && groupTables.length > 1;
  const typeMeta = orderTypeMeta(order.orderType);
  const forDelivery = isDelivery(order);
  return (
    <div className="card" style={{ padding: 16, borderRadius: 14, animation: "riseIn 0.3s ease", position: "relative", borderLeft: order.isVIP ? "4px solid #eab308" : (order.orderType === "takeaway" ? "4px solid #8b5cf6" : undefined) }}>
      {order.isVIP && <span style={{ position: "absolute", top: -8, right: 10, background: "#eab308", color: "#1a1a2e", fontSize: 10, fontWeight: 800, padding: "2px 9px", borderRadius: 100 }}>VIP</span>}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: forDelivery ? typeMeta.color : (isGroup ? "#6d28d9" : "#1a1a2e"), color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: isGroup ? 11 : 13 }}>
            {forDelivery ? typeMeta.icon : (isGroup ? groupTables.length + "T" : order.table)}
          </div>
          <span style={{ fontWeight: 700, fontSize: 14.5 }}>
            {forDelivery ? "Delivery"
              : isGroup ? `Tables ${groupTables.join(" + ")}`
              : `Table ${order.table}`}
          </span>
          {isGroup && (
            <span title={`One party across tables ${groupTables.join(", ")} — one bill`}
              style={{ background: "#ede9fe", color: "#6d28d9", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 100 }}>
              ⇄ MERGED
            </span>
          )}
          {order.orderType === "takeaway" && <span style={{ background: "#ede9fe", color: "#6d28d9", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 100 }}>📦 TAKEAWAY</span>}
          {onMoveClick && order.orderType !== "takeaway" && (
            <button onClick={() => onMoveClick(order)} style={{ background: "none", border: "1px solid var(--border, #e6e1d6)", borderRadius: 100, fontSize: 10.5, padding: "2px 8px", cursor: "pointer", color: "#888" }}>Move</button>
          )}
        </div>
        <span style={{ fontSize: 11.5, color: "var(--text-secondary, #6b6b7b)" }}>{new Date(order.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      {forDelivery && rider?.name && (
        <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "8px 11px", marginBottom: 10, fontSize: 12.5, color: "#166534", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800 }}>
            {order.deliveredAt ? "✓ Delivered by" : "🛵 Out with"} {rider.name}
          </span>
          <a href={`tel:${rider.phone}`} style={{ color: "#166534", textDecoration: "underline" }}>{rider.phone}</a>
        </div>
      )}
      {/* A rider cannot deliver from a ticket that does not say where to. */}
      {forDelivery && delivery && (
        <div style={{ background: typeMeta.bg, borderRadius: 10, padding: "9px 11px", marginBottom: 10, fontSize: 12.5, lineHeight: 1.5 }}>
          <div style={{ fontWeight: 700, color: typeMeta.color }}>{delivery.name} · {delivery.phone}</div>
          <div style={{ color: typeMeta.color, opacity: 0.85 }}>{formatDeliveryAddress(delivery)}</div>
          {delivery.paymentMethod && (
            <div style={{ color: typeMeta.color, opacity: 0.7, marginTop: 3, textTransform: "uppercase", fontSize: 10.5, fontWeight: 800, letterSpacing: 0.4 }}>
              {delivery.paymentMethod === "cod" ? "💵 Cash on delivery" : "📱 UPI on delivery"}
            </div>
          )}
        </div>
      )}
      {order.items.map((it, i) => (
        <div key={i} style={{ padding: "3px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5 }}>
            <span>
              {it.name}
              {/* Which table ordered it still matters for delivery, even though
                  the party is billed as one. */}
              {isGroup && it._fromTable != null && (
                <span style={{ marginLeft: 6, fontSize: 10, color: "#6d28d9", fontWeight: 700 }}>T{it._fromTable}</span>
              )}
            </span>
            <span style={{ color: "var(--text-secondary, #6b6b7b)" }}>×{it.qty}</span>
          </div>
          {it.spiceLevel && <div style={{ fontSize: 11, color: "#e8a33d" }}>🌶 {it.spiceLevel}</div>}
          {it.notes && <div style={{ fontSize: 11, color: "#888", fontStyle: "italic" }}>"{it.notes}"</div>}
        </div>
      ))}
      {order.status === "preparing" && getCountdown(order) && (
        <div style={{ marginTop: 8, fontFamily: "monospace", fontSize: 17, color: "#C1440E", fontWeight: 700 }}>⏱ {getCountdown(order)}</div>
      )}
      {children && <div style={{ marginTop: 12, display: "flex", gap: 8 }}>{children}</div>}
    </div>
  );
}

function FoodTypeToggle({ value, onChange, pureVeg }) {
  // NEW: when the restaurant is running in Pure Veg mode (Settings → Menu
  // Intelligence), non-veg is not a concept that should exist anywhere in
  // the system — so instead of a veg/non-veg picker we just show a locked
  // "Veg" badge and never let foodType become anything but "veg".
  if (pureVeg) {
    return (
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 100, border: "2px solid #16a34a", background: "#16a34a15", fontSize: 13, fontWeight: 700, color: "#166534" }}>
          <span style={{ width: 12, height: 12, border: "1.5px solid #16a34a", borderRadius: 3, position: "relative", display: "inline-block" }}>
            <span style={{ position: "absolute", inset: 1.5, borderRadius: "50%", background: "#16a34a" }} />
          </span>
          🌱 Pure Veg Kitchen
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
      {[["veg", "Veg", "#16a34a"], ["nonveg", "Non-veg", "#dc2626"]].map(([val, label, color]) => (
        <button key={val} type="button" onClick={() => onChange(val)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 100, border: value === val ? `2px solid ${color}` : "1px solid #ddd", background: value === val ? color + "15" : "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
          <span style={{ width: 12, height: 12, border: `1.5px solid ${color}`, borderRadius: 3, position: "relative", display: "inline-block" }}>
            <span style={{ position: "absolute", inset: 1.5, borderRadius: "50%", background: color }} />
          </span>
          {label}
        </button>
      ))}
    </div>
  );
}

// === NEW: Size Variations & Add-ons editor — shared between "Add New Item"
// and the inline item-edit form. Lets reception collapse duplicate menu items
// (e.g. "Pizza Regular" / "Pizza Medium" / "Pizza Large") into ONE item with
// size options, plus optional extra add-ons (toppings, extra cheese, etc.)
// that customers can tick when adding it to their cart.
function addRow(setFn, key) {
  setFn((p) => ({ ...p, [key]: [...(p[key] || []), { id: `${key.slice(0, 3)}${Date.now()}${Math.random().toString(36).slice(2, 6)}`, name: "", price: "" }] }));
}
function updateRow(setFn, key, id, field, value) {
  setFn((p) => ({ ...p, [key]: (p[key] || []).map((r) => (r.id === id ? { ...r, [field]: value } : r)) }));
}
function removeRow(setFn, key, id) {
  setFn((p) => ({ ...p, [key]: (p[key] || []).filter((r) => r.id !== id) }));
}
function cleanRows(list) {
  return (list || []).filter((r) => r.name?.trim() && r.price !== "").map((r) => ({ id: r.id, name: r.name.trim(), price: parseFloat(r.price) || 0 }));
}

function VariationsAddonsEditor({ form, setForm }) {
  const variations = form.variations || [];
  const addons = form.addons || [];
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <label style={labelStyle}>Size / Variations (optional)</label>
        <button type="button" onClick={() => addRow(setForm, "variations")} className="btn btn-sm btn-ghost">+ Add Size</button>
      </div>
      {variations.length === 0 ? (
        <p style={{ fontSize: 11.5, color: "#999", marginTop: -6, marginBottom: 10 }}>No sizes — item sells at the single price above. Add sizes (e.g. Regular / Medium / Large) instead of creating separate duplicate menu items.</p>
      ) : variations.map((v) => (
        <div key={v.id} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
          <input placeholder="e.g. Medium" value={v.name} onChange={(e) => updateRow(setForm, "variations", v.id, "name", e.target.value)} style={{ ...inputStyle, marginBottom: 0, flex: 2 }} />
          <input placeholder="Price" type="number" value={v.price} onChange={(e) => updateRow(setForm, "variations", v.id, "price", e.target.value)} style={{ ...inputStyle, marginBottom: 0, flex: 1 }} />
          <button type="button" onClick={() => removeRow(setForm, "variations", v.id)} style={{ background: "none", border: "none", color: "#dc2626", cursor: "pointer", fontSize: 16 }}>✕</button>
        </div>
      ))}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "14px 0 8px" }}>
        <label style={labelStyle}>Extra Add-ons / Toppings (optional)</label>
        <button type="button" onClick={() => addRow(setForm, "addons")} className="btn btn-sm btn-ghost">+ Add Add-on</button>
      </div>
      {addons.length === 0 ? (
        <p style={{ fontSize: 11.5, color: "#999", marginTop: -6 }}>e.g. Extra Cheese, Extra Topping, Extra Raita — shown to customers as optional add-ons with their own price when they add this item.</p>
      ) : addons.map((a) => (
        <div key={a.id} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
          <input placeholder="e.g. Extra Cheese" value={a.name} onChange={(e) => updateRow(setForm, "addons", a.id, "name", e.target.value)} style={{ ...inputStyle, marginBottom: 0, flex: 2 }} />
          <input placeholder="Price" type="number" value={a.price} onChange={(e) => updateRow(setForm, "addons", a.id, "price", e.target.value)} style={{ ...inputStyle, marginBottom: 0, flex: 1 }} />
          <button type="button" onClick={() => removeRow(setForm, "addons", a.id)} style={{ background: "none", border: "none", color: "#dc2626", cursor: "pointer", fontSize: 16 }}>✕</button>
        </div>
      ))}
    </div>
  );
}

function MenuItemCard({ item, isEditing, editForm, setEditForm, editUploading, editFileInputRef, handleImageUpload, categories, saveEdit, cancelEdit, toggleAvailable, toggleFeatured, toggleChefSpecial, startEdit, deleteItem, pureVeg }) {
  if (isEditing) {
    return (
      <div className="card" style={{ padding: 16, borderRadius: 14, gridColumn: "1 / -1" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
          <div>
            <label style={labelStyle}>Name</label>
            <input value={editForm.name} onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Price (₹)</label>
            <input type="number" value={editForm.price} onChange={(e) => setEditForm((p) => ({ ...p, price: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Category</label>
            <select value={editForm.category} onChange={(e) => setEditForm((p) => ({ ...p, category: e.target.value }))} style={inputStyle}>
              {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Prep Time (min)</label>
            <input type="number" min="1" placeholder="15" value={editForm.etaMinutes ?? ""} onChange={(e) => setEditForm((p) => ({ ...p, etaMinutes: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Photo</label>
            <input ref={editFileInputRef} type="file" accept="image/*" onChange={(e) => handleImageUpload(e.target.files[0], true)} style={{ display: "none" }} />
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button onClick={() => editFileInputRef.current?.click()} disabled={editUploading} className="btn btn-sm btn-ghost" style={{ border: "2px dashed var(--border, #e6e1d6)" }}>{editUploading ? "..." : "Change Photo"}</button>
              {editForm.imageUrl && !editUploading && <img src={editForm.imageUrl} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover" }} />}
            </div>
          </div>
        </div>
        <label style={labelStyle}>Description</label>
        <input value={editForm.description} onChange={(e) => setEditForm((p) => ({ ...p, description: e.target.value }))} style={inputStyle} />
        <label style={labelStyle}>Food Type</label>
        <FoodTypeToggle value={editForm.foodType || "veg"} onChange={(v) => setEditForm((p) => ({ ...p, foodType: v }))} pureVeg={pureVeg} />
        <VariationsAddonsEditor form={editForm} setForm={setEditForm} />
        <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            <input type="checkbox" checked={!!editForm.featured} onChange={(e) => setEditForm((p) => ({ ...p, featured: e.target.checked }))} /> Featured
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            <input type="checkbox" checked={!!editForm.chefSpecial} onChange={(e) => setEditForm((p) => ({ ...p, chefSpecial: e.target.checked }))} /> Chef's Special
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            <input type="checkbox" checked={!!editForm.bogoEnabled} onChange={(e) => setEditForm((p) => ({ ...p, bogoEnabled: e.target.checked }))} /> 🎁 Buy 1 Get 1 Free
          </label>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-sm btn-primary" onClick={saveEdit} style={{ flex: 1 }}>Save Changes</button>
          <button className="btn btn-sm btn-ghost" onClick={cancelEdit} style={{ flex: 1 }}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ borderRadius: 16, overflow: "hidden", opacity: item.available ? 1 : 0.6, display: "flex", flexDirection: "column" }}>
      <div style={{ position: "relative", height: 140, background: "var(--surface-2, #f3efe6)" }}>
        {item.imageUrl ? <img src={item.imageUrl} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 36 }}>🍽️</div>}
        <div style={{ position: "absolute", top: 8, left: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
          {item.isCombo && <span style={{ background: "#1a1a2e", color: "#fff", fontSize: 10.5, fontWeight: 800, padding: "3px 9px", borderRadius: 100 }}>COMBO</span>}
          {item.category === BAR_CATEGORY && <span style={{ background: "#7c3aed", color: "#fff", fontSize: 10.5, fontWeight: 800, padding: "3px 9px", borderRadius: 100 }}>🍸 BAR</span>}
          {item.chefSpecial && <span style={{ background: "#1a1a2e", color: "#fff", fontSize: 10.5, fontWeight: 800, padding: "3px 9px", borderRadius: 100 }}>CHEF'S SPECIAL</span>}
          {item.featured && <span style={{ background: "#e8a33d", color: "#fff", fontSize: 10.5, fontWeight: 800, padding: "3px 9px", borderRadius: 100 }}>★ FEATURED</span>}
          {item.bogoEnabled && <span style={{ background: "#16a34a", color: "#fff", fontSize: 10.5, fontWeight: 800, padding: "3px 9px", borderRadius: 100 }}>🎁 BOGO</span>}
          {item.variations?.length > 0 && <span style={{ background: "#0369a1", color: "#fff", fontSize: 10.5, fontWeight: 800, padding: "3px 9px", borderRadius: 100 }}>{item.variations.length} SIZES</span>}
          {item.addons?.length > 0 && <span style={{ background: "#166534", color: "#fff", fontSize: 10.5, fontWeight: 800, padding: "3px 9px", borderRadius: 100 }}>+{item.addons.length} ADD-ONS</span>}
        </div>
        {!item.available && (
          <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "#fff", fontWeight: 800, fontSize: 12.5, letterSpacing: 0.5 }}>OUT OF STOCK</span>
          </div>
        )}
      </div>
      <div style={{ padding: 14, flex: 1, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {!pureVeg && (
              <span style={{ width: 12, height: 12, border: `1.5px solid ${item.foodType === "nonveg" ? "#dc2626" : "#16a34a"}`, borderRadius: 3, position: "relative", display: "inline-block", flexShrink: 0 }}>
                <span style={{ position: "absolute", inset: 1.5, borderRadius: "50%", background: item.foodType === "nonveg" ? "#dc2626" : "#16a34a" }} />
              </span>
            )}
            <div style={{ fontWeight: 700, fontSize: 15 }}>{item.name}</div>
          </div>
          <div style={{ fontWeight: 800, fontSize: 15, color: "#e8a33d", whiteSpace: "nowrap" }}>
            {item.variations?.length > 0 ? `From ₹${Math.min(...item.variations.map((v) => v.price))}` : `₹${item.price}`}
          </div>
        </div>
        {item.description && <div style={{ fontSize: 12.5, color: "var(--text-secondary, #6b6b7b)", marginTop: 4, flex: 1 }}>{item.description}</div>}
        <div style={{ fontSize: 11, color: "#888", marginTop: 6, fontWeight: 600 }}>⏱ {item.etaMinutes || 15} min prep</div>
        <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
          <button onClick={() => toggleAvailable(item)} className="btn btn-sm" style={{ background: item.available ? "var(--success-light, #dcfce7)" : "var(--warning-light, #fef3c7)", color: item.available ? "#166534" : "#92400e", border: "none", flex: 1, minWidth: 90 }}>{item.available ? "In Stock" : "Out"}</button>
          <button onClick={() => toggleFeatured(item)} className="btn btn-sm" style={{ background: item.featured ? "#e8a33d20" : "var(--surface-2, #f3efe6)", color: item.featured ? "#92400e" : "var(--text-secondary, #6b6b7b)", border: "none" }} title="Toggle featured">★</button>
          {!item.isCombo && <button onClick={() => toggleChefSpecial(item)} className="btn btn-sm" style={{ background: item.chefSpecial ? "#1a1a2e" : "var(--surface-2, #f3efe6)", color: item.chefSpecial ? "#fff" : "var(--text-secondary, #6b6b7b)", border: "none" }} title="Toggle chef's special">CS</button>}
          <button onClick={() => startEdit(item)} className="btn btn-sm btn-ghost">Edit</button>
          <button onClick={() => deleteItem(item.id)} className="btn btn-sm btn-ghost" style={{ color: "var(--danger, #dc2626)" }}>Delete</button>
        </div>
      </div>
    </div>
  );
}

export default function ReceptionPageWrapper() {
  return (
    <AuthGuard allowedRoles={["reception"]}>
      <ReceptionPage />
    </AuthGuard>
  );
}

function ReceptionPage() {
  const { role, logout, restaurantId, features, access, brand, brandId, user, setActiveOutlet } = useAuth();
  const router = useRouter();

  // Every collection this outlet owns, each bounded and ordered in one place.
  // These were fourteen inline listeners with fourteen ideas of how much
  // history to load, which is how one of them ended up unbounded.
  const { orders, ordersLoaded } = useOrders(restaurantId);
  const menuItems = useMenuItems(restaurantId);
  const categories = useCategories(restaurantId);
  const tables = useTables(restaurantId);
  const floors = useFloors(restaurantId);
  const offerBanners = useOfferBanners(restaurantId);
  const bundleRules = useBundleRules(restaurantId);
  const waiterCalls = useWaiterCalls(restaurantId);
  const customers = useCustomers(restaurantId);
  const staffList = useStaff(restaurantId);
  const riders = useRiders(restaurantId);
  const riderAssignments = useRiderAssignments(restaurantId);
  const billRequestDetails = useBillRequestDetails(restaurantId);
  const billCustomers = useBillCustomers(restaurantId);
  // Where each delivery order is going. Kept off the order document because
  // orders are publicly readable; see firestore.rules.
  const deliveryDetails = useDeliveryDetails(restaurantId);
  const tableSessions = useTableSessions(restaurantId);

  // Whether a table's QR code will currently accept an order.
  function sessionOpenFor(tableNumber) {
    return isSessionOpen(tableSessions[String(tableNumber)]);
  }
  const { profile: profileDoc, billing: billingDoc, settings: settingsDoc } = useOutletInfo(restaurantId);

  const profile = profileDoc;
  const billing = billingDoc;
  // Defaults applied here rather than at every read site, so a restaurant that
  // has never opened Settings still has sane thresholds.
  const siteSettings = useMemo(() => ({
    hasBar: !!settingsDoc?.hasBar,
    pureVeg: !!settingsDoc?.pureVeg,
    googleReviewLink: settingsDoc?.googleReviewLink || "",
    googleReviewEnabled: !!settingsDoc?.googleReviewEnabled,
    thresholdMostLoved: settingsDoc?.thresholdMostLoved ?? 4.5,
    thresholdMostOrdered: settingsDoc?.thresholdMostOrdered ?? 100,
    thresholdMostRated: settingsDoc?.thresholdMostRated ?? 50,
  }), [settingsDoc]);

  // Kitchen is a live window onto the board, for anyone who runs the outlet
  // rather than works the pass. A manager covering three branches needs to see
  // whether the kitchen is drowning without walking into it, and reception
  // already has the same view on their own screen.
  const TABS = [
    { id: "dashboard", label: "Dashboard" },
    { id: "pos", label: "POS" },
    { id: "kitchen", label: "Kitchen" },
    { id: "menu", label: "Menu" },
    { id: "tables", label: "Tables" },
    { id: "crm", label: "CRM" },
    { id: "online", label: "Online" },
    { id: "settings", label: "Settings" },
  ];

  // === state ===
  const [activeTab, setActiveTab] = useState("dashboard");
  const [dashboardView, setDashboardView] = useState("main"); // main | sales | orders | items
  const [analyticsFilter, setAnalyticsFilter] = useState("today"); // today | 3days | week | month
  const [orderFilter, setOrderFilter] = useState("pending");
  const [tick, setTick] = useState(0);
  const [profileForm, setProfileForm] = useState({ name: "", tagline: "", logoUrl: "", address: "" });
  const [savedMsg, setSavedMsg] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false); // profile card starts collapsed; opens on "Edit Profile"
  const [newItem, setNewItem] = useState({ name: "", description: "", price: "", category: "", imageUrl: "", chefSpecial: false, foodType: "veg", variations: [], addons: [], bogoEnabled: false, etaMinutes: "" });
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [billingForm, setBillingForm] = useState({ taxPercent: 5, servicePercent: 0, upiId: "", upiSelfPayEnabled: false });
  const [billingSaved, setBillingSaved] = useState(false);
  const [showAddFloor, setShowAddFloor] = useState(false);
  const [newFloorName, setNewFloorName] = useState("");
  const [selectedFloorId, setSelectedFloorId] = useState(null);
  const [showFloorPicker, setShowFloorPicker] = useState(false);
  const floorPickerShownRef = useRef(false);
  const [siteUrl, setSiteUrl] = useState("");
  const [isMobile, setIsMobile] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [lastPendingCount, setLastPendingCount] = useState(0);
  const [lastBillCount, setLastBillCount] = useState(0);
  const [lastWaiterCount, setLastWaiterCount] = useState(0);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [editUploading, setEditUploading] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const [menuTab, setMenuTab] = useState("all");
  const [menuSearch, setMenuSearch] = useState("");
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [newCategory, setNewCategory] = useState({ name: "", imageUrl: "" });
  const [categoryUploading, setCategoryUploading] = useState(false);
  const [expandedCategoryId, setExpandedCategoryId] = useState(null); // NEW: replaces floating ✎/✕
  const [editCategoryForm, setEditCategoryForm] = useState({ name: "", imageUrl: "" });
  const [editCategoryUploading, setEditCategoryUploading] = useState(false);
  const [showAddCombo, setShowAddCombo] = useState(false);
  const [newCombo, setNewCombo] = useState({ name: "", description: "", price: "", imageUrl: "", featured: false });
  const [comboUploading, setComboUploading] = useState(false);
  const [splitBillOrder, setSplitBillOrder] = useState(null);
  const [splitCount, setSplitCount] = useState(2);
  const [showSplash, setShowSplash] = useState(false);
  const [splashLeaving, setSplashLeaving] = useState(false);
  const [showWaiterPopover, setShowWaiterPopover] = useState(false);

  // --- bulk import state ---
  const [showAddItem, setShowAddItem] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFormat, setImportFormat] = useState("csv"); // csv | json | zip
  const [importText, setImportText] = useState("");
  const [importPreview, setImportPreview] = useState(null);
  const [importing, setImporting] = useState(false);
  const [autoCreateCategories, setAutoCreateCategories] = useState(true);

  // --- NEW: ZIP (CSV + photos) import state ---
  const [zipFile, setZipFile] = useState(null);
  const [zipImages, setZipImages] = useState({});
  const [zipParsing, setZipParsing] = useState(false);
  const [importProgress, setImportProgress] = useState({ done: 0, total: 0 });
  const [importReport, setImportReport] = useState(null);

  // --- NEW: Smart Suggestions / Bundle rule engine state ---
  const [showAddBundleRule, setShowAddBundleRule] = useState(false);
  const [newBundleRule, setNewBundleRule] = useState({
    name: "", type: "pairDiscount", requiredItemA: "", requiredItemB: "",
    discountType: "flat", discountValue: "", threshold: "", freeItemId: "",
    requiredCategories: [],
  });

  // --- NEW: Call Waiter state ---

  // --- NEW: Tables — merge & move ---
  const [mergeMode, setMergeMode] = useState(false);
  const [mergePrimary, setMergePrimary] = useState(null);
  const [mergeSelected, setMergeSelected] = useState([]);
  const [dispatchOrder, setDispatchOrder] = useState(null);
  // A rider chosen from the saved roster, not typed — see lib/riders.js.
  const [selectedRiderId, setSelectedRiderId] = useState("");
  const [riderErrors, setRiderErrors] = useState({});
  const [qrModalTable, setQrModalTable] = useState(null);
  // The token is returned exactly once, when it is issued. Nothing can read it
  // back, so it lives here only until the modal closes.
  const [qrToken, setQrToken] = useState("");
  const [qrIssuing, setQrIssuing] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(null);
  const [movingOrder, setMovingOrder] = useState(null);
  const [moveTargetTable, setMoveTargetTable] = useState("");

  // --- NEW: POS state ---
  const [posOrderType, setPosOrderType] = useState("dinein"); // dinein | takeaway
  const [posTable, setPosTable] = useState(null);
  const [posCategoryTab, setPosCategoryTab] = useState("all");
  const [posSearch, setPosSearch] = useState("");
  // NEW: keyed by a composite line key (item + chosen size + chosen add-ons)
  // instead of just itemId, so the same dish ordered in two different sizes,
  // or with different add-ons, shows as separate cart lines. See posLineKey().
  const [posCart, setPosCart] = useState({}); // { lineKey: { itemId, key, name, price, qty, variationId, addonIds } }
  const [posNotes, setPosNotes] = useState("");
  const [posSending, setPosSending] = useState(false);
  // NEW: when a POS item has size variations and/or add-ons, tapping it opens
  // this picker instead of adding straight to the cart — mirrors the same
  // "choose size / choose add-ons" flow the customer-facing table page uses.
  const [posVariantModal, setPosVariantModal] = useState(null); // { item, variationId, addonIds, qty }

  // --- NEW: extra settings (bar toggle + badge thresholds) ---
  const [siteSettingsForm, setSiteSettingsForm] = useState({ hasBar: false, pureVeg: false, googleReviewLink: "", googleReviewEnabled: false, thresholdMostLoved: 4.5, thresholdMostOrdered: 100, thresholdMostRated: 50 });
  const [siteSettingsSaved, setSiteSettingsSaved] = useState(false);

  // --- NEW: Offer Carousel (replaces the old auto Hero Carousel) ---
  const [showManageOffers, setShowManageOffers] = useState(false);
  const [newOfferBanner, setNewOfferBanner] = useState({ title: "", imageUrl: "", linkedItemId: "", discountPercent: "", days: [] });
  const [offerBannerUploading, setOfferBannerUploading] = useState(false);
  const offerBannerFileInputRef = useRef(null);

  // --- NEW: unified Generate Bill flow — customer capture + payment method,
  // collected together up front instead of asking payment method later at
  // Mark Paid time. See billFlowModal / openGenerateBill / generateBill.
  const [billFlowOrder, setBillFlowOrder] = useState(null); // order pending bill generation
  const [billFlowForm, setBillFlowForm] = useState({ name: "", phone: "", paymentMethod: "cash" });

  // --- NEW: CRM — customers collection, keyed by phone ---
  // Bill-time customer name/phone, kept out of the order docs the diner's
  // device can read. Keyed by billId.

  const editCategoryFileInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const editFileInputRef = useRef(null);
  const logoFileInputRef = useRef(null);
  const categoryFileInputRef = useRef(null);
  const comboFileInputRef = useRef(null);
  const seededCategories = useRef(false);

  // Staff
  const [outlets, setOutlets] = useState([]); // every outlet in the brand this person can reach
  // Stable primitive keys for effect dependencies — see the note below.
  const brandOutletKey = (brand?.outletIds || []).join(",");
  const accessOutletKey = access.outletIds.join(",");
  const kdsFailedRef = useRef(new Set());                  // orders whose auto-start was permanently denied
  const [kdsError, setKdsError] = useState("");
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState(null);

  // The edit forms start from whatever is stored. Previously this happened
  // inside each listener; keeping it as its own effect means the listener does
  // one job and the form is seeded from a value rather than a snapshot.
  useEffect(() => { if (profileDoc) setProfileForm(profileDoc); }, [profileDoc]);
  useEffect(() => { if (billingDoc) setBillingForm(billingDoc); }, [billingDoc]);
  useEffect(() => { setSiteSettingsForm(siteSettings); }, [siteSettings]);

  // Categories seed themselves once, and Combo Packs is kept present. This used
  // to live inside the categories listener, which meant a read handler that
  // also wrote.
  useEffect(() => {
    if (!restaurantId) return;
    if (categories.length === 0 && !seededCategories.current) {
      seededCategories.current = true;
      (async () => {
        for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
          const slug = DEFAULT_CATEGORIES[i].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
          await setDoc(doc(db, "restaurants", restaurantId, "categories", slug), { name: DEFAULT_CATEGORIES[i], imageUrl: "", order: i, createdAt: Date.now() }, { merge: true });
        }
      })();
    }
    if (categories.length > 0 && !categories.some((c) => c.name === COMBO_CATEGORY)) {
      setDoc(doc(db, "restaurants", restaurantId, "categories", "combo-packs"), { name: COMBO_CATEGORY, imageUrl: "", order: categories.length, createdAt: Date.now() }, { merge: true }).catch(() => {});
    }
  }, [restaurantId, categories]);

  // === splash ===
  useEffect(() => { setShowSplash(true); }, []);
  useEffect(() => {
    if (!showSplash) return;
    const l = setTimeout(() => setSplashLeaving(true), 1900);
    const h = setTimeout(() => setShowSplash(false), 2450);
    return () => { clearTimeout(l); clearTimeout(h); };
  }, [showSplash]);
  function dismissSplash() { setSplashLeaving(true); setTimeout(() => setShowSplash(false), 400); }

  // === basic effects ===
  useEffect(() => {
    setSiteUrl(window.location.origin);
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!brandId || !brandOutletKey) { setOutlets([]); return; }
    let cancelled = false;
    (async () => {
      const ids = brandOutletKey.split(",").filter((id) => access.allOutlets || access.outletIds.includes(id));
      const loaded = await Promise.all(ids.map(async (id) => {
        try {
          const snap = await getDoc(doc(db, "restaurants", id));
          return snap.exists() ? { id, ...snap.data() } : { id, name: id.slice(0, 6) };
        } catch {
          return { id, name: id.slice(0, 6) };
        }
      }));
      if (!cancelled) setOutlets(loaded);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // Depend ONLY on primitives. An object or array in a dependency list is a
    // fresh reference on every render, which re-runs the effect, which sets
    // state, which renders again — forever.
  }, [brandId, brandOutletKey, access.allOutlets, accessOutletKey]);





  // NEW: bar toggle + badge thresholds

  // NEW: Offer Carousel banners, ordered


  // NEW: CRM customers, live, most recently seen first

  // Staff-only customer details for bills in the active window. Security rules
  // deny this collection to the unauthenticated diner client, which is the
  // whole point of it being separate from the order doc.

  // NEW: Most Loved / Most Ordered / Most Rated badges — previously the Settings
  // thresholds weren't connected to anything. This recomputes each item's flags
  // whenever orders, menu items, or the thresholds change, and only writes back
  // to Firestore when a flag actually changed (so it can't loop on itself).
  //   mostOrdered → total qty sold across billed/paid orders >= thresholdMostOrdered
  //   mostLoved   → item.rating (avg out of 5, written by the customer review
  //                 flow on the table page) >= thresholdMostLoved, with at least
  //                 one review
  //   mostRated   → item.ratingCount (also written by the review flow) >=
  //                 thresholdMostRated
  // If your table-side review flow doesn't yet write `rating` / `ratingCount`
  // onto menu items, mostLoved/mostRated will simply stay off until it does —
  // mostOrdered works immediately since it's derived from orders you already have.
  useEffect(() => {
    if (!restaurantId || menuItems.length === 0) return;
    // Counts each bill once (merged tables included) and resolves legacy lines
    // by name, so a dish's variations count toward the same badge threshold.
    const qtyById = soldQtyByItem(orders, menuItems);
    const updates = [];
    menuItems.forEach((m) => {
      const soldQty = qtyById[m.id] || qtyById[m.name] || 0;
      const rating = m.rating || 0;
      const ratingCount = m.ratingCount || 0;
      const mostOrdered = soldQty >= (siteSettings.thresholdMostOrdered || 100);
      const mostLoved = ratingCount > 0 && rating >= (siteSettings.thresholdMostLoved || 4.5);
      const mostRated = ratingCount >= (siteSettings.thresholdMostRated || 50);
      if (!!m.mostOrdered !== mostOrdered || !!m.mostLoved !== mostLoved || !!m.mostRated !== mostRated) {
        updates.push({ id: m.id, mostOrdered, mostLoved, mostRated });
      }
    });
    if (updates.length > 0) {
      const batch = writeBatch(db);
      updates.forEach((u) => batch.update(doc(db, "restaurants", restaurantId, "menuItems", u.id), { mostOrdered: u.mostOrdered, mostLoved: u.mostLoved, mostRated: u.mostRated }));
      batch.commit().catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, menuItems, siteSettings.thresholdMostOrdered, siteSettings.thresholdMostLoved, siteSettings.thresholdMostRated, restaurantId]);


  // Floors

  // Show floor picker once per session if there's more than one floor
  useEffect(() => {
    if (floorPickerShownRef.current) return;
    if (floors.length > 1) {
      setShowFloorPicker(true);
      floorPickerShownRef.current = true;
    }
  }, [floors]);

  // Categories: live sync + one-time seed (+ always ensure Combo Packs exists, + Bar when enabled)

  // NEW: auto-create/remove the Bar category when the toggle changes
  useEffect(() => {
    if (!restaurantId || categories.length === 0) return;
    const hasBarCat = categories.some((c) => c.name === BAR_CATEGORY);
    if (siteSettings.hasBar && !hasBarCat) {
      setDoc(doc(db, "restaurants", restaurantId, "categories", "bar"), { name: BAR_CATEGORY, imageUrl: "", order: categories.length, createdAt: Date.now() }, { merge: true });
    }
    // Note: we don't auto-delete Bar when turned off, in case it still has items — receptionist can delete manually once empty.
  }, [siteSettings.hasBar, categories, restaurantId]);

  // NEW: bundle / smart-suggestion rules

  // NEW: waiter calls, live, newest first

  // NEW: auto-clear acknowledged waiter calls older than 10 minutes (client-side housekeeping)
  useEffect(() => {
    const stale = waiterCalls.filter((c) => c.status === "acknowledged" && Date.now() - (c.createdAt || 0) > 10 * 60 * 1000);
    stale.forEach((c) => { if (restaurantId) deleteDoc(doc(db, "restaurants", restaurantId, "waiterCalls", c.id)).catch(() => {}); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  // Staff

  useEffect(() => { requestNotificationPermission(); }, []);

  useEffect(() => {
    if (!newItem.category && categories.length > 0) {
      const firstNonCombo = categories.find((c) => c.name !== COMBO_CATEGORY);
      setNewItem((p) => ({ ...p, category: firstNonCombo ? firstNonCombo.name : categories[0].name }));
    }
  }, [categories, newItem.category]);

  // === computed ===
  const pending = orders.filter((o) => o.status === "pending");
  // A delivery handed to a rider is billed but still in flight. It stays in
  // this list until it is marked delivered -- otherwise generating its bill at
  // dispatch would drop it out of "In Kitchen" and put "Mark delivered" out of
  // reach, stranding the order between the two screens.
  const inFlightDelivery = isInFlightDelivery;
  const active = orders.filter((o) => ["confirmed", "preparing", "ready"].includes(o.status) || inFlightDelivery(o));
  const served = orders.filter((o) => o.status === "served");
  const billRequested = orders.filter((o) => o.status === "bill_requested");
  // ...and is therefore not shown as an ordinary billed table awaiting payment,
  // which would list it twice and invite someone to settle it before it lands.
  const billed = orders.filter((o) => o.status === "billed" && !inFlightDelivery(o));
  const pendingWaiterCalls = waiterCalls.filter((c) => c.status === "pending");

  const ordersToday = orders.filter((o) => isToday(o.createdAt));
  // revenueOrders() counts a merged-table bill once, not once per table.
  const revenueOrdersToday = revenueOrders(ordersToday);
  const todaySales = revenueOrdersToday.reduce((sum, o) => sum + (o.billTotal || 0), 0);
  const todayItemsSold = revenueOrdersToday.reduce((sum, o) => sum + (o.items || []).reduce((s, it) => s + (it.qty || 0), 0), 0);
  const todayOrderCount = ordersToday.length;
  const avgOrderValue = revenueOrdersToday.length > 0 ? Math.round(todaySales / revenueOrdersToday.length) : 0;

  // === merged tables ===
  //
  // Merging was previously only reflected in the "Awaiting Payment" list, so a
  // party sitting across tables 1 and 2 appeared in New / In Kitchen / Served
  // as two unrelated orders with no hint they belonged together. Staff had no
  // way to see the party was one party until the bill was generated.
  //
  // These helpers make the grouping visible everywhere.

  // Every table number in the same merged group as `tableNumber`, sorted.
  // A table that isn't merged returns just itself.
  function tableGroupNumbers(tableNumber) {
    const t = tables.find((tb) => tb.number === tableNumber);
    if (!t || !t.isMerged || !t.mergedGroupId) return [tableNumber];
    const group = tables
      .filter((tb) => tb.mergedGroupId === t.mergedGroupId)
      .map((tb) => tb.number)
      .sort((a, b) => a - b);
    return group.length > 0 ? group : [tableNumber];
  }

  function isMergedTable(tableNumber) {
    return tableGroupNumbers(tableNumber).length > 1;
  }

  // What to print on an order card. A billed order already carries the
  // authoritative list of tables its bill covered (mergedTables), so prefer
  // that; otherwise derive it from the tables' current merge state.
  function orderTableLabel(o) {
    if (Array.isArray(o.mergedTables) && o.mergedTables.length > 1) {
      return [...o.mergedTables].sort((a, b) => a - b).join(" + ");
    }
    return tableGroupNumbers(o.table).join(" + ");
  }

  // Bill-time customer details for an order, joined from the staff-only
  // collection. Falls back to whatever legacy orders still carry inline.
  function customerFor(o) {
    const rec = o?.billId ? billCustomers[o.billId] : null;
    return {
      name: rec?.name || o?.customerName || "",
      phone: rec?.phone || o?.customerPhone || "",
    };
  }

  const orderDataByKey = { pending, active, served, billRequested, billed };

  useEffect(() => {
    if (pending.length > lastPendingCount && lastPendingCount > 0) {
      playNotificationSound("newOrder");
      showPopupNotification("New Order", `Table ${pending[pending.length - 1]?.table} just placed an order`, { tag: "new-order", renotify: true });
    }
    setLastPendingCount(pending.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.length]);

  useEffect(() => {
    if (billRequested.length > lastBillCount && lastBillCount > 0) {
      playNotificationSound("bill");
      showPopupNotification("Bill Requested", `Table ${billRequested[billRequested.length - 1]?.table} requested the bill`, { tag: "bill-request", renotify: true });
    }
    setLastBillCount(billRequested.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billRequested.length]);

  useEffect(() => {
    if (pendingWaiterCalls.length > lastWaiterCount && lastWaiterCount > 0) {
      playNotificationSound("newOrder");
      showPopupNotification("Waiter Called", `Table ${pendingWaiterCalls[0]?.table} needs assistance`, { tag: "waiter-call", renotify: true });
    }
    setLastWaiterCount(pendingWaiterCalls.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingWaiterCalls.length]);

  // === uploads ===
  async function uploadGuard(file) {
    if (!file) return null;
    if (!file.type.startsWith("image/")) { alert("Please select an image file"); return null; }
    if (file.size > 5 * 1024 * 1024) { alert("Image must be under 5MB"); return null; }
    return uploadToCloudinary(file);
  }
  async function handleImageUpload(file, isEdit = false) {
    if (isEdit) setEditUploading(true); else setUploadingImage(true);
    try {
      const url = await uploadGuard(file);
      if (url) { if (isEdit) setEditForm((p) => ({ ...p, imageUrl: url })); else setNewItem((p) => ({ ...p, imageUrl: url })); }
    } catch (err) { alert("Upload failed: " + err.message); }
    finally { if (isEdit) setEditUploading(false); else setUploadingImage(false); }
  }
  async function handleLogoUpload(file) {
    setLogoUploading(true);
    try { const url = await uploadGuard(file); if (url) setProfileForm((p) => ({ ...p, logoUrl: url })); }
    catch (err) { alert("Upload failed: " + err.message); }
    finally { setLogoUploading(false); }
  }
  async function handleCategoryImageUpload(file) {
    setCategoryUploading(true);
    try { const url = await uploadGuard(file); if (url) setNewCategory((p) => ({ ...p, imageUrl: url })); }
    catch (err) { alert("Upload failed: " + err.message); }
    finally { setCategoryUploading(false); }
  }
  async function handleEditCategoryImageUpload(file) {
    setEditCategoryUploading(true);
    try { const url = await uploadGuard(file); if (url) setEditCategoryForm((p) => ({ ...p, imageUrl: url })); }
    catch (err) { alert("Upload failed: " + err.message); }
    finally { setEditCategoryUploading(false); }
  }
  async function handleComboImageUpload(file) {
    setComboUploading(true);
    try { const url = await uploadGuard(file); if (url) setNewCombo((p) => ({ ...p, imageUrl: url })); }
    catch (err) { alert("Upload failed: " + err.message); }
    finally { setComboUploading(false); }
  }
  async function handleOfferBannerImageUpload(file) {
    setOfferBannerUploading(true);
    try { const url = await uploadGuard(file); if (url) setNewOfferBanner((p) => ({ ...p, imageUrl: url })); }
    catch (err) { alert("Upload failed: " + err.message); }
    finally { setOfferBannerUploading(false); }
  }

  // === order actions ===
  // NEW: when reception confirms an order, work out how long the kitchen
  // needs — the LONGEST prep time among the order's items, since that item
  // is the bottleneck for the whole ticket. Falls back to 15 min per item if
  // it was never given a prep time. Kitchen picks this up as presetEtaMinutes
  // and either auto-starts the countdown immediately (if it has capacity) or
  // pre-fills the "Start Preparing" button with it — reception never has to
  // think about kitchen timing at all.
  // Longest prep time in the basket, floored at 15 — see lib/pos-cart.js.
  function computeOrderEta(items) {
    return estimatedEta(items, menuItems, 15);
  }

  async function confirmOrder(id) {
    const order = orders.find((o) => o.id === id);
    const presetEtaMinutes = computeOrderEta(order?.items);
    await updateDoc(doc(db, "restaurants", restaurantId, "orders", id), { status: "confirmed", presetEtaMinutes });
  }
  async function declineOrder(id) { await deleteDoc(doc(db, "restaurants", restaurantId, "orders", id)); }
  async function markServed(id) { await updateDoc(doc(db, "restaurants", restaurantId, "orders", id), { status: "served" }); }

  async function saveProfile() {
    await setDoc(doc(db, "restaurants", restaurantId, "info", "profile"), profileForm, { merge: true });
    setSavedMsg(true);
    setTimeout(() => { setSavedMsg(false); setEditingProfile(false); }, 900);
  }
  async function saveBilling() {
    await setDoc(doc(db, "restaurants", restaurantId, "info", "billing"), {
      taxPercent: parseFloat(billingForm.taxPercent) || 0,
      servicePercent: parseFloat(billingForm.servicePercent) || 0,
      upiId: (billingForm.upiId || "").trim(),
      upiSelfPayEnabled: !!billingForm.upiSelfPayEnabled,
    });
    setBillingSaved(true);
    setTimeout(() => setBillingSaved(false), 2000);
  }
  async function saveSiteSettings() {
    await setDoc(doc(db, "restaurants", restaurantId, "info", "settings"), {
      hasBar: !!siteSettingsForm.hasBar,
      pureVeg: !!siteSettingsForm.pureVeg,
      googleReviewLink: siteSettingsForm.googleReviewLink.trim(),
      googleReviewEnabled: !!siteSettingsForm.googleReviewEnabled,
      thresholdMostLoved: parseFloat(siteSettingsForm.thresholdMostLoved) || 4.5,
      thresholdMostOrdered: parseInt(siteSettingsForm.thresholdMostOrdered) || 100,
      thresholdMostRated: parseInt(siteSettingsForm.thresholdMostRated) || 50,
    }, { merge: true });
    setSiteSettingsSaved(true);
    setTimeout(() => setSiteSettingsSaved(false), 2000);
  }

  // Resolve every line to a menu item id before the bill is written. Lines
  // placed from now on already carry one; this backfills the older ones so
  // bundle rules, analytics, and the sales history all join correctly.
  function normalizedItems(items) {
    return withItemIds(items, menuItems);
  }

  // Given the order the receptionist clicked "Generate Bill" on, work out every
  // order that needs to be billed together — itself alone, unless its table is
  // part of a merged group, in which case every bill_requested order across the
  // whole group comes along so the party gets one consolidated bill.
  // Collapse a merged party's orders into a single display row.
  //
  // Returns entries of { rep, orders, tables, items } where `rep` stands in for
  // the group (earliest order), `orders` is everything it covers so an action
  // can be applied to all of them, and `items` is every line with the table it
  // came from attached.
  function collapseMergedGroups(list) {
    const groups = new Map();
    for (const o of list) {
      const t = tables.find((tb) => tb.number === o.table);
      const key = t?.isMerged && t.mergedGroupId ? `g:${t.mergedGroupId}` : `o:${o.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(o);
    }
    return [...groups.values()].map((os) => {
      const sorted = [...os].sort((a, b) => a.createdAt - b.createdAt);
      const rep = sorted[0];
      const tablesInGroup = [...new Set(sorted.map((o) => o.table))].sort((a, b) => a - b);
      const items = sorted.flatMap((o) => (o.items || []).map((it) => ({ ...it, _fromTable: o.table })));
      return {
        key: rep.id,
        // `rep` merges every order's lines, for the working views where the
        // party's orders are genuinely separate documents.
        rep: { ...rep, items },
        // `raw` is the untouched order. Billed siblings each already carry the
        // FULL consolidated bill (generateBill writes it onto all of them so
        // every table's device can show it), so merging their lines would list
        // the whole party's food twice.
        raw: rep,
        orders: sorted,
        tables: tablesInGroup,
      };
    }).sort((a, b) => a.tables[0] - b.tables[0] || a.rep.createdAt - b.rep.createdAt);
  }

  function ordersForBilling(o) {
    const t = tables.find((tb) => tb.number === o.table);
    if (t && t.isMerged && t.mergedGroupId) {
      const groupTableNumbers = tables.filter((tb) => tb.mergedGroupId === t.mergedGroupId).map((tb) => tb.number);
      // Everything the party still owes for, not only the orders whose table
      // happened to press "request bill". One table asking used to produce a
      // bill for that table alone, leaving the rest of the party to be billed
      // separately — which is exactly the split bill a merged table is meant
      // to prevent.
      const grouped = orders.filter((ord) =>
        groupTableNumbers.includes(ord.table)
        && ["bill_requested", "served"].includes(ord.status));
      if (grouped.length > 0) return grouped;
    }
    return [o];
  }

  // NEW: self-pay UPI QR only ever gets generated when the receptionist has
  // BOTH entered a UPI ID AND explicitly flipped on "Enable customer
  // self-payment via UPI QR" in Settings → Billing. Just having a UPI ID
  // saved is not enough on its own.
  //
  // NEW: accepts an optional customerInfo ({ name, phone }) captured via the
  // billCustomerModal — both fields are optional, and if either is given the
  // customer is upserted into the CRM collection with this bill's total.
  async function generateBill(o, withQr = false, customerInfo = null) {
    const ordersToBill = ordersForBilling(o);
    const rawItems = mergeItemLines(ordersToBill.flatMap((ord) => ord.items));
    const normalized = normalizedItems(rawItems);
    // The order was written by whoever's phone pointed at a table's QR code —
    // there is no login to check it against, so nothing stops a submitted
    // price from being whatever a tampered client felt like sending. This is
    // the one moment real money is actually charged, so it is the one moment
    // every price gets checked against the menu rather than trusted as
    // written — see authoritativeItems() in lib/pricing.js for what "checked"
    // means (the item's real price, its chosen variation and add-ons, and any
    // offer actually active today — never whatever number arrived on the order).
    const items = authoritativeItems({ items: normalized, menuItems, offerBanners });
    // The fee recorded when the customer was quoted it, not one recomputed
    // now against settings that may since have changed.
    const deliveryFee = ordersToBill.reduce((sum, ord) => sum + (ord.deliveryFee || 0), 0);
    const bill = computeBillTotals({
      items,
      menuItems,
      bundleRules,
      taxPercent: billing.taxPercent,
      servicePercent: billing.servicePercent,
      deliveryFee,
    });
    const selfPayOn = !!billing.upiSelfPayEnabled && !!billing.upiId;
    const upiLink = withQr && selfPayOn
      ? `upi://pay?pa=${encodeURIComponent(billing.upiId)}&pn=${encodeURIComponent(profile.name || "Restaurant")}&am=${bill.grandTotal}&cu=INR`
      : null;

    const customerName = (customerInfo?.name || "").trim();
    const customerPhone = (customerInfo?.phone || "").trim();
    // NEW: payment method is now collected up front, as part of Generate Bill,
    // instead of being asked again later at Mark Paid time.
    const paymentMethod = customerInfo?.paymentMethod || null;

    // One bill, one id, one instant — billId, billedAt, and the customer
    // record all stamp the same moment rather than three slightly different ones.
    const billedAt = Date.now();
    const billId = `${billedAt}-${ordersToBill[0].id}`;
    const primaryOrderId = ordersToBill[0].id;

    const billPayload = {
      status: "billed",
      items,
      billId,
      billedAt,
      billSubtotal: bill.subtotal,
      billDiscounts: bill.discounts,
      billDiscountTotal: bill.discountTotal,
      billTaxPercent: bill.taxPercent, billTaxAmount: bill.taxAmount,
      billServicePercent: bill.servicePercent, billServiceAmount: bill.serviceAmount,
      billDeliveryFee: bill.deliveryFee,
      billTotal: bill.grandTotal,
      paymentQrUrl: upiLink ? `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(upiLink)}` : null,
      upiPayLink: upiLink || null,
      mergedTables: ordersToBill.length > 1 ? ordersToBill.map((ord) => ord.table) : null,
      hasCustomerDetails: !!(customerName || customerPhone),
      paymentMethod: paymentMethod,
    };

    // Every order in the group gets the SAME consolidated bill written onto it —
    // that way each table's own device (each listens only to its own table number)
    // shows the identical, correct final bill, not just whichever table reception
    // happened to click "Generate Bill" on.
    //
    // But exactly ONE of them is flagged primary. Without that flag, every
    // report that sums billTotal counted a three-table party's revenue three
    // times over, and its items three times too. All reporting now goes through
    // revenueOrders(), which keeps only the primary sibling.
    const batch = writeBatch(db);
    ordersToBill.forEach((ord) => batch.update(doc(db, "restaurants", restaurantId, "orders", ord.id), {
      ...billPayload,
      isBillPrimary: ord.id === primaryOrderId,
    }));
    await batch.commit();

    // Customer name and phone are deliberately NOT written onto the order doc.
    // The diner's table client reads order docs directly, so anything stored
    // there is readable by anyone who can guess a table number. They live in a
    // staff-only collection instead, joined back by billId for reports.
    if (customerName || customerPhone) {
      await setDoc(doc(db, "restaurants", restaurantId, "billCustomers", billId), {
        billId, name: customerName || null, phone: customerPhone || null,
        billTotal: bill.grandTotal, createdAt: billedAt,
      });
      await upsertCustomer(customerName, customerPhone, bill.grandTotal);
    }
  }

  // NEW: CRM — upsert a customer record keyed by phone (falls back to a
  // name-only bucket if no phone was given, though phone is what makes
  // repeat-visit tracking reliable across separate bills/visits).
  async function upsertCustomer(name, phone, amountSpent) {
    const phoneKey = (phone || "").replace(/[^0-9]/g, "");
    if (!phoneKey && !name) return;
    const docId = phoneKey || `name-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    try {
      const ref = doc(db, "restaurants", restaurantId, "customers", docId);
      const existing = await getDoc(ref);
      if (existing.exists()) {
        const d = existing.data();
        await updateDoc(ref, {
          name: name || d.name || "",
          phone: phoneKey || d.phone || "",
          orderCount: (d.orderCount || 0) + 1,
          totalSpent: (d.totalSpent || 0) + (amountSpent || 0),
          lastSeen: Date.now(),
        });
      } else {
        await setDoc(ref, {
          name: name || "", phone: phoneKey || "", orderCount: 1, totalSpent: amountSpent || 0,
          firstSeen: Date.now(), lastSeen: Date.now(),
        });
      }
    } catch (err) {
      console.error("CRM upsert failed:", err.message);
    }
  }

  // NEW: opens the unified Generate Bill modal — customer details + payment
  // method are chosen together, before the bill is written at all.
  function openGenerateBill(o) {
    // A delivery customer already gave their name, phone and payment method at
    // checkout, and a dine-in customer may have already given the same thing
    // when they tapped "Request Bill" on their own screen. Either way, asking
    // again wastes the receptionist's time and is a chance to key it in wrong
    // — a mistyped phone number is how a rider ends up unable to reach anyone.
    // Pre-fill it; it stays editable.
    const delivery = deliveryDetails[o.id];
    const billRequest = billRequestDetails[o.id];
    const d = delivery || billRequest;
    // Delivery only ever stores "cod" or "upi" (its own checkout vocabulary);
    // a bill request already stores one of reception's own PAYMENT_METHODS
    // keys directly, since the diner picked from that exact same list.
    const paymentMethod = delivery
      ? (delivery.paymentMethod === "upi" ? "upi" : "cash")
      : (billRequest?.paymentMethod || "cash");
    setBillFlowForm(d
      ? { name: d.name || "", phone: d.phone || "", paymentMethod, prefilled: true }
      : { name: "", phone: "", paymentMethod: "cash" });
    setBillFlowOrder(o);
  }

  // Handing an order to a rider. The rider's name and number go on the order
  // itself, because the customer's browser can read that and nothing else —
  // being able to call the person carrying your dinner is most of the value of
  // a tracking screen.
  async function confirmDispatch() {
    const rider = riderById(riders, selectedRiderId);
    if (!rider) { setRiderErrors({ phone: "Please choose a rider." }); return; }
    const o = dispatchOrder;
    try {
      // The bill is generated HERE, as the food leaves, for two reasons: it is
      // the last moment the contents can still change, and a delivery needs a
      // printable bill to go in the bag.
      //
      // This was the bug: marking an order delivered used to write a bare
      // "paid" status and nothing else. No billId, no billTotal, no customer
      // record -- so the order vanished from sales (which sums billTotal), from
      // the CRM, and there was never a bill to print.
      const details = deliveryDetails[o.id];
      if (!o.billId) {
        await generateBill(o, false, {
          name: details?.name || "",
          phone: details?.phone || "",
          // Already chosen at checkout, so billing does not ask again.
          paymentMethod: details?.paymentMethod === "upi" ? "upi" : "cash",
        });
      }
      // Copied from the roster entry at this moment, not referenced by id —
      // the tracker and the printed bill should keep showing exactly who
      // picked up this order even if the roster changes later. Written to its
      // own collection, not onto the order: orders are broadly listable, and
      // a rider's phone number has no reason to be enumerable alongside them.
      await setDoc(doc(db, "restaurants", restaurantId, "riderAssignments", o.id), {
        name: rider.name,
        phone: rider.phone,
        createdAt: Date.now(),
      });
      await updateDoc(doc(db, "restaurants", restaurantId, "orders", o.id), {
        dispatchedAt: Date.now(),
      });
      setDispatchOrder(null);
      setSelectedRiderId("");
      setRiderErrors({});
    } catch (e) {
      setRiderErrors({ phone: e?.code === "permission-denied"
        ? "You do not have permission to update this order."
        : e.message });
    }
  }

  // Closing the loop. A cash-on-delivery order is settled at the door, so
  // marking it delivered also settles it — otherwise every delivery would sit
  // in Awaiting Payment forever waiting for a step that already happened.
  async function markDelivered(o) {
    const details = deliveryDetails[o.id];
    const paidAtDoor = (details?.paymentMethod || "cod") !== "unpaid";

    // A bill should already exist from dispatch. This covers an order dispatched
    // before that change shipped, so it still lands in sales rather than being
    // marked paid with nothing to count.
    if (!o.billId) {
      await generateBill(o, false, {
        name: details?.name || "",
        phone: details?.phone || "",
        paymentMethod: details?.paymentMethod === "upi" ? "upi" : "cash",
      });
    }

    await updateDoc(doc(db, "restaurants", restaurantId, "orders", o.id), {
      deliveredAt: Date.now(),
      status: paidAtDoor ? "paid" : "billed",
      ...(paidAtDoor ? { paymentMethod: details?.paymentMethod === "upi" ? "upi" : "cash" } : {}),
    });
  }

  async function markPaid(id, method = "cash") {
    const order = orders.find((o) => o.id === id);
    if (!order) return;
    const t = tables.find((tb) => tb.number === order.table);
    if (t && t.isMerged && t.mergedGroupId) {
      // Cascade "paid" across every billed order in the merged group (staff only
      // need to tap Mark Paid once, on any one of the group's duplicate cards),
      // and clear the merge flags on all tables in the group.
      const groupTableNumbers = tables.filter((tb) => tb.mergedGroupId === t.mergedGroupId).map((tb) => tb.number);
      const siblingBilled = orders.filter((o) => o.status === "billed" && groupTableNumbers.includes(o.table));
      const groupTables = tables.filter((tb) => tb.mergedGroupId === t.mergedGroupId);
      const batch = writeBatch(db);
      siblingBilled.forEach((o) => batch.update(doc(db, "restaurants", restaurantId, "orders", o.id), { status: "paid", paymentMethod: method }));
      groupTables.forEach((tb) => batch.update(doc(db, "restaurants", restaurantId, "tables", tb.id), { mergedGroupId: null, mergedWith: [], isMerged: false }));
      await batch.commit();
      return;
    }
    await updateDoc(doc(db, "restaurants", restaurantId, "orders", id), { status: "paid", paymentMethod: method });
  }

  // NEW: payment method was already collected at Generate Bill time, so
  // Mark Paid just confirms and finalizes using that stored value — no
  // second prompt. Falls back to "cash" only for older bills generated
  // before this flow existed (paymentMethod not yet set on them).
  async function handleMarkPaidClick(order) {
    const method = order.paymentMethod || "cash";
    const methodLabel = PAYMENT_METHODS.find((m) => m.key === method)?.label || method;
    if (!confirm(`Mark Table ${order.table}'s bill (₹${order.billTotal}) as paid via ${methodLabel}?`)) return;
    await markPaid(order.id, method);
  }

  function printBill(o) {
    const bundleDiscounts = o.billDiscounts || [];
    const itemsHtml = o.items.map((it) => `
        <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;">
          <span>${it.name} x${it.qty}</span><span>Rs.${it.price * it.qty}</span>
        </div>`).join("");
    const discountsHtml = bundleDiscounts.map((d) => `
        <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;color:#16a34a;">
          <span>${d.name}</span><span>-Rs.${d.amount}</span>
        </div>`).join("");
    const qrHtml = o.paymentQrUrl ? `<div style="text-align:center;margin-top:16px;"><img src="${o.paymentQrUrl}" style="width:160px;" /><div style="font-size:11px;color:#888;margin-top:6px;">Scan to pay via UPI</div></div>` : "";
    const billCustomer = customerFor(o);
    const customerHtml = (billCustomer.name || billCustomer.phone) ? `<div class="sub">👤 ${billCustomer.name} ${billCustomer.phone}</div>` : "";
    const paymentMethodLabel = o.paymentMethod ? (PAYMENT_METHODS.find((m) => m.key === o.paymentMethod)?.label || o.paymentMethod) : "";
    const paymentHtml = paymentMethodLabel ? `<div class="sub">💳 Paid via ${paymentMethodLabel}</div>` : "";
    const html = `
      <html><head><title>Bill - Table ${o.table}</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
          body { font-family: 'Inter', sans-serif; max-width: 320px; margin: 20px auto; color: #1a1a2e; }
          h2 { text-align: center; margin-bottom: 0; font-size: 22px; }
          .sub { text-align: center; font-size: 12px; color: #6b6b7b; margin-bottom: 16px; }
          .line { border-top: 1px dashed #ccc; margin: 12px 0; }
          .row { display: flex; justify-content: space-between; font-size: 14px; padding: 4px 0; }
          .total { font-size: 20px; font-weight: 700; margin-top: 10px; }
        </style>
      </head><body>
        ${profile?.logoUrl ? `<div style="text-align:center;margin-bottom:10px;"><img src="${profile.logoUrl}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;" /></div>` : ""}
        <h2>${profile?.name || "Cabadra"}</h2>
        <div class="sub">${profile?.tagline || ""}</div>
        <div class="sub">${orderDestinationLabel(o)} - ${new Date(o.createdAt).toLocaleString()}</div>
        ${customerHtml}
        ${paymentHtml}
        <div class="line"></div>
        ${itemsHtml}
        <div class="line"></div>
        <div class="row"><span>Subtotal</span><span>Rs.${o.billSubtotal}</span></div>
        ${discountsHtml}
        ${o.billTaxAmount > 0 ? `<div class="row"><span>Tax (${o.billTaxPercent}%)</span><span>Rs.${o.billTaxAmount}</span></div>` : ""}
        ${o.billServiceAmount > 0 ? `<div class="row"><span>Service (${o.billServicePercent}%)</span><span>Rs.${o.billServiceAmount}</span></div>` : ""}
        ${o.billDeliveryFee > 0 ? `<div class="row"><span>Delivery</span><span>Rs.${o.billDeliveryFee}</span></div>` : ""}
        <div class="line"></div>
        <div class="row total"><span>Total</span><span>Rs.${o.billTotal}</span></div>
        ${qrHtml}
        <div class="sub" style="margin-top:24px;">Thank you for dining with us!</div>
        <script>window.onload = () => window.print();</script>
      </body></html>`;
    const win = window.open("", "_blank", "width=400,height=600");
    win.document.write(html);
    win.document.close();
  }

  // === split bill (even split by N) ===
  function openSplitBill(o) { setSplitBillOrder(o); setSplitCount(2); }
  async function confirmEvenSplit() {
    if (!splitBillOrder) return;
    const total = splitBillOrder.billTotal;
    const n = Math.max(2, parseInt(splitCount) || 2);
    const perPerson = Math.round((total / n) * 100) / 100;
    const splits = Array.from({ length: n }, (_, i) => ({ index: i + 1, amount: perPerson, paid: false }));
    await updateDoc(doc(db, "restaurants", restaurantId, "orders", splitBillOrder.id), { billSplits: splits });
    setSplitBillOrder(null);
  }
  async function markSplitPaid(order, index) {
    const splits = (order.billSplits || []).map((s) => (s.index === index ? { ...s, paid: true } : s));
    const allPaid = splits.every((s) => s.paid);
    await updateDoc(doc(db, "restaurants", restaurantId, "orders", order.id), { billSplits: splits, ...(allPaid ? { status: "paid" } : {}) });
  }

  // === categories ===
  async function addCategory() {
    if (!newCategory.name.trim()) return alert("Give the category a name");
    if (categories.some((c) => c.name.toLowerCase() === newCategory.name.trim().toLowerCase())) return alert("That category already exists");
    await addDoc(collection(db, "restaurants", restaurantId, "categories"), { name: newCategory.name.trim(), imageUrl: newCategory.imageUrl, order: categories.length, createdAt: Date.now() });
    setNewCategory({ name: "", imageUrl: "" });
    setShowAddCategory(false);
  }
  async function deleteCategory(cat) {
    if (cat.name === COMBO_CATEGORY) return alert("The Combo Packs category can't be deleted.");
    const inUse = menuItems.some((m) => m.category === cat.name);
    if (inUse) return alert("This category still has menu items in it. Move or delete those items first.");
    if (!confirm(`Delete "${cat.name}" category?`)) return;
    await deleteDoc(doc(db, "restaurants", restaurantId, "categories", cat.id));
    if (menuTab === cat.name) setMenuTab("all");
    setExpandedCategoryId(null);
  }
  function startEditCategory(cat) { setEditCategoryForm({ name: cat.name, imageUrl: cat.imageUrl || "" }); }
  async function saveEditCategory(cat) {
    const newName = editCategoryForm.name.trim();
    if (!newName) return alert("Category name can't be empty");
    if (cat.name === COMBO_CATEGORY && newName !== COMBO_CATEGORY) return alert("Combo Packs category name can't be changed.");
    if (newName.toLowerCase() !== cat.name.toLowerCase() && categories.some((c) => c.name.toLowerCase() === newName.toLowerCase())) return alert("Another category already has that name");
    await updateDoc(doc(db, "restaurants", restaurantId, "categories", cat.id), { name: newName, imageUrl: editCategoryForm.imageUrl });
    if (newName !== cat.name) {
      const itemsToUpdate = menuItems.filter((m) => m.category === cat.name);
      await Promise.all(itemsToUpdate.map((m) => updateDoc(doc(db, "restaurants", restaurantId, "menuItems", m.id), { category: newName })));
      if (menuTab === cat.name) setMenuTab(newName);
    }
  }

  // Pull anything from the brand's master menu that this outlet does not
  // already have. Deliberately a COPY, not a live link: the outlet owns its
  // menu afterwards and can price, hide, and customise items freely, exactly
  // as it always could. Matching is on name, so seeding twice is a no-op and an
  // item the outlet has re-priced is never reset to the brand price.
  async function seedFromMasterMenu() {
    if (!brandId) return alert("This account is not linked to a brand yet.");
    setSeeding(true);
    setSeedResult(null);
    try {
      const master = await fetchMasterMenu(brandId);
      if (master.length === 0) {
        setSeedResult({ error: "The master menu is empty. Add items to it from the brand console first." });
        return;
      }
      const result = await seedOutletFromMaster(brandId, restaurantId, master, menuItems);
      setSeedResult(result);
    } catch (e) {
      setSeedResult({ error: e?.code === "permission-denied" ? "You do not have permission to change this outlet's menu." : e.message });
    } finally {
      setSeeding(false);
    }
  }

  // === menu items ===
  async function addMenuItem() {
    if (!newItem.name || !newItem.price) return alert("Name and price are required");
    if (!newItem.category) return alert("Please choose a category (add one first if the list is empty)");
    if (!newItem.foodType) return alert("Please mark this item as Veg or Non-veg");
    await addDoc(collection(db, "restaurants", restaurantId, "menuItems"), {
      name: newItem.name, description: newItem.description, price: parseFloat(newItem.price), category: newItem.category,
      imageUrl: newItem.imageUrl, available: true, featured: false, chefSpecial: !!newItem.chefSpecial,
      foodType: newItem.foodType, isCombo: false, bogoEnabled: !!newItem.bogoEnabled,
      etaMinutes: parseInt(newItem.etaMinutes) || 15,
      variations: cleanRows(newItem.variations), addons: cleanRows(newItem.addons),
      createdAt: Date.now(),
    });
    setNewItem({ name: "", description: "", price: "", category: newItem.category, imageUrl: "", chefSpecial: false, foodType: "veg", variations: [], addons: [], bogoEnabled: false, etaMinutes: "" });
  }
  async function addCombo() {
    if (!newCombo.name || !newCombo.price) return alert("Combo name and price are required");
    await addDoc(collection(db, "restaurants", restaurantId, "menuItems"), {
      name: newCombo.name, description: newCombo.description, price: parseFloat(newCombo.price), category: COMBO_CATEGORY,
      imageUrl: newCombo.imageUrl, available: true, featured: !!newCombo.featured, chefSpecial: false,
      foodType: "veg", isCombo: true, createdAt: Date.now(),
    });
    setNewCombo({ name: "", description: "", price: "", imageUrl: "", featured: false });
    setShowAddCombo(false);
  }
  function startEdit(item) { setEditingId(item.id); setEditForm({ variations: [], addons: [], ...item }); }
  async function saveEdit() {
    await updateDoc(doc(db, "restaurants", restaurantId, "menuItems", editingId), {
      name: editForm.name, description: editForm.description, price: parseFloat(editForm.price), category: editForm.category,
      imageUrl: editForm.imageUrl, featured: editForm.featured ?? false, chefSpecial: editForm.chefSpecial ?? false,
      foodType: editForm.foodType || "veg", bogoEnabled: editForm.bogoEnabled ?? false,
      etaMinutes: parseInt(editForm.etaMinutes) || 15,
      variations: cleanRows(editForm.variations), addons: cleanRows(editForm.addons),
    });
    setEditingId(null);
  }
  async function toggleAvailable(item) { await updateDoc(doc(db, "restaurants", restaurantId, "menuItems", item.id), { available: !item.available }); }
  async function toggleFeatured(item) { await updateDoc(doc(db, "restaurants", restaurantId, "menuItems", item.id), { featured: !item.featured }); }
  async function toggleChefSpecial(item) { await updateDoc(doc(db, "restaurants", restaurantId, "menuItems", item.id), { chefSpecial: !item.chefSpecial }); }
  async function deleteItem(id) { if (!confirm("Delete this item?")) return; await deleteDoc(doc(db, "restaurants", restaurantId, "menuItems", id)); }

  // === NEW: Offer Carousel — reception-curated exclusive deal banners ===
  async function addOfferBanner() {
    if (offerBanners.length >= 8) return alert("You can add up to 8 offer banners.");
    if (!newOfferBanner.title.trim()) return alert("Give the offer a title");
    if (!newOfferBanner.imageUrl) return alert("Upload a banner image");
    if (!newOfferBanner.linkedItemId) return alert("Link this offer to a menu item");
    try {
      await addDoc(collection(db, "restaurants", restaurantId, "offerBanners"), {
        title: newOfferBanner.title.trim(), imageUrl: newOfferBanner.imageUrl, linkedItemId: newOfferBanner.linkedItemId,
        discountPercent: parseFloat(newOfferBanner.discountPercent) || 0,
        days: newOfferBanner.days || [],
        order: offerBanners.length, createdAt: Date.now(),
      });
      setNewOfferBanner({ title: "", imageUrl: "", linkedItemId: "", discountPercent: "", days: [] });
    } catch (err) {
      // Most commonly this is a Firestore security-rules gap: offerBanners is a
      // new collection and needs the same reception write-access rule your other
      // collections (e.g. menuItems, bundleRules) already have.
      alert("Couldn't save the offer: " + err.message);
    }
  }
  async function deleteOfferBanner(id) {
    if (!confirm("Delete this offer banner?")) return;
    await deleteDoc(doc(db, "restaurants", restaurantId, "offerBanners", id));
  }
  async function moveOfferBanner(banner, direction) {
    const idx = offerBanners.findIndex((b) => b.id === banner.id);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= offerBanners.length) return;
    const other = offerBanners[swapIdx];
    const batch = writeBatch(db);
    batch.update(doc(db, "restaurants", restaurantId, "offerBanners", banner.id), { order: other.order ?? swapIdx });
    batch.update(doc(db, "restaurants", restaurantId, "offerBanners", other.id), { order: banner.order ?? idx });
    await batch.commit();
  }

  // === NEW: Smart Suggestions / Bundle rules ===
  function resetBundleForm() {
    setNewBundleRule({ name: "", type: "pairDiscount", requiredItemA: "", requiredItemB: "", discountType: "flat", discountValue: "", threshold: "", freeItemId: "", requiredCategories: [] });
  }
  async function addBundleRule() {
    if (!newBundleRule.name.trim()) return alert("Give the rule a name");
    const payload = { name: newBundleRule.name.trim(), type: newBundleRule.type, active: true, createdAt: Date.now() };
    if (newBundleRule.type === "pairDiscount") {
      if (!newBundleRule.requiredItemA || !newBundleRule.requiredItemB) return alert("Pick both items for the pair");
      if (!newBundleRule.discountValue) return alert("Enter a discount value");
      payload.requiredItems = [newBundleRule.requiredItemA, newBundleRule.requiredItemB];
      payload.discountType = newBundleRule.discountType;
      payload.discountValue = parseFloat(newBundleRule.discountValue);
    } else if (newBundleRule.type === "thresholdFreeItem") {
      if (!newBundleRule.threshold || !newBundleRule.freeItemId) return alert("Set a threshold amount and pick the free item");
      payload.threshold = parseFloat(newBundleRule.threshold);
      payload.freeItemId = newBundleRule.freeItemId;
    } else if (newBundleRule.type === "categoryBundle") {
      if (newBundleRule.requiredCategories.length < 2 || !newBundleRule.discountValue) return alert("Pick at least 2 categories and a % discount");
      payload.requiredCategories = newBundleRule.requiredCategories;
      payload.discountType = "percent";
      payload.discountValue = parseFloat(newBundleRule.discountValue);
    }
    await addDoc(collection(db, "restaurants", restaurantId, "bundleRules"), payload);
    resetBundleForm();
    setShowAddBundleRule(false);
  }
  async function toggleBundleRuleActive(rule) { await updateDoc(doc(db, "restaurants", restaurantId, "bundleRules", rule.id), { active: !rule.active }); }
  async function deleteBundleRule(id) { if (!confirm("Delete this rule?")) return; await deleteDoc(doc(db, "restaurants", restaurantId, "bundleRules", id)); }
  function bundleRuleSummary(rule) {
    if (rule.type === "pairDiscount") {
      const names = (rule.requiredItems || []).map((id) => menuItems.find((m) => m.id === id)?.name || "?").join(" + ");
      const val = rule.discountType === "flat" ? `₹${rule.discountValue} off` : `${rule.discountValue}% off`;
      return `${names} → ${val}`;
    }
    if (rule.type === "thresholdFreeItem") {
      const freeName = menuItems.find((m) => m.id === rule.freeItemId)?.name || "?";
      return `Spend ₹${rule.threshold} → Free ${freeName}`;
    }
    if (rule.type === "categoryBundle") {
      return `${(rule.requiredCategories || []).join(" + ")} → ${rule.discountValue}% off`;
    }
    return rule.name;
  }

  // === NEW: Call Waiter ===
  async function acknowledgeWaiterCall(id) { await updateDoc(doc(db, "restaurants", restaurantId, "waiterCalls", id), { status: "acknowledged" }); }
  async function dismissWaiterCall(id) { await deleteDoc(doc(db, "restaurants", restaurantId, "waiterCalls", id)); }

  // === floors & tables ===
  async function addFloor() {
    if (!newFloorName.trim()) return alert("Give the floor a name");
    await addDoc(collection(db, "restaurants", restaurantId, "floors"), { name: newFloorName.trim(), order: floors.length, createdAt: Date.now() });
    setNewFloorName("");
    setShowAddFloor(false);
  }
  async function deleteFloor(floor) {
    const inUse = tables.some((t) => t.floorId === floor.id);
    if (inUse) return alert("Move or delete tables on this floor first.");
    if (!confirm(`Delete floor "${floor.name}"?`)) return;
    await deleteDoc(doc(db, "restaurants", restaurantId, "floors", floor.id));
    if (selectedFloorId === floor.id) setSelectedFloorId(null);
  }
  async function addTable(floorId) {
    const nextNumber = tables.length > 0 ? Math.max(...tables.map((t) => t.number)) + 1 : 1;
    await addDoc(collection(db, "restaurants", restaurantId, "tables"), { number: nextNumber, floorId: floorId || null, isVIP: false, mergedGroupId: null, mergedWith: [], isMerged: false, createdAt: Date.now() });
  }
  async function deleteTable(id) {
    if (!confirm("Delete this table? Its QR code will stop working.")) return;
    await deleteDoc(doc(db, "restaurants", restaurantId, "tables", id));
  }
  async function toggleVip(t) { await updateDoc(doc(db, "restaurants", restaurantId, "tables", t.id), { isVIP: !t.isVIP }); }

  async function freeTable(tableNumber) {
    const activeForTable = orders.filter((o) => o.table === tableNumber && !["paid", "cancelled", "declined", "merged"].includes(o.status));
    if (activeForTable.length === 0) return alert(`Table ${tableNumber} has no active orders.`);
    if (!confirm(`Free Table ${tableNumber}? This will cancel ${activeForTable.length} active order(s).`)) return;
    const batch = writeBatch(db);
    activeForTable.forEach((o) => batch.update(doc(db, "restaurants", restaurantId, "orders", o.id), { status: "cancelled" }));
    await batch.commit();
    // Freeing a table also ends its ordering window, so a code left on an empty
    // table stops working the moment the party leaves.
    await closeTableSession(restaurantId, tableNumber).catch(() => {});
  }

  function qrUrlFor(tableNumber, token) {
    const link = tableUrl(siteUrl, restaurantId, tableNumber, token);
    return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(link)}`;
  }

  // Issuing a token protects the table — and invalidates whatever code is
  // currently stuck to it. Deliberately explicit, because a stale printed code
  // means guests at that table cannot order until it is replaced.
  async function openQrFor(table) {
    setQrModalTable(table);
    setQrToken("");
    setQrIssuing(true);
    try {
      setQrToken(await issueTableToken(restaurantId, table.number));
    } catch (e) {
      alert(e?.code === "permission-denied"
        ? "You do not have permission to generate codes for this outlet."
        : `Could not generate a code: ${e.message}`);
      setQrModalTable(null);
    } finally {
      setQrIssuing(false);
    }
  }

  // Seating and clearing a table is what opens and closes its ordering window.
  // A merged party is handled as one, so seating does not leave half of them
  // unable to order.
  async function setSeated(tableNumber, seated) {
    setSessionBusy(tableNumber);
    try {
      const group = tableGroupNumbers(tableNumber);
      if (group.length > 1) {
        await (seated ? openSessionsFor(restaurantId, group) : closeSessionsFor(restaurantId, group));
      } else {
        await (seated ? openTableSession(restaurantId, tableNumber) : closeTableSession(restaurantId, tableNumber));
      }
    } catch (e) {
      alert(e?.code === "permission-denied"
        ? "You do not have permission to seat tables at this outlet."
        : `Could not update the table: ${e.message}`);
    } finally {
      setSessionBusy(null);
    }
  }
  function printQr(tableNumber, token) {
    const link = `${siteUrl}/table?table=${tableNumber}&restaurant=${restaurantId}`;
    const imgUrl = qrUrlFor(tableNumber, token);
    const html = `
      <html><head><title>Table ${tableNumber} QR</title>
        <style>
          body { text-align: center; font-family: sans-serif; margin-top: 40px; color: #1a1a2e; }
          h2 { font-size: 24px; margin-bottom: 20px; }
          .qr-wrap { background: white; padding: 20px; border-radius: 16px; display: inline-block; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
          img { width: 260px; height: 260px; }
        </style>
      </head><body>
        <h2>Table ${tableNumber}</h2>
        <div class="qr-wrap"><img src="${imgUrl}" /></div>
        <script>window.onload = () => setTimeout(() => window.print(), 400);</script>
      </body></html>`;
    const win = window.open("", "_blank", "width=420,height=520");
    win.document.write(html);
    win.document.close();
  }

  // NEW: merge tables
  function startMerge(primaryTableId) { setMergeMode(true); setMergePrimary(primaryTableId); setMergeSelected([]); }
  function cancelMerge() { setMergeMode(false); setMergePrimary(null); setMergeSelected([]); }
  function toggleMergeSelect(tableId) {
    setMergeSelected((prev) => prev.includes(tableId) ? prev.filter((id) => id !== tableId) : [...prev, tableId]);
  }
  async function confirmMerge() {
    if (!mergePrimary || mergeSelected.length === 0) return alert("Select at least one table to merge in");
    const primary = tables.find((t) => t.id === mergePrimary);
    const groupId = `group_${primary.number}`;
    const involvedIds = [mergePrimary, ...mergeSelected];
    const involvedNumbers = tables.filter((t) => involvedIds.includes(t.id)).map((t) => t.number);
    const batch = writeBatch(db);
    involvedIds.forEach((id) => {
      const t = tables.find((tb) => tb.id === id);
      batch.update(doc(db, "restaurants", restaurantId, "tables", id), {
        mergedGroupId: groupId, mergedWith: involvedNumbers.filter((n) => n !== t.number), isMerged: true,
      });
    });
    await batch.commit();
    cancelMerge();
  }
  async function unmergeTable(t) {
    if (!t.mergedGroupId) return;
    const groupTables = tables.filter((tb) => tb.mergedGroupId === t.mergedGroupId);
    const batch = writeBatch(db);
    groupTables.forEach((tb) => batch.update(doc(db, "restaurants", restaurantId, "tables", tb.id), { mergedGroupId: null, mergedWith: [], isMerged: false }));
    await batch.commit();
  }

  // NEW: move / swap an order to a different table
  function openMoveOrder(order) { setMovingOrder(order); setMoveTargetTable(""); }
  async function confirmMoveOrder() {
    if (!movingOrder || !moveTargetTable) return;
    await updateDoc(doc(db, "restaurants", restaurantId, "orders", movingOrder.id), { table: parseInt(moveTargetTable, 10) || moveTargetTable });
    setMovingOrder(null);
  }

  // === staff ===
  // An invitation now carries the SCOPE of the grant — which brand, which
  // outlets, and who issued it — so the security rules can verify the inviter
  // actually held what they gave away. Without that, a manager of one outlet
  // could quietly add a colleague to another.




  // === BULK IMPORT FUNCTIONS ===
  // CSV/JSON parsing lives in lib/menu-import.js and is shared with the brand
  // console's master-menu importer. It used to exist twice, in two files, with
  // the quote-aware splitter — the fiddliest part — duplicated verbatim.
  const normalizeBool = truthy;
  const normalizeFoodType = (val) => normalizeFoodTypeShared(val, siteSettings.pureVeg);

  // Parsing lives in lib/menu-import.js with 13 tests: a missing category is
  // reported rather than defaulted, the failing row is named so the operator can
  // find it in their spreadsheet, and Pure Veg overrides whatever the file says.
  function parseImportData(text, format) {
    return parseImportRows(text, format, { pureVeg: siteSettings.pureVeg });
  }

  // === NEW: ZIP (CSV + photos) ===
  // extractZipEntries, uploadWithConcurrency and matchImageFile now live in
  // lib/menu-import.js, shared with the brand master-menu importer — this
  // used to be the one piece of the bulk importer that only existed here.
  async function handleZipFileSelected(file) {
    if (!file) return;
    setZipFile(file);
    setZipParsing(true);
    setImportPreview(null);
    setImportReport(null);
    try {
      const { csvText, imagesMap } = await extractZipEntries(file);
      setZipImages(imagesMap);
      const result = parseImportData(csvText, "csv");
      if (result.error) {
        setImportPreview({ error: result.error, items: [], categoriesNeeded: [], duplicates: [], valid: false });
        return;
      }
      finalizePreview(result.items, result.errors, imagesMap);
    } catch (err) {
      setImportPreview({ error: err.message, items: [], categoriesNeeded: [], duplicates: [], valid: false });
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
    a.download = "menu-import-template.zip";
    a.click();
    URL.revokeObjectURL(url);
  }

  function buildImportPreview() {
    if (!importText.trim()) { setImportPreview(null); return; }
    const result = parseImportData(importText, importFormat);
    if (result.error) {
      setImportPreview({ error: result.error, items: [], categoriesNeeded: [], duplicates: [], valid: false });
      return;
    }
    finalizePreview(result.items, result.errors, null);
  }

  // Shared by the CSV/JSON text path and the ZIP path — works out which
  // categories are new, which items are duplicates, and (when imagesMap is
  // provided, i.e. this came from a zip) whether each item's photo was found.
  function finalizePreview(items, errors, imagesMap) {
    const existingNames = new Set(menuItems.map((m) => m.name.toLowerCase()));
    const existingCategories = new Set(categories.map((c) => c.name));
    const categoriesNeeded = [];
    const duplicates = [];
    const imageStats = { matched: 0, missing: 0, urlOnly: 0, none: 0 };

    const itemsWithImageStatus = items.map((item) => {
      if (!existingCategories.has(item.category) && !categoriesNeeded.includes(item.category)) {
        categoriesNeeded.push(item.category);
      }
      if (existingNames.has(item.name.toLowerCase())) {
        duplicates.push(item.name);
      }

      let imageMatchStatus = "none";
      let zipEntry = null;
      if (imagesMap && item.imageFile) {
        zipEntry = matchImageFile(item.imageFile, imagesMap);
        imageMatchStatus = zipEntry ? "matched" : "missing";
      } else if (item.imageUrl) {
        imageMatchStatus = "url";
      }
      const statKey = imageMatchStatus === "matched" ? "matched" : imageMatchStatus === "missing" ? "missing" : imageMatchStatus === "url" ? "urlOnly" : "none";
      imageStats[statKey]++;

      return { ...item, imageMatchStatus, _zipEntry: zipEntry };
    });

    setImportPreview({
      items: itemsWithImageStatus,
      errors,
      categoriesNeeded,
      duplicates,
      valid: errors.length === 0,
      isZip: !!imagesMap,
      imageStats,
    });
  }

  // Plain CSV template — Name, Price, Category, Description, FoodType,
  // ChefSpecial, Featured, ImageUrl. ImageUrl here must already be a hosted
  // link (Cloudinary, imgur, etc.) — CSV alone has no way to attach local
  // photo files. Use the ZIP format if you want to upload local photos.
  function downloadTemplate() {
    const csv = `Name,Price,Category,Description,FoodType,ChefSpecial,Featured,ImageUrl,Variations,Addons,ETA,BOGO
Paneer Tikka,320,Starters,Cottage cheese marinated in spices,veg,no,no,,,,15,no
Margherita Pizza,320,Mains,Classic tomato and mozzarella,veg,no,yes,,"Small:220|Medium:320|Large:420","Extra Cheese:40|Extra Olives:30",20,no
Garlic Naan,80,Breads & Rice,Soft naan brushed with garlic butter,veg,no,no,,,,10,yes
Chocolate Lava Cake,220,Desserts,Warm cake with molten chocolate center,veg,no,yes,,,,12,no`;
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "menu-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // NEW: a real, dedicated JSON template — previously the Download Template
  // button ignored the active tab and always produced a .csv file, even on
  // the JSON tab. This is a proper JSON array matching what parseImportData
  // expects (name, price, category, description, foodType, chefSpecial,
  // featured, imageUrl).
  function downloadJsonTemplate() {
    const json = JSON.stringify([
      { name: "Paneer Tikka", price: 320, category: "Starters", description: "Cottage cheese marinated in spices", foodType: "veg", chefSpecial: false, featured: false, imageUrl: "" },
      {
        name: "Margherita Pizza", price: 320, category: "Mains", description: "Classic tomato and mozzarella", foodType: "veg", chefSpecial: false, featured: true, imageUrl: "",
        // One dish, one row — sizes and add-ons are a real array here (a
        // pipe-delimited string like the CSV format uses also works, but
        // there's no reason to flatten it when the format is already JSON).
        variations: [{ name: "Small", price: 220 }, { name: "Medium", price: 320 }, { name: "Large", price: 420 }],
        addons: [{ name: "Extra Cheese", price: 40 }, { name: "Extra Olives", price: 30 }],
        etaMinutes: 20,
      },
      { name: "Garlic Naan", price: 80, category: "Breads & Rice", description: "Soft naan brushed with garlic butter", foodType: "veg", chefSpecial: false, featured: false, imageUrl: "", etaMinutes: 10, bogoEnabled: true },
    ], null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "menu-template.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  // NEW: lets CSV/JSON tabs accept an actual uploaded file (not just paste),
  // reading its text content straight into the same textarea/preview flow.
  function handleTextFileSelected(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => { setImportText(e.target.result); setImportPreview(null); };
    reader.onerror = () => alert("Could not read that file.");
    reader.readAsText(file);
  }

  async function executeImport() {
    if (!importPreview || !importPreview.valid || importPreview.items.length === 0) return;
    if (!restaurantId) return;

    setImporting(true);
    setImportReport(null);
    setImportProgress({ done: 0, total: 0 });
    try {
      const existingNames = new Set(menuItems.map((m) => m.name.toLowerCase()));
      const itemsToImport = importPreview.items.filter((it) => !existingNames.has(it.name.toLowerCase()));

      // For zip imports: upload every matched photo to Cloudinary first (5 at a
      // time, continuously — see uploadWithConcurrency), then swap each item's
      // imageUrl for the real Cloudinary URL before writing anything to Firestore.
      let imagesUploaded = 0;
      let imagesFailed = 0;
      if (importPreview.isZip) {
        const toUpload = itemsToImport.filter((it) => it.imageMatchStatus === "matched" && it._zipEntry);
        setImportProgress({ done: 0, total: toUpload.length });
        const results = await uploadWithConcurrency(
          toUpload.map((it) => async () => {
            const blob = await it._zipEntry.async("blob");
            const file = new File([blob], it.imageFile || it.name, { type: blob.type || "image/jpeg" });
            try { return await uploadToCloudinary(file); }
            catch (err) { return await uploadToCloudinary(file); } // one retry
          }),
          5,
          (done, total) => setImportProgress({ done, total })
        );
        toUpload.forEach((it, i) => {
          const res = results[i];
          if (res && typeof res === "string") { it.imageUrl = res; imagesUploaded++; }
          else imagesFailed++;
        });
      }

      const menuCol = collection(db, "restaurants", restaurantId, "menuItems");
      const catCol = collection(db, "restaurants", restaurantId, "categories");
      const existingCats = new Set(categories.map((c) => c.name));
      const catsToCreate = importPreview.categoriesNeeded.filter((c) => !existingCats.has(c));

      // Firestore batches cap at 500 writes, so chunk in groups of 400 to stay
      // safely under that even for large imports.
      const CHUNK_SIZE = 400;
      let imported = 0;
      let firstChunk = true;
      for (let i = 0; i < itemsToImport.length || firstChunk; i += CHUNK_SIZE) {
        const chunkBatch = writeBatch(db);
        if (firstChunk) {
          catsToCreate.forEach((catName, idx) => {
            const ref = doc(catCol);
            chunkBatch.set(ref, { name: catName, imageUrl: "", order: categories.length + idx, createdAt: Date.now() });
          });
        }
        const chunkItems = itemsToImport.slice(i, i + CHUNK_SIZE);
        chunkItems.forEach((item) => {
          const { imageFile, imageMatchStatus, _zipEntry, ...cleanItem } = item;
          const ref = doc(menuCol);
          chunkBatch.set(ref, { ...cleanItem, createdAt: Date.now() });
          imported++;
        });
        await chunkBatch.commit();
        firstChunk = false;
        if (itemsToImport.length === 0) break;
      }

      setImportReport({
        imported,
        imagesUploaded,
        imagesMissing: importPreview.imageStats?.missing || 0,
        imagesFailed,
        invalidRows: importPreview.errors.length,
        duplicatesSkipped: importPreview.duplicates.length,
        categoriesCreated: catsToCreate.length,
      });
      setImporting(false);
      setImportText("");
      setImportPreview(null);
      setZipFile(null);
      setZipImages({});
    } catch (err) {
      setImporting(false);
      alert("Import failed: " + err.message);
    }
  }

  // === NEW: POS actions — now variation/add-on aware, same as the customer
  // table-side ordering flow. An item with no sizes and no add-ons still adds
  // straight to the cart with one tap; an item with either opens a picker.
  // Cart maths lives in lib/pos-cart.js: how a variation replaces the base
  // price rather than adding to it, how add-ons are sorted so pick order never
  // creates a duplicate line, and how quantities merge. 20 tests.
  function posItemHasOptions(item) { return itemHasOptions(item); }
  function posTapItem(item) {
    if (!itemHasOptions(item)) { posAddLine(item, null, [], 1); return; }
    setPosVariantModal({ item, variationId: item.variations?.[0]?.id || null, addonIds: [], qty: 1 });
  }
  function posAddLine(item, variationId, addonIds, qty) {
    setPosCart((p) => addLine(p, item, { variationId, addonIds: addonIds || [], qty }));
  }
  function posAdjustLineQty(key, delta) {
    setPosCart((p) => adjustLineQty(p, key, delta));
  }
  function posSimpleQtyFor(item) { return plainQtyForItem(posCart, item.id); }
  function posTotalQtyFor(item) { return qtyForItem(posCart, item.id); }
  function posCartLines() { return cartLines(posCart); }

  const posLines = posCartLines();
  const posSubtotal = cartSubtotal(posCart);
  const posDiscounts = computeBundleDiscounts(posLines, menuItems, bundleRules);
  const posDiscountTotal = posDiscounts.reduce((s, d) => s + d.amount, 0);

  async function posSendToKitchen() {
    if (posLines.length === 0) return alert("Add at least one item");
    if (posOrderType === "dinein" && !posTable) return alert("Select a table, or switch to Quick Order (takeaway)");
    setPosSending(true);
    try {
      await addDoc(collection(db, "restaurants", restaurantId, "orders"), {
        table: posOrderType === "takeaway" ? TAKEAWAY_TABLE : posTable,
        items: posLines.map((l) => ({ itemId: l.itemId, name: l.name, price: l.price, qty: l.qty })),
        status: "confirmed",
        orderType: posOrderType,
        notes: posNotes || "",
        createdAt: Date.now(),
      });
      setPosCart({}); setPosNotes(""); setPosTable(null);
      alert("Order sent to kitchen!");
    } catch (err) {
      alert("Failed to send order: " + err.message);
    } finally {
      setPosSending(false);
    }
  }

  // === ANALYTICS SUB-VIEWS ===
  // Analytics live in lib/analytics.js, tested against merged bills, empty
  // restaurants, and out-of-range orders. These wrappers just bind the data.
  function computeAnalytics(filterKey) {
    return computeAnalyticsPure({ orders, menuItems, filterKey });
  }

  // NEW: shared human-readable label for the analytics filter — used on the
  // Order History / Items Sold export & print reports so it's obvious which
  // date range the report covers.

  // === NEW: Order History — Export CSV + colour-highlighted Print report,
  // mirroring the Sales Analytics report but scoped to every order (not just
  // billed ones) in the currently selected date range.
  function exportOrdersHistoryCSV(filterKey) {
    const start = filterRangeStart(filterKey);
    // One row per bill, not one per table. See collapseBillSiblings.
    const list = collapseBillSiblings(orders.filter((o) => o.createdAt >= start))
      .sort((a, b) => b.createdAt - a.createdAt);
    const statusCounts = {};
    list.forEach((o) => { statusCounts[o.status] = (statusCounts[o.status] || 0) + 1; });
    const rows = [
      ["Order History Report", profile?.name || "", filterLabel(filterKey), new Date().toLocaleDateString()], [],
      ["SUMMARY"],
      ["Total Orders", list.length],
      ...Object.entries(statusCounts).map(([s, c]) => [`  · ${s.replace("_", " ")}`, c]),
      [],
      ["ORDER LOG"],
      ["Table", "Date/Time", "Status", "Type", "Items", "Total"],
      ...list.map((o) => [
        o.table, new Date(o.createdAt).toLocaleString(), o.status.replace("_", " "), o.orderType || "dinein",
        (o.items || []).map((it) => `${it.name} x${it.qty}`).join("; "), o.billTotal || "",
      ]),
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `order-history-${filterKey}-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  function printOrdersHistoryReport(filterKey) {
    const start = filterRangeStart(filterKey);
    // One row per bill, not one per table. See collapseBillSiblings.
    const list = collapseBillSiblings(orders.filter((o) => o.createdAt >= start))
      .sort((a, b) => b.createdAt - a.createdAt);
    const statusColors = { pending: "#f59e0b", confirmed: "#3b82f6", preparing: "#3b82f6", ready: "#3b82f6", served: "#6b7280", bill_requested: "#e8a33d", billed: "#8b5cf6", paid: "#16a34a", cancelled: "#dc2626", declined: "#dc2626" };
    const statusCounts = {};
    list.forEach((o) => { statusCounts[o.status] = (statusCounts[o.status] || 0) + 1; });
    const statusChipsHtml = Object.entries(statusCounts).map(([s, c]) => `<span class="chip" style="background:${(statusColors[s] || "#888")}18;color:${statusColors[s] || "#888"};border:1px solid ${(statusColors[s] || "#888")}55">${s.replace("_", " ")} · ${c}</span>`).join("");
    const rowsHtml = list.map((o) => `
      <tr>
        <td>${o.table}${o.isVIP ? ' <span class="vip">★ VIP</span>' : ""}</td>
        <td>${new Date(o.createdAt).toLocaleString()}</td>
        <td><span class="status" style="background:${(statusColors[o.status] || "#888")}18;color:${statusColors[o.status] || "#888"}">${o.status.replace("_", " ")}</span></td>
        <td>${o.orderType === "takeaway" ? "📦 Takeaway" : "Dine-in"}</td>
        <td>${(o.items || []).map((it) => `${it.name} x${it.qty}`).join(", ")}</td>
        <td style="text-align:right">${o.billTotal ? "₹" + o.billTotal.toLocaleString() : "-"}</td>
      </tr>`).join("");
    const html = `<html><head><title>Order History — ${filterLabel(filterKey)}</title>
      <style>
        body{font-family:'Inter',sans-serif;max-width:900px;margin:24px auto;color:#1a1a2e;}
        h1{font-size:22px;margin-bottom:2px;color:#3b82f6;} .sub{color:#888;font-size:12px;margin-bottom:20px;}
        .stats{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:18px;}
        .stat{background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px;}
        .stat .label{font-size:11px;color:#1e40af;text-transform:uppercase;font-weight:700;}
        .stat .value{font-size:22px;font-weight:800;margin-top:4px;color:#1e3a8a;}
        .chip{display:inline-block;padding:4px 10px;border-radius:100px;font-size:11px;font-weight:700;text-transform:capitalize;margin:0 6px 6px 0;}
        .status{padding:2px 9px;border-radius:100px;font-size:11px;font-weight:700;text-transform:capitalize;}
        .vip{color:#eab308;font-weight:800;}
        table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px;}
        th,td{border-bottom:1px solid #eee;padding:7px 8px;text-align:left;} th{background:#f8f6f3;color:#555;text-transform:uppercase;font-size:10.5px;letter-spacing:0.3px;}
        h3{font-size:14px;margin:18px 0 8px;}
      </style></head><body>
      <h1>📋 Order History Report</h1>
      <div class="sub">${profile?.name || "Restaurant"} · ${filterLabel(filterKey)} · Generated ${new Date().toLocaleString()}</div>
      <div class="stats">
        <div class="stat"><div class="label">Total Orders</div><div class="value">${list.length}</div></div>
        <div class="stat"><div class="label">Date Range</div><div class="value" style="font-size:16px">${filterLabel(filterKey)}</div></div>
      </div>
      <h3>By Status</h3>
      <div>${statusChipsHtml || "<span>No orders yet</span>"}</div>
      <h3>Order Log</h3>
      <table><thead><tr><th>Table</th><th>Date/Time</th><th>Status</th><th>Type</th><th>Items</th><th style="text-align:right">Total</th></tr></thead><tbody>${rowsHtml || '<tr><td colspan="6">No orders in this period</td></tr>'}</tbody></table>
      <script>window.onload=()=>window.print();</script></body></html>`;
    const win = window.open("", "_blank", "width=950,height=900");
    win.document.write(html); win.document.close();
  }

  // === NEW: Items Sold — Export CSV + colour-highlighted Print report.
  function exportItemsSoldCSV(filterKey) {
    const a = computeAnalytics(filterKey);
    const rows = [
      ["Items Sold Report", profile?.name || "", filterLabel(filterKey), new Date().toLocaleDateString()], [],
      ["SUMMARY"],
      ["Total Line Items Sold", a.topItems.reduce((s, [, qty]) => s + qty, 0)],
      ["Distinct Items", a.topItems.length],
      [],
      ["ITEM", "QTY SOLD"],
      ...a.topItems,
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a2 = document.createElement("a");
    a2.href = url; a2.download = `items-sold-${filterKey}-${new Date().toISOString().slice(0, 10)}.csv`; a2.click();
    URL.revokeObjectURL(url);
  }

  function printItemsSoldReport(filterKey) {
    const a = computeAnalytics(filterKey);
    const totalQty = a.topItems.reduce((s, [, qty]) => s + qty, 0);
    const maxQty = Math.max(...a.topItems.map(([, qty]) => qty), 1);
    const rowsHtml = a.topItems.map(([name, qty], i) => `
      <tr>
        <td><span class="rank">${i + 1}</span></td>
        <td>${name}</td>
        <td style="text-align:right;font-weight:800;color:#166534">${qty}</td>
        <td><div class="bar-track"><div class="bar" style="width:${Math.round((qty / maxQty) * 100)}%"></div></div></td>
      </tr>`).join("");
    const html = `<html><head><title>Items Sold — ${filterLabel(filterKey)}</title>
      <style>
        body{font-family:'Inter',sans-serif;max-width:820px;margin:24px auto;color:#1a1a2e;}
        h1{font-size:22px;margin-bottom:2px;color:#16a34a;} .sub{color:#888;font-size:12px;margin-bottom:20px;}
        .stats{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:20px;}
        .stat{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px;}
        .stat .label{font-size:11px;color:#166534;text-transform:uppercase;font-weight:700;}
        .stat .value{font-size:22px;font-weight:800;margin-top:4px;color:#14532d;}
        table{width:100%;border-collapse:collapse;font-size:13px;}
        th,td{border-bottom:1px solid #eee;padding:8px;text-align:left;vertical-align:middle;} th{background:#f8f6f3;color:#555;text-transform:uppercase;font-size:10.5px;}
        .rank{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#16a34a;color:#fff;font-size:11px;font-weight:800;}
        .bar-track{width:140px;height:8px;background:#eee;border-radius:100px;overflow:hidden;}
        .bar{height:100%;background:linear-gradient(90deg,#16a34a,#22c55e);border-radius:100px;}
      </style></head><body>
      <h1>🍽️ Items Sold Report</h1>
      <div class="sub">${profile?.name || "Restaurant"} · ${filterLabel(filterKey)} · Generated ${new Date().toLocaleString()}</div>
      <div class="stats">
        <div class="stat"><div class="label">Total Units Sold</div><div class="value">${totalQty}</div></div>
        <div class="stat"><div class="label">Distinct Items</div><div class="value">${a.topItems.length}</div></div>
      </div>
      <table><thead><tr><th>#</th><th>Item</th><th style="text-align:right">Qty Sold</th><th>Share</th></tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="4">No items sold in this period</td></tr>'}</tbody></table>
      <script>window.onload=()=>window.print();</script></body></html>`;
    const win = window.open("", "_blank", "width=900,height=900");
    win.document.write(html); win.document.close();
  }

  // === NEW: Daily Report export (CSV + printable PDF) ===
  function buildTodayReportData() {
    return buildTodayReport({ orders, menuItems });
  }

  function exportTodayCSV() {
    const d = buildTodayReportData();
    const rows = [
      ["Daily Report", profile?.name || "", new Date().toLocaleDateString()], [],
      ["SUMMARY"],
      ["Total Sales", d.totalSales], ["Orders Billed", d.billedToday.length],
      ["Avg Order Value", d.avgOrderValue], ["Total Discounts Given", d.totalDiscounts],
      ["Total Tax Collected", d.totalTax], ["Total Service Charge", d.totalService],
      ["Peak Hour", `${d.peakHour}:00`], [],
      ["PAYMENT METHOD BREAKDOWN", "Amount"],
      ...Object.entries(d.paymentBreakdown), [],
      ["TOP ITEMS", "Qty Sold"], ...d.topItems, [],
      ["ORDER LOG"],
      ["Table", "Time", "Status", "Items", "Customer", "Phone", "Payment", "Subtotal", "Discounts", "Tax", "Service", "Total"],
      ...d.todays.map((o) => [
        o.table, new Date(o.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        o.status, (o.items || []).map((it) => `${it.name} x${it.qty}`).join("; "),
        customerFor(o).name, customerFor(o).phone, o.paymentMethod || "",
        o.billSubtotal || "", o.billDiscountTotal || 0, o.billTaxAmount || 0, o.billServiceAmount || 0, o.billTotal || "",
      ]),
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `daily-report-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  function printTodayReport() {
    const d = buildTodayReportData();
    const topItemsHtml = d.topItems.map(([name, qty], i) => `<tr><td>${i + 1}</td><td>${name}</td><td style="text-align:right">${qty}</td></tr>`).join("");
    const paymentHtml = Object.entries(d.paymentBreakdown).map(([m, amt]) => `<tr><td style="text-transform:capitalize">${m}</td><td style="text-align:right">₹${amt.toLocaleString()}</td></tr>`).join("");
    const ordersHtml = d.todays.map((o) => `
      <tr><td>${o.table}</td><td>${new Date(o.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
      <td>${o.status.replace("_", " ")}</td><td>${(o.items || []).map((it) => `${it.name} x${it.qty}`).join(", ")}</td>
      <td>${customerFor(o).name || customerFor(o).phone ? `${customerFor(o).name} ${customerFor(o).phone}` : "-"}</td>
      <td style="text-transform:capitalize">${o.paymentMethod || "-"}</td>
      <td style="text-align:right">${o.billTotal ? "₹" + o.billTotal : "-"}</td></tr>`).join("");
    const html = `<html><head><title>Daily Report — ${new Date().toLocaleDateString()}</title>
      <style>
        body{font-family:'Inter',sans-serif;max-width:820px;margin:24px auto;color:#1a1a2e;}
        h1{font-size:22px;margin-bottom:2px;} .sub{color:#888;font-size:12px;margin-bottom:20px;}
        .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px;}
        .stat{background:#fff7e6;border:1px solid #fde68a;border-radius:10px;padding:12px;}
        .stat .label{font-size:11px;color:#92400e;text-transform:uppercase;font-weight:700;}
        .stat .value{font-size:20px;font-weight:800;margin-top:4px;}
        table{width:100%;border-collapse:collapse;margin-bottom:24px;font-size:12px;}
        th,td{border-bottom:1px solid #eee;padding:6px 8px;text-align:left;} th{background:#f8f6f3;}
        h3{font-size:14px;margin:18px 0 8px;}
        .cols{display:grid;grid-template-columns:1fr 1fr;gap:24px;}
      </style></head><body>
      <h1>${profile?.name || "Restaurant"} — Daily Report</h1>
      <div class="sub">${new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</div>
      <div class="stats">
        <div class="stat"><div class="label">Total Sales</div><div class="value">₹${d.totalSales.toLocaleString()}</div></div>
        <div class="stat"><div class="label">Orders Billed</div><div class="value">${d.billedToday.length}</div></div>
        <div class="stat"><div class="label">Avg Order Value</div><div class="value">₹${d.avgOrderValue}</div></div>
        <div class="stat"><div class="label">Discounts Given</div><div class="value">₹${d.totalDiscounts.toLocaleString()}</div></div>
        <div class="stat"><div class="label">Tax Collected</div><div class="value">₹${d.totalTax.toLocaleString()}</div></div>
        <div class="stat"><div class="label">Peak Hour</div><div class="value">${d.peakHour}:00</div></div>
      </div>
      <div class="cols">
        <div><h3>Top Selling Items</h3>
        <table><thead><tr><th>#</th><th>Item</th><th style="text-align:right">Qty</th></tr></thead><tbody>${topItemsHtml || "<tr><td colspan=3>No sales yet</td></tr>"}</tbody></table></div>
        <div><h3>Payment Methods</h3>
        <table><thead><tr><th>Method</th><th style="text-align:right">Amount</th></tr></thead><tbody>${paymentHtml || "<tr><td colspan=2>No paid orders yet</td></tr>"}</tbody></table></div>
      </div>
      <h3>Order Log</h3>
      <table><thead><tr><th>Table</th><th>Time</th><th>Status</th><th>Items</th><th>Customer</th><th>Payment</th><th style="text-align:right">Total</th></tr></thead><tbody>${ordersHtml}</tbody></table>
      <script>window.onload=()=>window.print();</script></body></html>`;
    const win = window.open("", "_blank", "width=900,height=900");
    win.document.write(html); win.document.close();
  }

  // === NEW: CRM export ===


  function renderAnalyticsFilterBar() {
    const opts = [["today", "Today"], ["3days", "Last 3 Days"], ["week", "Last Week"], ["month", "Last Month"]];
    return (
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {opts.map(([key, label]) => (
          <button key={key} onClick={() => setAnalyticsFilter(key)}
            style={{ padding: "8px 16px", borderRadius: 100, border: "none", fontSize: 13, fontWeight: 700, cursor: "pointer", background: analyticsFilter === key ? "#1a1a2e" : "var(--surface-2, #f3efe6)", color: analyticsFilter === key ? "#fff" : "#666" }}>
            {label}
          </button>
        ))}
      </div>
    );
  }

  function renderSalesAnalytics() {
    const a = computeAnalytics(analyticsFilter);
    const maxBucket = Math.max(...a.hourBuckets, 1);
    return (
      <div>
        <button onClick={() => setDashboardView("main")} style={{ background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 13, fontWeight: 600, marginBottom: 16 }}>← Back to dashboard</button>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
          <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Sales Analytics</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-ghost" onClick={exportTodayCSV}>⬇ Export Today (CSV / Excel)</button>
            <button className="btn btn-primary" onClick={printTodayReport}>🖨 Print / Save PDF</button>
          </div>
        </div>
        {renderAnalyticsFilterBar()}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px,1fr))", gap: 14, marginBottom: 28 }}>
          <StatCard label="Total Sales" value={`₹${a.totalSales.toLocaleString()}`} color="#16a34a" />
          <StatCard label="Orders" value={a.orderCount} color="#3b82f6" />
          <StatCard label="Avg Order Value" value={`₹${a.avg}`} color="#e8a33d" />
          <StatCard label="Peak Hour" value={`${a.peakHour}:00`} color="#8b5cf6" sub="Most orders placed" />
        </div>
        <div className="card" style={{ padding: 20, borderRadius: 16, marginBottom: 20 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Orders by Hour</h3>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 120 }}>
            {a.hourBuckets.map((v, h) => (
              <div key={h} title={`${h}:00 — ${v} orders`} style={{ flex: 1, background: h === a.peakHour ? "#e8a33d" : "#f0ebe3", height: `${(v / maxBucket) * 100}%`, minHeight: 2, borderRadius: 2 }} />
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#999", marginTop: 6 }}>
            <span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span>
          </div>
        </div>
        <div className="card" style={{ padding: 20, borderRadius: 16 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Top Selling Items</h3>
          {a.topItems.length === 0 ? <p style={{ color: "#999", fontSize: 13 }}>No sales in this period.</p> : a.topItems.map(([name, qty]) => (
            <div key={name} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #f4f4f4", fontSize: 14 }}>
              <span>{name}</span><span style={{ fontWeight: 700 }}>{qty} sold</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderOrdersHistory() {
    const start = filterRangeStart(analyticsFilter);
    // One row per bill, not one per table. See collapseBillSiblings.
    const list = collapseBillSiblings(orders.filter((o) => o.createdAt >= start))
      .sort((a, b) => b.createdAt - a.createdAt);
    return (
      <div>
        <button onClick={() => setDashboardView("main")} style={{ background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 13, fontWeight: 600, marginBottom: 16 }}>← Back to dashboard</button>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
          <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Order History</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => exportOrdersHistoryCSV(analyticsFilter)}>⬇ Export ({filterLabel(analyticsFilter)})</button>
            <button className="btn btn-primary" onClick={() => printOrdersHistoryReport(analyticsFilter)}>🖨 Print / Save PDF</button>
          </div>
        </div>
        {renderAnalyticsFilterBar()}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px,1fr))", gap: 14, marginBottom: 20 }}>
          <StatCard label="Total Orders" value={list.length} color="#3b82f6" sub={filterLabel(analyticsFilter)} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {list.length === 0 && <p style={{ color: "#999" }}>No orders in this period.</p>}
          {list.map((o) => (
            <div key={o.id} className="card" style={{ padding: 16, borderRadius: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontWeight: 700 }}>
                  Table {orderTableLabel(o)}
                  {isMergedTable(o.table) && (
                    <span title={`Merged party across tables ${tableGroupNumbers(o.table).join(", ")} — ordered from table ${o.table}`}
                      style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, padding: "2px 6px", borderRadius: 5, background: "#ede9fe", color: "#6d28d9", verticalAlign: "middle" }}>
                      ⇄ MERGED · from T{o.table}
                    </span>
                  )}
                  {o.isVIP && <span style={{ color: "#eab308" }}> ★</span>} {o.orderType === "takeaway" && <span style={{ color: "#8b5cf6" }}>📦</span>}
                </span>
                <span style={{ fontSize: 12, color: "#888" }}>{new Date(o.createdAt).toLocaleString()}</span>
              </div>
              {o.items.map((it, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "2px 0" }}>
                  <span>{it.name} ×{it.qty}{it.spiceLevel ? ` (${it.spiceLevel})` : ""}{it.notes ? ` — "${it.notes}"` : ""}</span>
                  <span>₹{it.price * it.qty}</span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, paddingTop: 8, borderTop: "1px dashed #eee", fontSize: 12.5 }}>
                <span style={{ textTransform: "capitalize", color: "#888" }}>{o.status.replace("_", " ")}</span>
                {o.billTotal && <span style={{ fontWeight: 700 }}>₹{o.billTotal}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderItemsSoldAnalytics() {
    const a = computeAnalytics(analyticsFilter);
    const prevFilterMap = { today: "3days", "3days": "week", week: "month", month: "month" };
    const prior = computeAnalytics(prevFilterMap[analyticsFilter]);
    const priorCounts = {};
    prior.inRange.forEach((o) => o.items.forEach((it) => { priorCounts[it.name] = (priorCounts[it.name] || 0) + it.qty; }));
    return (
      <div>
        <button onClick={() => setDashboardView("main")} style={{ background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 13, fontWeight: 600, marginBottom: 16 }}>← Back to dashboard</button>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
          <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Items Sold</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => exportItemsSoldCSV(analyticsFilter)}>⬇ Export ({filterLabel(analyticsFilter)})</button>
            <button className="btn btn-primary" onClick={() => printItemsSoldReport(analyticsFilter)}>🖨 Print / Save PDF</button>
          </div>
        </div>
        {renderAnalyticsFilterBar()}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px,1fr))", gap: 14, marginBottom: 20 }}>
          <StatCard label="Total Units Sold" value={a.topItems.reduce((s, [, qty]) => s + qty, 0)} color="#16a34a" sub={filterLabel(analyticsFilter)} />
        </div>
        <div className="card" style={{ padding: 20, borderRadius: 16 }}>
          {a.topItems.length === 0 ? <p style={{ color: "#999" }}>No items sold in this period.</p> : a.topItems.map(([name, qty]) => {
            const priorQty = priorCounts[name] || 0;
            const trend = qty - priorQty;
            return (
              <div key={name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #f4f4f4" }}>
                <span style={{ fontSize: 14 }}>{name}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontWeight: 700 }}>{qty}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: trend >= 0 ? "#16a34a" : "#dc2626" }}>{trend >= 0 ? "▲" : "▼"} {Math.abs(trend)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // === NEW: RENDER CRM ===
  const renderCRM = () => (
    <CrmSection customers={customers} restaurantName={profile?.name || ""} />
  );

  // Runs a batch of kitchen transitions and surfaces the first real failure.
  // A transition that returns false lost a race to another screen, which is a
  // normal outcome and not worth telling anyone about.
  async function runKds(actions) {
    setKdsError("");
    try {
      await Promise.all(actions.map((fn) => fn()));
    } catch (e) {
      setKdsError(e?.code === "permission-denied"
        ? "You do not have permission to change orders at this outlet."
        : `Could not update the kitchen (${e?.code || e.message}).`);
    }
  }

  const renderKitchenView = () => {
    const cols = [
      { key: "confirmed", label: "Waiting to start", tint: "#fef3c7", ink: "#92400e", list: orders.filter((o) => o.status === "confirmed") },
      { key: "preparing", label: "On the stove", tint: "#dbeafe", ink: "#1e40af", list: orders.filter((o) => o.status === "preparing") },
      { key: "ready", label: "Ready for pickup", tint: "#dcfce7", ink: "#166534", list: orders.filter((o) => o.status === "ready") },
    ];
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 8 }}>
          <h2 style={{ fontSize: 24, fontWeight: 800, margin: 0, fontFamily: "'Fraunces', serif" }}>Kitchen</h2>
          <a href="/kitchen" target="_blank" rel="noopener noreferrer" className="btn btn-ghost" style={{ textDecoration: "none" }}>
            Open full kitchen screen ↗
          </a>
        </div>
        <p style={{ fontSize: 13, color: "var(--text-secondary, #6b6b7b)", marginTop: 0, marginBottom: 16 }}>
          Live from the kitchen, and you can drive it from here. Orders start cooking on their
          own while fewer than {MAX_CONCURRENT_PREPARING} are on the stove; below you can start
          one early, adjust its timer, or mark it ready.
        </p>
        {kdsError && (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", padding: 12, borderRadius: 10, marginBottom: 14, fontSize: 13 }}>
            {kdsError}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: 14 }}>
          {cols.map((c) => (
            <div key={c.key}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 14px", borderRadius: 12, background: c.tint, color: c.ink, fontWeight: 800, fontSize: 13, marginBottom: 10 }}>
                <span>{c.label}</span><span>{c.list.length}</span>
              </div>
              {c.list.length === 0 ? (
                <div style={{ padding: 22, textAlign: "center", color: "var(--text-secondary, #6b6b7b)", fontSize: 13 }}>Nothing here.</div>
              ) : collapseMergedGroups(c.list).map((g) => (
                <div key={g.key} className="card" style={{ padding: 14, borderRadius: 12, marginBottom: 10, borderLeft: g.rep.isVIP ? "4px solid #eab308" : undefined }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 13.5, display: "flex", alignItems: "center", gap: 6 }}>
                      {isDelivery(g.rep) ? (
                        <>
                          {/* Delivery must never look like takeaway on a kitchen
                              ticket: one is collected at the counter, the other
                              leaves with a rider, and packing them the same way
                              is how cold food goes out. */}
                          <span style={{ background: orderTypeMeta("delivery").bg, color: orderTypeMeta("delivery").color, fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 100 }}>
                            🛵 DELIVERY
                          </span>
                          {deliveryDetails[g.rep.id]?.name || ""}
                        </>
                      ) : g.rep.orderType === "takeaway" ? (
                        <span style={{ background: orderTypeMeta("takeaway").bg, color: orderTypeMeta("takeaway").color, fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 100 }}>
                          📦 TAKEAWAY
                        </span>
                      ) : g.tables.length > 1 ? `Tables ${g.tables.join(" + ")}` : `Table ${g.rep.table}`}
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary, #6b6b7b)" }}>
                      {new Date(g.rep.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  {g.rep.items.map((it, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "2px 0" }}>
                      <span>{it.name}{it.spiceLevel ? ` · ${it.spiceLevel}` : ""}</span>
                      <span style={{ color: "var(--text-secondary, #6b6b7b)" }}>×{it.qty}</span>
                    </div>
                  ))}
                  {g.rep.status === "preparing" && getCountdown(g.rep) && (
                    <div style={{ marginTop: 8, fontFamily: "monospace", fontSize: 15, color: "#C1440E", fontWeight: 700 }}>⏱ {getCountdown(g.rep)}</div>
                  )}

                  {/* Actions apply to every order in a merged party, so one
                      click moves the whole table rather than half of it. */}
                  {c.key === "confirmed" && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                      {ETA_PRESETS.map((m) => (
                        <button key={m} className="btn btn-sm" style={{ flex: "1 1 52px", padding: "6px 8px", fontSize: 12 }}
                          onClick={() => runKds(g.orders.map((o) => () => kdsStart(restaurantId, o.id, m)))}>
                          {m}m
                        </button>
                      ))}
                    </div>
                  )}
                  {c.key === "preparing" && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                      <button className="btn btn-sm" style={{ padding: "6px 10px", fontSize: 12 }}
                        onClick={() => runKds(g.orders.map((o) => () => kdsAdjustEta(restaurantId, o.id, o.etaMinutes, -5)))}>−5m</button>
                      <button className="btn btn-sm" style={{ padding: "6px 10px", fontSize: 12 }}
                        onClick={() => runKds(g.orders.map((o) => () => kdsAdjustEta(restaurantId, o.id, o.etaMinutes, 5)))}>+5m</button>
                      <button className="btn btn-sm btn-primary" style={{ flex: 1, padding: "6px 10px", fontSize: 12 }}
                        onClick={() => runKds(g.orders.map((o) => () => kdsReady(restaurantId, o.id)))}>Mark ready</button>
                      <button className="btn btn-sm" style={{ padding: "6px 10px", fontSize: 12, color: "#888" }}
                        title="Started by mistake — put it back in the queue"
                        onClick={() => runKds(g.orders.map((o) => () => kdsReturn(restaurantId, o.id)))}>↩</button>
                    </div>
                  )}
                  {c.key === "ready" && (
                    <button className="btn btn-sm btn-success" style={{ width: "100%", marginTop: 10, padding: "6px 10px", fontSize: 12 }}
                      onClick={() => g.orders.forEach((o) => markServed(o.id))}>Mark as Served</button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  };

  // Auto-start also runs here, not only on the kitchen screen.
  //
  // It used to live solely in /kitchen, so if nobody had that screen open —
  // which is most of the time in a small restaurant, where the manager is
  // watching from reception — orders simply sat in "Waiting to start" and the
  // queue never drained. Both screens now drive it, and startCooking is a
  // transaction, so when both are open only one wins and the other is a no-op.
  useEffect(() => {
    if (!restaurantId || !ordersLoaded) return;
    const confirmedList = orders.filter((o) => o.status === "confirmed");
    const preparingCount = orders.filter((o) => o.status === "preparing").length;
    if (confirmedList.length === 0) return;
    autoStartNext(restaurantId, {
      confirmed: confirmedList,
      preparingCount,
      skipIds: [...kdsFailedRef.current],
    }).catch((e) => {
      // A denial will not fix itself; retrying it forever just hammers
      // Firestore and fills the console.
      if (["permission-denied", "not-found", "invalid-argument"].includes(e?.code)) {
        const front = confirmedList[0];
        if (front) kdsFailedRef.current.add(front.id);
      }
      console.error("Auto-start from POS failed:", e?.code || e.message);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId, ordersLoaded,
      orders.filter((o) => o.status === "preparing").length,
      orders.filter((o) => o.status === "confirmed")[0]?.id]);

  // === RENDER: DASHBOARD ===
  const renderDashboard = () => {
    if (dashboardView === "sales") return renderSalesAnalytics();
    if (dashboardView === "orders") return renderOrdersHistory();
    if (dashboardView === "items") return renderItemsSoldAnalytics();

    const currentSection = ORDER_SECTIONS.find((s) => s.key === orderFilter);
    // Keep a merged party's orders adjacent in the list, so the two halves of
    // one table's order don't end up separated by three unrelated tables.
    // One card per PARTY, not per order. A merged table is one group of guests
    // eating together and paying once, so two cards for tables 1 and 2 is both
    // wrong on the floor and how they end up with two bills.
    const groups = collapseMergedGroups(orderDataByKey[orderFilter] || []);

    // Billed rows carry the consolidated bill on every sibling (so each table's
    // own device can display it), so a group must show exactly one of them.
    const billedTableLabels = {};
    if (orderFilter === "billed") {
      groups.forEach((g) => {
        const tableNumbers = g.rep.mergedTables?.length ? g.rep.mergedTables : g.tables;
        billedTableLabels[g.raw.id] = [...new Set(tableNumbers)].join(" + ");
      });
    }
    const currentData = groups;

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, gap: 12 }}>
        <div>
         <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 2, fontFamily: "'Fraunces', serif" }}>Today at {profile?.name || "your restaurant"}</h2>
        <p style={{ fontSize: 13.5, color: "var(--text-secondary, #6b6b7b)", margin: 0 }}>{new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
        </div>

        <div style={{ position: "relative", flexShrink: 0 }}>
          <button
          onClick={() => setShowWaiterPopover((s) => !s)}
          style={{ width: 46, height: 46, borderRadius: "50%", border: "none", background: "#1a1a2e", color: "#fff", fontSize: 20, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", position: "relative", boxShadow: "0 2px 10px rgba(26,26,46,0.25)" }}
          >
          🛎️
          {pendingWaiterCalls.length > 0 && (
           <span style={{ position: "absolute", top: -4, right: -4, background: "#dc2626", color: "#fff", fontSize: 10.5, fontWeight: 800, minWidth: 19, height: 19, borderRadius: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px", border: "2px solid var(--bg, #faf8f2)" }}>
           {pendingWaiterCalls.length}
           </span>
          )}
         </button>

         {showWaiterPopover && (
          <>
           <div onClick={() => setShowWaiterPopover(false)} style={{ position: "fixed", inset: 0, zIndex: 59 }} />
            <div style={{ position: "absolute", top: "calc(100% + 10px)", right: 0, width: 320, maxHeight: 420, overflowY: "auto", background: "var(--surface, #fff)", borderRadius: 16, boxShadow: "0 12px 40px rgba(0,0,0,0.18)", border: "1px solid var(--border, #e6e1d6)", zIndex: 60 }}>
              <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border, #e6e1d6)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
               <h3 style={{ fontSize: 14.5, fontWeight: 800, margin: 0 }}>🛎️ Waiter Calls</h3>
               <button onClick={() => setShowWaiterPopover(false)} style={{ background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 16 }}>✕</button>
              </div>
              <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
               {waiterCalls.length === 0 ? (
                <p style={{ fontSize: 13, color: "#999", textAlign: "center", padding: "24px 0" }}>No waiter calls yet.</p>
                 ) : waiterCalls.slice(0, 15).map((c) => {
                const reason = WAITER_REASONS.find((r) => r.label === c.reason) || { icon: "✋", label: c.reason };
                 return (
                   <div key={c.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderRadius: 10, background: c.status === "pending" ? "#fef2f2" : "var(--surface-2, #f3efe6)" }}>
                     <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                       <span style={{ fontSize: 18 }}>{reason.icon}</span>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>Table {c.table} — {reason.label}</div>
                         <div style={{ fontSize: 11, color: "#888" }}>{new Date(c.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                        </div>
                        </div>
                        {c.status === "pending" ? (
                        <button className="btn btn-sm btn-primary" onClick={() => acknowledgeWaiterCall(c.id)}>Ack</button>
                        ) : (
                          <button className="btn btn-sm btn-ghost" onClick={() => dismissWaiterCall(c.id)}>✕</button>
                        )}
                      </div>
                    );
                  })}
               </div>
              </div>
            </>
          )}
           </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 14, marginBottom: 24 }}>
          <StatCard label="Today's Sales" value={`₹${todaySales.toLocaleString()}`} color="#16a34a" sub={`Avg ₹${avgOrderValue}/order`} onClick={() => { setDashboardView("sales"); setAnalyticsFilter("today"); }} />
          <StatCard label="Orders Today" value={todayOrderCount} color="#3b82f6" onClick={() => { setDashboardView("orders"); setAnalyticsFilter("today"); }} />
          <StatCard label="Items Sold" value={todayItemsSold} color="#e8a33d" onClick={() => { setDashboardView("items"); setAnalyticsFilter("today"); }} />
          <StatCard label="Needs Attention" value={pending.length + billRequested.length + pendingWaiterCalls.length} color="#dc2626" sub={pending.length + billRequested.length + pendingWaiterCalls.length > 0 ? "Action needed now" : "All caught up"} onClick={() => setOrderFilter(pending.length > 0 ? "pending" : "billRequested")} />
        </div>

        <div className="card" style={{ borderRadius: 18, overflow: "hidden" }}>
          <div style={{ padding: "18px 20px 0" }}>
            <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>Live Orders</h3>
            <p style={{ fontSize: 12.5, color: "var(--text-secondary, #6b6b7b)", margin: "3px 0 16px" }}>Every stage of service, with one-tap actions.</p>
          </div>

          <div style={{ display: "flex", gap: 6, overflowX: "auto", padding: "0 20px 14px", borderBottom: "1px solid var(--border, #e6e1d6)" }}>
            {ORDER_SECTIONS.map((section) => {
              const count = orderDataByKey[section.key].length;
              const isActive = orderFilter === section.key;
              return (
                <button key={section.key} onClick={() => setOrderFilter(section.key)}
                  style={{ padding: "10px 16px", borderRadius: 10, border: "none", background: isActive ? section.color : "var(--surface-2, #f3efe6)", color: isActive ? "#fff" : "var(--text-secondary, #6b6b7b)", fontSize: 13.5, fontWeight: 700, whiteSpace: "nowrap", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, transition: "all 0.15s ease", marginBottom: 6 }}>
                  {section.label}
                  {count > 0 && <span style={{ background: isActive ? "rgba(255,255,255,0.25)" : section.color + "22", color: isActive ? "#fff" : section.color, padding: "1px 8px", borderRadius: 100, fontSize: 11.5, fontWeight: 800 }}>{count}</span>}
                </button>
              );
            })}
          </div>

          <div style={{ padding: 20 }}>
            {currentData.length === 0 ? (
              <div style={{ padding: 44, textAlign: "center", color: "var(--text-secondary, #6b6b7b)" }}>
                <div style={{ fontSize: 38, marginBottom: 10 }}>{currentSection.emptyIcon}</div>
                <p style={{ margin: 0, fontSize: 14 }}>{currentSection.emptyMsg}</p>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
                {/* Actions apply to every order in the party, so confirming a
                    merged table sends all of it to the kitchen at once. */}
                {orderFilter === "pending" && currentData.map((g) => (
                  <OrderCard key={g.key} order={g.rep} groupTables={g.tables} delivery={deliveryDetails[g.rep.id]} rider={riderAssignments[g.rep.id]}>
                    <button className="btn btn-sm btn-danger" style={{ flex: 1 }}
                      onClick={() => g.orders.forEach((o) => declineOrder(o.id))}>Decline</button>
                    <button className="btn btn-sm btn-primary" style={{ flex: 1 }}
                      onClick={() => g.orders.forEach((o) => confirmOrder(o.id))}>Confirm → Kitchen</button>
                  </OrderCard>
                ))}
                {orderFilter === "active" && currentData.map((g) => (
                  <OrderCard key={g.key} order={g.rep} groupTables={g.tables} delivery={deliveryDetails[g.rep.id]} rider={riderAssignments[g.rep.id]} onMoveClick={g.tables.length > 1 ? undefined : openMoveOrder}>
                    {nextDeliveryAction(g.rep) === "dispatch" ? (
                      <button className="btn btn-sm btn-primary" style={{ width: "100%" }}
                        onClick={() => { setDispatchOrder(g.rep); setSelectedRiderId(""); setRiderErrors({}); }}>
                        🛵 Hand to rider
                      </button>
                    ) : nextDeliveryAction(g.rep) === "deliver" ? (
                      <>
                        {/* The bill exists from the moment the rider took it,
                            so it can be reprinted for the bag or the customer
                            without waiting for the order to be settled. */}
                        {g.rep.billId && (
                          <button className="btn btn-sm btn-ghost" style={{ flex: 1 }}
                            onClick={() => printBill(g.rep)}>
                            🖨 Bill
                          </button>
                        )}
                        <button className="btn btn-sm btn-success" style={{ flex: 2 }}
                          onClick={() => markDelivered(g.rep)}>
                          ✓ Mark delivered
                        </button>
                      </>
                    ) : g.orders.some((o) => o.status === "ready") ? (
                      <button className="btn btn-sm btn-success" style={{ width: "100%" }}
                        onClick={() => g.orders.filter((o) => o.status === "ready").forEach((o) => markServed(o.id))}>
                        Mark as Served
                      </button>
                    ) : (
                      <div style={{ fontSize: 12, color: "var(--text-secondary, #6b6b7b)", width: "100%", textAlign: "center" }}>Managed from the kitchen screen</div>
                    )}
                  </OrderCard>
                ))}
                {orderFilter === "served" && currentData.map((g) => (
                  <OrderCard key={g.key} order={g.rep} groupTables={g.tables} delivery={deliveryDetails[g.rep.id]} rider={riderAssignments[g.rep.id]}>
                    <button className="btn btn-sm btn-primary" onClick={() => openGenerateBill(g.rep)} style={{ flex: 1 }}>
                      Generate {g.tables.length > 1 ? "one bill" : "Bill"}
                    </button>
                  </OrderCard>
                ))}
                {orderFilter === "billRequested" && currentData.map((g) => (
                  <OrderCard key={g.key} order={g.rep} groupTables={g.tables} delivery={deliveryDetails[g.rep.id]} rider={riderAssignments[g.rep.id]}>
                    <button className="btn btn-sm btn-primary" onClick={() => openGenerateBill(g.rep)} style={{ flex: 1 }}>
                      Generate {g.tables.length > 1 ? "one bill" : "Bill"}
                    </button>
                  </OrderCard>
                ))}
                {orderFilter === "billed" && currentData.map(({ raw: o }) => (
                  <div key={o.id} className="card" style={{ padding: 16, borderRadius: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <span style={{ fontWeight: 700 }}>
                        Table {billedTableLabels[o.id] || orderTableLabel(o)}
                      </span>
                      <span className="badge badge-billed">billed</span>
                    </div>
                    {(customerFor(o).name || customerFor(o).phone || o.paymentMethod) && (
                      <div style={{ fontSize: 11.5, color: "#888", marginBottom: 8, display: "flex", gap: 10, flexWrap: "wrap" }}>
                        {(customerFor(o).name || customerFor(o).phone) && <span>👤 {customerFor(o).name} {customerFor(o).phone ? `· ${customerFor(o).phone}` : ""}</span>}
                        {o.paymentMethod && <span style={{ textTransform: "capitalize" }}>💳 {o.paymentMethod}</span>}
                      </div>
                    )}
                    {o.items.map((it, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, padding: "3px 0" }}>
                        <span>{it.name} ×{it.qty}</span><span>₹{it.price * it.qty}</span>
                      </div>
                    ))}
                    {o.billDiscounts && o.billDiscounts.length > 0 && o.billDiscounts.map((d, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "2px 0", color: "#16a34a" }}>
                        <span>{d.name}</span><span>-₹{d.amount}</span>
                      </div>
                    ))}
                    <div style={{ borderTop: "1px dashed var(--border, #e6e1d6)", marginTop: 10, paddingTop: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 16 }}><span>Total</span><span>₹{o.billTotal}</span></div>
                    </div>

                    {o.upiPayLink && (
                      <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: "#eff6ff", border: "1px solid #dbeafe", textAlign: "center" }}>
                        <div style={{ fontSize: 11.5, fontWeight: 800, color: "#1e40af", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>Customer Self-Pay (UPI)</div>
                        <img src={o.paymentQrUrl} alt="Scan to pay" style={{ width: 120, height: 120, marginBottom: 8, borderRadius: 8, background: "#fff" }} />
                        <div style={{ display: "flex", gap: 6 }}>
                          <a href={o.upiPayLink} className="btn btn-sm btn-primary" style={{ flex: 1, textDecoration: "none" }}>Open in UPI App</a>
                          <button className="btn btn-sm btn-ghost" onClick={() => { navigator.clipboard.writeText(o.upiPayLink); alert("Payment link copied"); }}>Copy Link</button>
                        </div>
                        <div style={{ fontSize: 10.5, color: "#64748b", marginTop: 6 }}>Scan or tap to pay — then confirm below once it lands in your UPI app.</div>
                      </div>
                    )}

                    {o.billSplits && o.billSplits.length > 0 ? (
                      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                        {o.billSplits.map((s) => (
                          <div key={s.index} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--surface-2, #f3efe6)", padding: "8px 12px", borderRadius: 8, fontSize: 13 }}>
                            <span>Guest {s.index} · ₹{s.amount}</span>
                            {s.paid ? <span style={{ color: "#16a34a", fontWeight: 700 }}>Paid ✓</span> : <button className="btn btn-sm btn-success" onClick={() => markSplitPaid(o, s.index)}>Mark Paid</button>}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                        <button className="btn btn-sm btn-ghost" onClick={() => printBill(o)} style={{ flex: 1 }}>Print</button>
                        {features.splitBill && <button className="btn btn-sm btn-ghost" onClick={() => openSplitBill(o)} style={{ flex: 1 }}>Split Bill</button>}
                        <button className="btn btn-sm btn-success" onClick={() => handleMarkPaidClick(o)} style={{ flex: 1 }}>Mark Paid</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // === NEW: RENDER POS ===
  const renderPOS = () => {
    const posCategories = [{ id: "all", name: "all" }, ...categories];
    const posItems = menuItems.filter((m) => {
      const matchesCat = posCategoryTab === "all" || m.category === posCategoryTab;
      const matchesSearch = !posSearch.trim() || m.name.toLowerCase().includes(posSearch.trim().toLowerCase());
      return matchesCat && matchesSearch && m.available;
    });
    return (
      <div>
        <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 20, fontFamily: "'Fraunces', serif" }}>Point of Sale</h2>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1fr) 320px", gap: 18, alignItems: "flex-start" }}>

          {/* MENU: menu browser */}
          <div className="card" style={{ padding: 16, borderRadius: 16, minWidth: 0 }}>
            <input placeholder="Search menu..." value={posSearch} onChange={(e) => setPosSearch(e.target.value)} style={{ ...inputStyle, marginBottom: 12 }} />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
              {posCategories.map((c) => (
                <button key={c.id} onClick={() => setPosCategoryTab(c.name === "all" ? "all" : c.name)}
                  style={{ padding: "7px 14px", borderRadius: 100, border: "none", whiteSpace: "nowrap", fontSize: 12.5, fontWeight: 700, cursor: "pointer", background: posCategoryTab === c.name ? "#1a1a2e" : "var(--surface-2, #f3efe6)", color: posCategoryTab === c.name ? "#fff" : "#666" }}>
                  {c.name === "all" ? "All" : c.name}
                </button>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10, maxHeight: 440, overflowY: "auto" }}>
              {posItems.map((item) => {
                const hasOptions = posItemHasOptions(item);
                const totalQty = posTotalQtyFor(item);
                return (
                  <div key={item.id} className="card" style={{ padding: 10, borderRadius: 12, textAlign: "center", overflow: "hidden" }}>
                    <div style={{ width: "100%", aspectRatio: "1 / 1", borderRadius: 10, overflow: "hidden", marginBottom: 8, background: "var(--surface-2, #f3efe6)", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
                      {item.imageUrl ? <img src={item.imageUrl} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontSize: 26 }}>🍽️</span>}
                      {item.bogoEnabled && <span style={{ position: "absolute", top: 4, left: 4, background: "#16a34a", color: "#fff", fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 100 }}>🎁 BOGO</span>}
                      {totalQty > 0 && <span style={{ position: "absolute", top: 4, right: 4, background: "#1a1a2e", color: "#fff", fontSize: 10.5, fontWeight: 800, minWidth: 18, height: 18, padding: "0 4px", borderRadius: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>{totalQty}</span>}
                    </div>
                    <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</div>
                    <div style={{ fontSize: 12, color: "#e8a33d", fontWeight: 800, marginBottom: 8 }}>
                      {item.variations?.length > 0 ? `From ₹${Math.min(...item.variations.map((v) => v.price))}` : `₹${item.price}`}
                    </div>
                    {hasOptions ? (
                      <button onClick={() => posTapItem(item)} className="btn btn-sm btn-primary" style={{ width: "100%" }}>
                        {totalQty > 0 ? "+ Add More" : "Select Options"}
                      </button>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                        <button onClick={() => posAdjustLineQty(posLineKey(item.id, null, []), -1)} className="btn btn-sm btn-ghost" style={{ width: 28, padding: 0 }}>-</button>
                        <span style={{ fontWeight: 700, minWidth: 16 }}>{posSimpleQtyFor(item)}</span>
                        <button onClick={() => posTapItem(item)} className="btn btn-sm btn-primary" style={{ width: 28, padding: 0 }}>+</button>
                      </div>
                    )}
                  </div>
                );
              })}
              {posItems.length === 0 && <p style={{ color: "#999", gridColumn: "1/-1", textAlign: "center" }}>No items match.</p>}
            </div>
          </div>

          {/* RIGHT: cart on top, table / quick-order picker below it */}
          <div style={{ display: "flex", flexDirection: "column", gap: 18, position: isMobile ? "static" : "sticky", top: 16, minWidth: 0 }}>
          <div className="card" style={{ padding: 16, borderRadius: 16 }}>
            <h3 style={{ fontSize: 14.5, fontWeight: 800, marginBottom: 10 }}>
              {posOrderType === "takeaway" ? "📦 Takeaway Order" : posTable ? `Table ${posTable}` : "Select a table"}
            </h3>
            {posLines.length === 0 ? (
              <p style={{ color: "#999", fontSize: 13 }}>Cart is empty.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                {posLines.map((l) => (
                  <div key={l.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, gap: 8 }}>
                    <span style={{ flex: 1, minWidth: 0 }}>{l.name}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                      <button onClick={() => posAdjustLineQty(l.key, -1)} className="btn btn-sm btn-ghost" style={{ width: 22, height: 22, padding: 0, fontSize: 11 }}>-</button>
                      <span style={{ fontWeight: 700, minWidth: 14, textAlign: "center" }}>{l.qty}</span>
                      <button onClick={() => posAdjustLineQty(l.key, 1)} className="btn btn-sm btn-ghost" style={{ width: 22, height: 22, padding: 0, fontSize: 11 }}>+</button>
                    </div>
                    <span style={{ fontWeight: 700, minWidth: 48, textAlign: "right" }}>₹{l.price * l.qty}</span>
                  </div>
                ))}
              </div>
            )}
            {posDiscounts.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                {posDiscounts.map((d, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#16a34a" }}>
                    <span>🔥 {d.name}</span><span>-₹{d.amount}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ borderTop: "1px dashed var(--border, #e6e1d6)", paddingTop: 10, marginBottom: 12, display: "flex", justifyContent: "space-between", fontWeight: 800, fontSize: 15 }}>
              <span>Subtotal</span><span>₹{Math.max(0, posSubtotal - posDiscountTotal)}</span>
            </div>
            <input placeholder="Order notes (optional)" value={posNotes} onChange={(e) => setPosNotes(e.target.value)} style={inputStyle} />
            <button className="btn btn-primary" style={{ width: "100%" }} disabled={posSending} onClick={posSendToKitchen}>{posSending ? "Sending..." : "Send to Kitchen"}</button>
          </div>

          <div className="card" style={{ padding: 16, borderRadius: 16 }}>
            <button
              onClick={() => { setPosOrderType(posOrderType === "takeaway" ? "dinein" : "takeaway"); setPosTable(null); }}
              className="btn"
              style={{ width: "100%", marginBottom: 14, background: posOrderType === "takeaway" ? "#8b5cf6" : "var(--surface-2, #f3efe6)", color: posOrderType === "takeaway" ? "#fff" : "#555" }}
            >📦 {posOrderType === "takeaway" ? "Quick Order Active" : "Quick Order (Takeaway)"}</button>
            <div style={{ fontSize: 11.5, fontWeight: 800, color: "#888", textTransform: "uppercase", marginBottom: 8 }}>Tables</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, maxHeight: 300, overflowY: "auto" }}>
              {tables.map((t) => {
                const activeCount = orders.filter((o) => o.table === t.number && !["paid", "cancelled", "declined", "merged"].includes(o.status)).length;
                const isSelected = posOrderType === "dinein" && posTable === t.number;
                return (
                  <button key={t.id} onClick={() => { setPosOrderType("dinein"); setPosTable(t.number); }}
                    style={{ padding: "10px 4px", borderRadius: 10, border: isSelected ? "2px solid #1a1a2e" : "2px solid transparent", background: activeCount > 0 ? "#fee2e2" : "#dcfce7", color: activeCount > 0 ? "#991b1b" : "#166534", fontWeight: 800, fontSize: 13, cursor: "pointer" }}>
                    {t.number}
                  </button>
                );
              })}
            </div>
          </div>
          </div>
        </div>

        {/* Active orders quick list */}
        <div style={{ marginTop: 28 }}>
          <h3 style={{ fontSize: 16, fontWeight: 800, marginBottom: 12 }}>Active Orders</h3>
          {active.length === 0 && pending.length === 0 ? <p style={{ color: "#999", fontSize: 13 }}>Nothing in progress.</p> : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
              {[...pending, ...active].map((o) => (
                <OrderCard key={o.id} order={o}>
                  {o.status === "pending" && <button className="btn btn-sm btn-primary" onClick={() => confirmOrder(o.id)} style={{ flex: 1 }}>Confirm</button>}
                  {o.status === "ready" && <button className="btn btn-sm btn-success" onClick={() => markServed(o.id)} style={{ flex: 1 }}>Mark Served</button>}
                </OrderCard>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  // === RENDER: MENU ===
  const filteredCategoryItems = menuItems.filter((m) => {
    const matchesTab = menuTab === "all" || m.category === menuTab;
    const matchesSearch = !menuSearch.trim() || m.name.toLowerCase().includes(menuSearch.trim().toLowerCase()) || (m.description || "").toLowerCase().includes(menuSearch.trim().toLowerCase());
    return matchesTab && matchesSearch;
  });

  const renderMenu = () => (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
        <h2 style={{ fontSize: 24, fontWeight: 800, margin: 0, fontFamily: "'Fraunces', serif" }}>Menu</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn btn-ghost" onClick={() => { setShowAddItem((s) => !s); setShowAddCombo(false); setShowAddCategory(false); setShowImportModal(false); setShowAddBundleRule(false); }}>{showAddItem ? "Close" : "+ Add Item"}</button>
          {features.combos && <button className="btn btn-ghost" onClick={() => { setShowAddCombo((s) => !s); setShowAddItem(false); setShowAddCategory(false); setShowImportModal(false); setShowAddBundleRule(false); }}>{showAddCombo ? "Close" : "+ Add Combo"}</button>}
          <button className="btn btn-ghost" onClick={() => { setShowAddCategory((s) => !s); setShowAddItem(false); setShowAddCombo(false); setShowImportModal(false); setShowAddBundleRule(false); }}>{showAddCategory ? "Close" : "+ Add Category"}</button>
          {features.smartSuggestions && <button className="btn btn-ghost" onClick={() => { setShowAddBundleRule((s) => !s); setShowAddItem(false); setShowAddCombo(false); setShowAddCategory(false); setShowImportModal(false); setShowManageOffers(false); }}>{showAddBundleRule ? "Close" : "+ Smart Deal"}</button>}
          <button className="btn btn-ghost" onClick={() => { setShowManageOffers((s) => !s); setShowAddItem(false); setShowAddCombo(false); setShowAddCategory(false); setShowImportModal(false); setShowAddBundleRule(false); }}>{showManageOffers ? "Close" : "🎠 Exclusive Deals"}</button>
          {brandId && (
            <button className="btn btn-ghost" onClick={seedFromMasterMenu} disabled={seeding} title="Copy items from your brand's master menu that this outlet doesn't have yet">
              {seeding ? "Seeding…" : "⬇ Seed from Master Menu"}
            </button>
          )}
          <button className="btn btn-primary" onClick={() => { setShowImportModal(true); setShowAddItem(false); setShowAddCombo(false); setShowAddCategory(false); setShowAddBundleRule(false); setShowManageOffers(false); }}>↑ Import Menu</button>
        </div>
      </div>

      {seedResult && (
        <div style={{
          marginBottom: 16, padding: 14, borderRadius: 12, fontSize: 13.5,
          background: seedResult.error ? "#fef2f2" : "#f0fdf4",
          border: `1px solid ${seedResult.error ? "#fecaca" : "#bbf7d0"}`,
          color: seedResult.error ? "#b91c1c" : "#166534",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <span style={{ flex: 1 }}>
            {seedResult.error
              ? seedResult.error
              : seedResult.added === 0
                ? `Nothing to add — all ${seedResult.skipped} master items are already on this menu.`
                : `Added ${seedResult.added} item${seedResult.added === 1 ? "" : "s"} from the master menu${seedResult.skipped ? `, skipped ${seedResult.skipped} you already had` : ""}. They are yours now — edit prices and availability freely.`}
          </span>
          <button onClick={() => setSeedResult(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", fontWeight: 800, fontSize: 16 }}>×</button>
        </div>
      )}

      {/* NEW: Offer Carousel — reception-curated exclusive deal banners (up to 8),
          shown as the top scrollable carousel on the customer menu. Each banner is
          an image + title, optionally with a day-limited discount, linked to a menu
          item — tapping it in the customer app adds that item (at the discounted
          price, if today qualifies) straight to the cart. This is now the single
          "exclusive deals" system — it replaces the old one-at-a-time promo banner. */}
      {showManageOffers && (
        <div className="card" style={{ padding: 20, borderRadius: 16, marginBottom: 20, border: "2px dashed #0369a1" }}>
          <h3 style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 6 }}>🎠 Exclusive Deals</h3>
          <p style={{ fontSize: 12.5, color: "var(--text-secondary, #6b6b7b)", marginBottom: 14 }}>
            Up to 8 deal banners shown in a scrollable carousel at the top of the customer menu. Title and price are overlaid on the photo — tapping a banner adds the linked item straight to the cart. Set a discount and pick which days it's active (leave days unpicked to apply every day). If you add none, this section simply won't show.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 4, marginBottom: 4 }}>
            <div>
              <label style={labelStyle}>Offer Title</label>
              <input placeholder="e.g. Weekend Special — 20% off" value={newOfferBanner.title} onChange={(e) => setNewOfferBanner((p) => ({ ...p, title: e.target.value }))} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Linked Item</label>
              <select value={newOfferBanner.linkedItemId} onChange={(e) => setNewOfferBanner((p) => ({ ...p, linkedItemId: e.target.value }))} style={inputStyle}>
                <option value="">Select item</option>
                {menuItems.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 4, marginBottom: 4 }}>
            <div>
              <label style={labelStyle}>Discount (%, optional)</label>
              <input placeholder="e.g. 20" type="number" min="0" max="100" value={newOfferBanner.discountPercent} onChange={(e) => setNewOfferBanner((p) => ({ ...p, discountPercent: e.target.value }))} style={inputStyle} />
            </div>
          </div>
          <label style={labelStyle}>Active Days (none selected = every day)</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            {DAY_OPTIONS.map((d) => {
              const selected = (newOfferBanner.days || []).includes(d.key);
              return (
                <button key={d.key} type="button" onClick={() => setNewOfferBanner((p) => ({ ...p, days: selected ? p.days.filter((k) => k !== d.key) : [...(p.days || []), d.key] }))}
                  style={{ padding: "7px 12px", borderRadius: 100, border: selected ? "2px solid #0369a1" : "1px solid #ddd", background: selected ? "#e0f2fe" : "#fff", color: selected ? "#0369a1" : "#666", cursor: "pointer", fontSize: 12.5, fontWeight: 700 }}>
                  {d.label}
                </button>
              );
            })}
          </div>

          <label style={labelStyle}>Banner Image</label>
          <input ref={offerBannerFileInputRef} type="file" accept="image/*" onChange={(e) => handleOfferBannerImageUpload(e.target.files[0])} style={{ display: "none" }} />
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14 }}>
            <button onClick={() => offerBannerFileInputRef.current?.click()} disabled={offerBannerUploading} className="btn btn-ghost" style={{ border: "2px dashed var(--border, #e6e1d6)" }}>{offerBannerUploading ? "Uploading..." : "Upload Photo"}</button>
            {newOfferBanner.imageUrl && !offerBannerUploading && <img src={newOfferBanner.imageUrl} alt="" style={{ width: 48, height: 48, borderRadius: 10, objectFit: "cover" }} />}
          </div>
          <button className="btn btn-primary" onClick={addOfferBanner} disabled={offerBanners.length >= 8}>{offerBanners.length >= 8 ? "Limit reached (8/8)" : `+ Add Offer (${offerBanners.length}/8)`}</button>

          {offerBanners.length > 0 && (
            <div style={{ marginTop: 18, borderTop: "1px solid var(--border, #e6e1d6)", paddingTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#888", textTransform: "uppercase", marginBottom: 10 }}>Current Offers</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {offerBanners.map((banner, i) => {
                  const linked = menuItems.find((m) => m.id === banner.linkedItemId);
                  const daysLabel = !banner.days || banner.days.length === 0 ? "Every day" : banner.days.map((k) => DAY_OPTIONS.find((d) => d.key === k)?.label || k).join(", ");
                  return (
                    <div key={banner.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "var(--surface-2, #f3efe6)", borderRadius: 10 }}>
                      <span style={{ width: 22, height: 22, borderRadius: "50%", background: "#0369a1", color: "#fff", fontSize: 11.5, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</span>
                      {banner.imageUrl && <img src={banner.imageUrl} alt="" style={{ width: 34, height: 34, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} />}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{banner.title}</div>
                        <div style={{ fontSize: 11, color: "#888" }}>{linked ? `→ ${linked.name}` : "No linked item"}{banner.discountPercent > 0 ? ` · ${banner.discountPercent}% off` : ""} · {daysLabel}</div>
                      </div>
                      <button className="btn btn-sm btn-ghost" disabled={i === 0} onClick={() => moveOfferBanner(banner, "up")} style={{ padding: "4px 10px", opacity: i === 0 ? 0.4 : 1 }}>↑</button>
                      <button className="btn btn-sm btn-ghost" disabled={i === offerBanners.length - 1} onClick={() => moveOfferBanner(banner, "down")} style={{ padding: "4px 10px", opacity: i === offerBanners.length - 1 ? 0.4 : 1 }}>↓</button>
                      <button className="btn btn-sm btn-ghost" onClick={() => deleteOfferBanner(banner.id)} style={{ padding: "4px 10px", color: "#dc2626" }}>Remove</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* NEW: Smart Suggestions / Bundle Discount rule builder */}
      {showAddBundleRule && (
        <div className="card" style={{ padding: 20, borderRadius: 16, marginBottom: 20, border: "2px dashed #7c3aed" }}>
          <h3 style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 6 }}>New Smart Deal</h3>
          <p style={{ fontSize: 12.5, color: "var(--text-secondary, #6b6b7b)", marginBottom: 14 }}>You set the rule and the discount — billing applies it automatically, no manual math. (Buy 1 Get 1 Free doesn't need a rule here — just flag the item as BOGO when adding/editing it.)</p>
          <label style={labelStyle}>Deal Name</label>
          <input placeholder="e.g. Weekend Feast" value={newBundleRule.name} onChange={(e) => setNewBundleRule((p) => ({ ...p, name: e.target.value }))} style={inputStyle} />
          <label style={labelStyle}>Deal Type</label>
          <select value={newBundleRule.type} onChange={(e) => setNewBundleRule((p) => ({ ...p, type: e.target.value }))} style={inputStyle}>
            <option value="pairDiscount">Pair Discount (Item A + Item B → off)</option>
            <option value="thresholdFreeItem">Spend Threshold → Free Item</option>
            <option value="categoryBundle">Category Bundle → % off</option>
          </select>

          {newBundleRule.type === "pairDiscount" && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label style={labelStyle}>Item A</label>
                  <select value={newBundleRule.requiredItemA} onChange={(e) => setNewBundleRule((p) => ({ ...p, requiredItemA: e.target.value }))} style={inputStyle}>
                    <option value="">Select item</option>
                    {menuItems.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Item B</label>
                  <select value={newBundleRule.requiredItemB} onChange={(e) => setNewBundleRule((p) => ({ ...p, requiredItemB: e.target.value }))} style={inputStyle}>
                    <option value="">Select item</option>
                    {menuItems.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label style={labelStyle}>Discount Type</label>
                  <select value={newBundleRule.discountType} onChange={(e) => setNewBundleRule((p) => ({ ...p, discountType: e.target.value }))} style={inputStyle}>
                    <option value="flat">Flat ₹ off</option>
                    <option value="percent">% off cheaper item</option>
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>{newBundleRule.discountType === "flat" ? "Amount (₹)" : "Percent (%)"}</label>
                  <input type="number" value={newBundleRule.discountValue} onChange={(e) => setNewBundleRule((p) => ({ ...p, discountValue: e.target.value }))} style={inputStyle} />
                </div>
              </div>
            </>
          )}

          {newBundleRule.type === "thresholdFreeItem" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label style={labelStyle}>Spend Threshold (₹)</label>
                <input type="number" value={newBundleRule.threshold} onChange={(e) => setNewBundleRule((p) => ({ ...p, threshold: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Free Item</label>
                <select value={newBundleRule.freeItemId} onChange={(e) => setNewBundleRule((p) => ({ ...p, freeItemId: e.target.value }))} style={inputStyle}>
                  <option value="">Select item</option>
                  {menuItems.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
            </div>
          )}

          {newBundleRule.type === "categoryBundle" && (
            <>
              <label style={labelStyle}>Required Categories (select 2+)</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                {categories.map((c) => {
                  const selected = newBundleRule.requiredCategories.includes(c.name);
                  return (
                    <button key={c.id} type="button" onClick={() => setNewBundleRule((p) => ({ ...p, requiredCategories: selected ? p.requiredCategories.filter((n) => n !== c.name) : [...p.requiredCategories, c.name] }))}
                      style={{ padding: "6px 14px", borderRadius: 100, border: selected ? "2px solid #7c3aed" : "1px solid #ddd", background: selected ? "#7c3aed15" : "#fff", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>{c.name}</button>
                  );
                })}
              </div>
              <label style={labelStyle}>Percent Off (%)</label>
              <input type="number" value={newBundleRule.discountValue} onChange={(e) => setNewBundleRule((p) => ({ ...p, discountValue: e.target.value }))} style={inputStyle} />
            </>
          )}

          <button className="btn btn-primary" onClick={addBundleRule}>+ Create Deal</button>

          {bundleRules.length > 0 && (
            <div style={{ marginTop: 18, borderTop: "1px solid var(--border, #e6e1d6)", paddingTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#888", textTransform: "uppercase", marginBottom: 10 }}>Active & Saved Deals</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {bundleRules.map((rule) => (
                  <div key={rule.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "var(--surface-2, #f3efe6)", borderRadius: 10 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{rule.name}</div>
                      <div style={{ fontSize: 11.5, color: "#888" }}>{bundleRuleSummary(rule)}</div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="btn btn-sm" onClick={() => toggleBundleRuleActive(rule)} style={{ background: rule.active ? "#dcfce7" : "#fef3c7", color: rule.active ? "#166534" : "#92400e", border: "none" }}>{rule.active ? "Active" : "Paused"}</button>
                      <button className="btn btn-sm btn-ghost" onClick={() => deleteBundleRule(rule.id)} style={{ color: "#dc2626" }}>Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* BULK IMPORT MODAL */}
      {showImportModal && (
        <div className="card" style={{ padding: 24, borderRadius: 16, marginBottom: 24, border: "2px dashed #1a1a2e" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>Import Menu</h3>
            <button onClick={() => { setShowImportModal(false); setImportText(""); setImportPreview(null); setZipFile(null); setZipImages({}); setImportReport(null); }} style={{ background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 18 }}>✕</button>
          </div>

          {importReport && (
            <div style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
              <span>✅ {importReport.imported} item(s) imported</span>
              {importReport.imagesUploaded > 0 && <span>✅ {importReport.imagesUploaded} image(s) uploaded to Cloudinary</span>}
              {importReport.categoriesCreated > 0 && <span>✅ {importReport.categoriesCreated} new categor{importReport.categoriesCreated === 1 ? "y" : "ies"} created</span>}
              {importReport.imagesMissing > 0 && <span style={{ color: "#e8a33d" }}>⚠️ {importReport.imagesMissing} image(s) not found in the zip — imported without a photo</span>}
              {importReport.imagesFailed > 0 && <span style={{ color: "#e8a33d" }}>⚠️ {importReport.imagesFailed} image upload(s) failed — imported without a photo</span>}
              {importReport.duplicatesSkipped > 0 && <span style={{ color: "#888" }}>ℹ️ {importReport.duplicatesSkipped} duplicate(s) skipped</span>}
              {importReport.invalidRows > 0 && <span style={{ color: "#dc2626" }}>❌ {importReport.invalidRows} row(s) had errors and were skipped</span>}
              <button className="btn btn-primary btn-sm" style={{ marginTop: 6, alignSelf: "flex-start" }} onClick={() => setImportReport(null)}>Import Another File</button>
            </div>
          )}

          {!importReport && (
          <>
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            <button onClick={() => { setImportFormat("csv"); setImportPreview(null); setImportText(""); }} style={{ padding: "6px 14px", borderRadius: 8, border: "none", fontSize: 12, fontWeight: 700, cursor: "pointer", background: importFormat === "csv" ? "#1a1a2e" : "#f3efe6", color: importFormat === "csv" ? "#fff" : "#666" }}>CSV</button>
            <button onClick={() => { setImportFormat("json"); setImportPreview(null); setImportText(""); }} style={{ padding: "6px 14px", borderRadius: 8, border: "none", fontSize: 12, fontWeight: 700, cursor: "pointer", background: importFormat === "json" ? "#1a1a2e" : "#f3efe6", color: importFormat === "json" ? "#fff" : "#666" }}>JSON</button>
            <button onClick={() => { setImportFormat("zip"); setImportPreview(null); }} style={{ padding: "6px 14px", borderRadius: 8, border: "none", fontSize: 12, fontWeight: 700, cursor: "pointer", background: importFormat === "zip" ? "#1a1a2e" : "#f3efe6", color: importFormat === "zip" ? "#fff" : "#666" }}>ZIP (CSV + Photos)</button>
            {importFormat === "zip" ? (
              <button onClick={downloadZipTemplate} className="btn btn-sm btn-ghost" style={{ marginLeft: "auto" }}>↓ Download ZIP Template</button>
            ) : importFormat === "json" ? (
              <button onClick={downloadJsonTemplate} className="btn btn-sm btn-ghost" style={{ marginLeft: "auto" }}>↓ Download JSON Template</button>
            ) : (
              <button onClick={downloadTemplate} className="btn btn-sm btn-ghost" style={{ marginLeft: "auto" }}>↓ Download CSV Template</button>
            )}
          </div>

          <p style={{ fontSize: 12.5, color: "#6b6b7b", marginBottom: 12 }}>
            {importFormat === "csv"
              ? "Upload a .csv file or paste CSV text below. Columns: Name, Price, Category, Description, FoodType, ChefSpecial, Featured, ImageUrl, Variations, Addons, ETA, BOGO. (ImageUrl must already be a hosted link — CSV can't carry local photo files.)"
              : importFormat === "json"
              ? "Upload a .json file or paste a JSON array below. Each object needs: name, price, category. Optional: description, foodType, chefSpecial, featured, imageUrl, etaMinutes, bogoEnabled, variations, addons."
              : "Upload a .zip containing one menu.csv (with an ImageFile column, e.g. paneer-tikka.jpg) and an images/ folder with matching photos. Photos are uploaded to Cloudinary automatically — no manual upload needed."}
          </p>
          <p style={{ fontSize: 12, color: "#a08a5c", marginTop: -6, marginBottom: 12, lineHeight: 1.6 }}>
            A dish with sizes or add-ons stays <strong>one row</strong>, not several — put them in the
            Variations / Addons column as <code>Small:180|Medium:250|Large:320</code>. Three separate rows
            for "Pizza Small", "Pizza Medium" and "Pizza Large" import as three unrelated menu items, not
            one dish with three sizes.
          </p>

          {importFormat === "zip" ? (
            <div style={{ marginBottom: 16 }}>
              <input type="file" accept=".zip" onChange={(e) => handleZipFileSelected(e.target.files[0])} style={{ fontSize: 13, marginBottom: 10 }} />
              {zipParsing && <p style={{ fontSize: 13, color: "#888" }}>Reading zip file…</p>}
              {zipFile && !zipParsing && !importPreview?.error && <p style={{ fontSize: 12.5, color: "#16a34a", fontWeight: 600 }}>Loaded {zipFile.name}</p>}
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <input
                  type="file"
                  accept={importFormat === "csv" ? ".csv,text/csv" : ".json,application/json"}
                  onChange={(e) => handleTextFileSelected(e.target.files[0])}
                  style={{ fontSize: 13 }}
                />
                <span style={{ fontSize: 11.5, color: "#999" }}>or paste directly below</span>
              </div>

              <textarea
                value={importText}
                onChange={(e) => { setImportText(e.target.value); setImportPreview(null); }}
                placeholder={importFormat === "csv"
                  ? `Name,Price,Category,Description,FoodType,ChefSpecial,Featured,ImageUrl,Variations,Addons,ETA,BOGO\nMargherita Pizza,320,Mains,Classic tomato and mozzarella,veg,no,yes,,"Small:220|Medium:320|Large:420","Extra Cheese:40",20,no`
                  : `[\n  {\n    "name": "Margherita Pizza",\n    "price": 320,\n    "category": "Mains",\n    "foodType": "veg",\n    "variations": [{"name":"Small","price":220},{"name":"Medium","price":320},{"name":"Large","price":420}],\n    "addons": [{"name":"Extra Cheese","price":40}]\n  }\n]`}
                style={{ width: "100%", minHeight: 160, padding: 14, borderRadius: 10, border: "1px solid #e6e1d6", fontSize: 13, fontFamily: "monospace", resize: "vertical", marginBottom: 12, boxSizing: "border-box" }}
              />

              <button onClick={buildImportPreview} className="btn btn-primary" style={{ marginBottom: 16 }} disabled={!importText.trim()}>
                Preview Import
              </button>
            </>
          )}

          {importPreview && (
            <div style={{ marginBottom: 16 }}>
              {importPreview.error && (
                <div style={{ background: "#fef2f2", color: "#dc2626", padding: 12, borderRadius: 10, fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
                  {importPreview.error}
                </div>
              )}

              {importPreview.errors.length > 0 && (
                <div style={{ background: "#fffbeb", color: "#92400e", padding: 12, borderRadius: 10, fontSize: 12, marginBottom: 12 }}>
                  <strong>Validation Issues ({importPreview.errors.length}):</strong>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {importPreview.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}

              {importPreview.valid && (
                <>
                  <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>
                      <span style={{ color: "#16a34a" }}>{importPreview.items.length}</span> items ready
                    </div>
                    {importPreview.duplicates.length > 0 && (
                      <div style={{ fontSize: 13, color: "#92400e" }}>
                        <span style={{ fontWeight: 700 }}>{importPreview.duplicates.length}</span> duplicates will be skipped
                      </div>
                    )}
                    {importPreview.categoriesNeeded.length > 0 && (
                      <div style={{ fontSize: 13, color: "#3b82f6" }}>
                        <span style={{ fontWeight: 700 }}>{importPreview.categoriesNeeded.length}</span> new categor{importPreview.categoriesNeeded.length === 1 ? "y" : "ies"} to create
                      </div>
                    )}
                  </div>

                  {importPreview.categoriesNeeded.length > 0 && (
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 12, padding: 10, background: "#eff6ff", borderRadius: 8 }}>
                      <input type="checkbox" checked={autoCreateCategories} onChange={(e) => setAutoCreateCategories(e.target.checked)} />
                      Auto-create missing categories: {importPreview.categoriesNeeded.join(", ")}
                    </label>
                  )}

                  {!autoCreateCategories && importPreview.categoriesNeeded.length > 0 && (
                    <div style={{ background: "#fef2f2", color: "#dc2626", padding: 10, borderRadius: 8, fontSize: 12, fontWeight: 600, marginBottom: 12 }}>
                      ⚠️ Cannot import without creating these categories first. Either enable auto-create or add them manually.
                    </div>
                  )}

                  {importPreview.isZip && (
                    <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap", fontSize: 13 }}>
                      <span><span style={{ color: "#16a34a", fontWeight: 700 }}>{importPreview.imageStats.matched}</span> photos matched</span>
                      {importPreview.imageStats.missing > 0 && <span><span style={{ color: "#dc2626", fontWeight: 700 }}>{importPreview.imageStats.missing}</span> missing (will import without photo)</span>}
                    </div>
                  )}

                  <div className="card" style={{ padding: 16, borderRadius: 12, marginBottom: 12, maxHeight: 240, overflow: "auto" }}>
                    <table style={{ width: "100%", fontSize: 12.5, borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid #e6e1d6", textAlign: "left" }}>
                          <th style={{ padding: "6px 8px" }}>Name</th>
                          <th style={{ padding: "6px 8px" }}>Price</th>
                          <th style={{ padding: "6px 8px" }}>Category</th>
                          {!siteSettings.pureVeg && <th style={{ padding: "6px 8px" }}>Type</th>}
                          <th style={{ padding: "6px 8px" }}>Flags</th>
                          {importPreview.isZip && <th style={{ padding: "6px 8px" }}>Photo</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {importPreview.items.slice(0, 10).map((item, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid #f4f4f4" }}>
                            <td style={{ padding: "6px 8px" }}>{item.name}</td>
                            <td style={{ padding: "6px 8px" }}>₹{item.price}</td>
                            <td style={{ padding: "6px 8px" }}>{item.category}</td>
                            {!siteSettings.pureVeg && (
                              <td style={{ padding: "6px 8px" }}>
                                <span style={{ color: item.foodType === "nonveg" ? "#dc2626" : "#16a34a", fontWeight: 600 }}>{item.foodType}</span>
                              </td>
                            )}
                            <td style={{ padding: "6px 8px" }}>
                              {item.chefSpecial && <span style={{ fontSize: 10, background: "#1a1a2e", color: "#fff", padding: "2px 6px", borderRadius: 4, marginRight: 4 }}>CS</span>}
                              {item.featured && <span style={{ fontSize: 10, background: "#e8a33d", color: "#fff", padding: "2px 6px", borderRadius: 4 }}>★</span>}
                            </td>
                            {importPreview.isZip && (
                              <td style={{ padding: "6px 8px" }}>
                                {item.imageMatchStatus === "matched" && <span style={{ color: "#16a34a" }}>✅ Matched</span>}
                                {item.imageMatchStatus === "missing" && <span style={{ color: "#dc2626" }}>⚠️ Missing</span>}
                                {item.imageMatchStatus === "none" && <span style={{ color: "#999" }}>—</span>}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {importPreview.items.length > 10 && (
                      <p style={{ fontSize: 11, color: "#888", margin: "8px 0 0", textAlign: "center" }}>...and {importPreview.items.length - 10} more</p>
                    )}
                  </div>

                  <button
                    onClick={executeImport}
                    disabled={importing || (importPreview.categoriesNeeded.length > 0 && !autoCreateCategories)}
                    className="btn btn-primary"
                    style={{ width: "100%", opacity: importing || (importPreview.categoriesNeeded.length > 0 && !autoCreateCategories) ? 0.5 : 1 }}
                  >
                    {importing
                      ? (importPreview.isZip && importProgress.total > 0 ? `Uploading photos... ${importProgress.done}/${importProgress.total}` : "Importing...")
                      : `Import ${importPreview.items.length - importPreview.duplicates.length} Items`}
                  </button>
                </>
              )}
            </div>
          )}
          </>
          )}
        </div>
      )}

      {showAddCombo && (
        <div className="card" style={{ padding: 20, borderRadius: 16, marginBottom: 20, border: "2px dashed #1a1a2e" }}>
          <h3 style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 14 }}>New Combo Pack</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 4 }}>
            <div><label style={labelStyle}>Combo Name</label><input placeholder="e.g. Family Feast" value={newCombo.name} onChange={(e) => setNewCombo((p) => ({ ...p, name: e.target.value }))} style={inputStyle} /></div>
            <div><label style={labelStyle}>Price (₹)</label><input type="number" value={newCombo.price} onChange={(e) => setNewCombo((p) => ({ ...p, price: e.target.value }))} style={inputStyle} /></div>
          </div>
          <label style={labelStyle}>Description</label>
          <input placeholder="What's included in the combo" value={newCombo.description} onChange={(e) => setNewCombo((p) => ({ ...p, description: e.target.value }))} style={inputStyle} />
          <label style={labelStyle}>Photo</label>
          <input ref={comboFileInputRef} type="file" accept="image/*" onChange={(e) => handleComboImageUpload(e.target.files[0])} style={{ display: "none" }} />
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
            <button onClick={() => comboFileInputRef.current?.click()} disabled={comboUploading} className="btn btn-ghost" style={{ border: "2px dashed var(--border, #e6e1d6)" }}>{comboUploading ? "Uploading..." : "Choose Photo"}</button>
            {newCombo.imageUrl && !comboUploading && <img src={newCombo.imageUrl} alt="" style={{ width: 48, height: 48, borderRadius: 10, objectFit: "cover" }} />}
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 600, cursor: "pointer", marginBottom: 14 }}>
            <input type="checkbox" checked={!!newCombo.featured} onChange={(e) => setNewCombo((p) => ({ ...p, featured: e.target.checked }))} /> Show in Featured box
          </label>
          <button className="btn btn-primary" onClick={addCombo}>+ Add Combo</button>
        </div>
      )}

      {showAddCategory && (
        <div className="card" style={{ padding: 20, borderRadius: 16, marginBottom: 20, border: "2px dashed var(--border, #e6e1d6)" }}>
          <h3 style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 14 }}>New Category</h3>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label style={labelStyle}>Category Name</label>
              <input placeholder="e.g. Tandoor Specials" value={newCategory.name} onChange={(e) => setNewCategory((p) => ({ ...p, name: e.target.value }))} style={{ ...inputStyle, marginBottom: 0 }} />
            </div>
            <div>
              <label style={labelStyle}>Icon Photo</label>
              <input ref={categoryFileInputRef} type="file" accept="image/*" onChange={(e) => handleCategoryImageUpload(e.target.files[0])} style={{ display: "none" }} />
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <button onClick={() => categoryFileInputRef.current?.click()} disabled={categoryUploading} className="btn btn-ghost" style={{ border: "2px dashed var(--border, #e6e1d6)" }}>{categoryUploading ? "..." : "Upload"}</button>
                {newCategory.imageUrl && !categoryUploading && <img src={newCategory.imageUrl} alt="" style={{ width: 42, height: 42, borderRadius: "50%", objectFit: "cover" }} />}
              </div>
            </div>
            <button className="btn btn-primary" onClick={addCategory}>Add Category</button>
          </div>
        </div>
      )}

      {/* COLLAPSIBLE ADD NEW ITEM */}
      {showAddItem && (
        <div className="card" style={{ padding: 22, borderRadius: 18, marginBottom: 28 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Add New Item</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 4 }}>
            <div><label style={labelStyle}>Name</label><input placeholder="e.g. Paneer Tikka" value={newItem.name} onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))} style={inputStyle} /></div>
            <div><label style={labelStyle}>Price (₹)</label><input placeholder="0" type="number" value={newItem.price} onChange={(e) => setNewItem((p) => ({ ...p, price: e.target.value }))} style={inputStyle} /></div>
            <div>
              <label style={labelStyle}>Category</label>
              <select value={newItem.category} onChange={(e) => setNewItem((p) => ({ ...p, category: e.target.value }))} style={inputStyle}>
                {categories.length === 0 && <option value="">Add a category first</option>}
                {categories.filter((c) => c.name !== COMBO_CATEGORY).map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Prep Time (min)</label>
              <input placeholder="15" type="number" min="1" value={newItem.etaMinutes} onChange={(e) => setNewItem((p) => ({ ...p, etaMinutes: e.target.value }))} style={inputStyle} />
            </div>
          </div>
          <p style={{ fontSize: 11.5, color: "#999", marginTop: -8, marginBottom: 14 }}>
            How long the kitchen typically takes to cook this item. Drives the auto-starting countdown timer on the Kitchen Display — defaults to 15 min if left blank.
          </p>

          <label style={labelStyle}>Food Type *</label>
          <FoodTypeToggle value={newItem.foodType} onChange={(v) => setNewItem((p) => ({ ...p, foodType: v }))} pureVeg={siteSettings.pureVeg} />

          <VariationsAddonsEditor form={newItem} setForm={setNewItem} />

          <label style={labelStyle}>Food Photo</label>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={(e) => handleImageUpload(e.target.files[0], false)} style={{ display: "none" }} />
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
            <button onClick={() => fileInputRef.current?.click()} disabled={uploadingImage} className="btn btn-ghost" style={{ border: "2px dashed var(--border, #e6e1d6)" }}>{uploadingImage ? "Uploading..." : "Choose Photo"}</button>
            {newItem.imageUrl && !uploadingImage && <img src={newItem.imageUrl} alt="Preview" style={{ width: 52, height: 52, borderRadius: 10, objectFit: "cover" }} />}
          </div>

          <label style={labelStyle}>Description</label>
          <input placeholder="Short, appetising description (optional)" value={newItem.description} onChange={(e) => setNewItem((p) => ({ ...p, description: e.target.value }))} style={inputStyle} />

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 600, cursor: "pointer", marginBottom: 14 }}>
            <input type="checkbox" checked={!!newItem.chefSpecial} onChange={(e) => setNewItem((p) => ({ ...p, chefSpecial: e.target.checked }))} /> Mark as Chef's Special
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 600, cursor: "pointer", marginBottom: 14 }}>
            <input type="checkbox" checked={!!newItem.bogoEnabled} onChange={(e) => setNewItem((p) => ({ ...p, bogoEnabled: e.target.checked }))} /> 🎁 Buy 1 Get 1 Free (highest-priced unit in each pair is charged, other is free)
          </label>

          <button className="btn btn-primary" onClick={addMenuItem}>+ Add Item to Menu</button>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 240px", minWidth: 220 }}>
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", opacity: 0.5 }}>🔎</span>
          <input placeholder="Search the menu..." value={menuSearch} onChange={(e) => setMenuSearch(e.target.value)} style={{ ...inputStyle, marginBottom: 0, paddingLeft: 38 }} />
        </div>
      </div>

      {/* Category pills — NO floating ✎/✕. Tap ⋯ to expand the panel below. */}
      <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 8, marginBottom: 4 }}>
        <button onClick={() => setMenuTab("all")} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, minWidth: 68, background: "none", border: "none", cursor: "pointer", flexShrink: 0 }}>
          <div style={{ width: 52, height: 52, borderRadius: "50%", background: menuTab === "all" ? "#1a1a2e" : "var(--surface-2, #f3efe6)", color: menuTab === "all" ? "#fff" : "var(--text-secondary, #6b6b7b)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, border: menuTab === "all" ? "2px solid #1a1a2e" : "2px solid transparent" }}>🍴</div>
          <span style={{ fontSize: 11.5, fontWeight: menuTab === "all" ? 800 : 600, color: menuTab === "all" ? "var(--text, #1a1a2e)" : "var(--text-secondary, #6b6b7b)" }}>All</span>
        </button>
        {categories.map((cat) => {
          const isActive = menuTab === cat.name;
          const count = menuItems.filter((m) => m.category === cat.name).length;
          return (
            <div key={cat.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, minWidth: 68, flexShrink: 0, position: "relative", paddingTop: 4 }}>
              <div style={{ position: "relative" }}>
                <button onClick={() => setMenuTab(cat.name)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                  <div style={{ width: 52, height: 52, borderRadius: "50%", overflow: "hidden", background: isActive ? "#e8a33d" : "var(--surface-2, #f3efe6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, border: isActive ? "2px solid #e8a33d" : "2px solid var(--border, #e6e1d6)" }}>
                    {cat.imageUrl ? <img src={cat.imageUrl} alt={cat.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : (cat.name === BAR_CATEGORY ? "🍸" : "🍽️")}
                  </div>
                </button>
                <button
                  onClick={() => { const next = expandedCategoryId === cat.id ? null : cat.id; setExpandedCategoryId(next); if (next) startEditCategory(cat); }}
                  title="Options"
                  style={{ position: "absolute", bottom: -4, right: -4, width: 20, height: 20, borderRadius: "50%", background: "#1a1a2e", color: "#fff", border: "2px solid var(--surface, #fff)", fontSize: 11, cursor: "pointer", lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}
                >⋯</button>
              </div>
              <span onClick={() => setMenuTab(cat.name)} style={{ fontSize: 11.5, fontWeight: isActive ? 800 : 600, color: isActive ? "var(--text, #1a1a2e)" : "var(--text-secondary, #6b6b7b)", cursor: "pointer", whiteSpace: "nowrap" }}>{cat.name}{count > 0 ? ` (${count})` : ""}</span>
            </div>
          );
        })}
      </div>

      {/* NEW: inline expansion panel — replaces the old floating ✎ / ✕ */}
      {expandedCategoryId && (() => {
        const cat = categories.find((c) => c.id === expandedCategoryId);
        if (!cat) return null;
        const itemsInCat = menuItems.filter((m) => m.category === cat.name);
        return (
          <div className="card" style={{ padding: 18, borderRadius: 14, marginBottom: 22, border: "2px dashed #e8a33d", animation: "riseIn 0.2s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <h3 style={{ fontSize: 14.5, fontWeight: 800, margin: 0 }}>{cat.imageUrl ? "" : (cat.name === BAR_CATEGORY ? "🍸 " : "🍽️ ")}{cat.name}</h3>
              <button onClick={() => setExpandedCategoryId(null)} style={{ background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 16 }}>✕</button>
            </div>

            <div style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 16 }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={labelStyle}>Category Name</label>
                <input value={editCategoryForm.name} onChange={(e) => setEditCategoryForm((p) => ({ ...p, name: e.target.value }))} disabled={cat.name === COMBO_CATEGORY} style={{ ...inputStyle, marginBottom: 0 }} />
              </div>
              <div>
                <label style={labelStyle}>Icon Photo</label>
                <input ref={editCategoryFileInputRef} type="file" accept="image/*" onChange={(e) => handleEditCategoryImageUpload(e.target.files[0])} style={{ display: "none" }} />
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <button onClick={() => editCategoryFileInputRef.current?.click()} disabled={editCategoryUploading} className="btn btn-ghost btn-sm">{editCategoryUploading ? "..." : "Change"}</button>
                  {editCategoryForm.imageUrl && !editCategoryUploading && <img src={editCategoryForm.imageUrl} alt="" style={{ width: 38, height: 38, borderRadius: "50%", objectFit: "cover" }} />}
                </div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => saveEditCategory(cat)}>Save</button>
              <button className="btn btn-sm" onClick={() => deleteCategory(cat)} style={{ background: "#fef2f2", color: "#dc2626", border: "none" }} disabled={cat.name === COMBO_CATEGORY}>Delete Category</button>
            </div>

            <div style={{ fontSize: 12, fontWeight: 800, color: "#888", textTransform: "uppercase", marginBottom: 10 }}>Items in this category ({itemsInCat.length})</div>
            {itemsInCat.length === 0 ? (
              <p style={{ fontSize: 13, color: "#999" }}>No items yet.</p>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
                {itemsInCat.map((item) => (
                  <div key={item.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "var(--surface-2, #f3efe6)", borderRadius: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</div>
                      <div style={{ fontSize: 11, color: "#888" }}>₹{item.price}</div>
                    </div>
                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                      <button onClick={() => startEdit(item)} className="btn btn-sm btn-ghost" style={{ padding: "4px 8px" }}>✎</button>
                      <button onClick={() => deleteItem(item.id)} className="btn btn-sm btn-ghost" style={{ padding: "4px 8px", color: "#dc2626" }}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {filteredCategoryItems.length === 0 ? (
        <div className="card" style={{ padding: 48, textAlign: "center", color: "var(--text-secondary, #6b6b7b)", borderRadius: 16 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🔎</div>
          <p style={{ margin: 0 }}>{menuSearch ? "No dishes match your search." : "No items in this category yet."}</p>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 16 }}>
          {filteredCategoryItems.map((item) => (
            <MenuItemCard
              key={item.id}
              item={item}
              isEditing={editingId === item.id}
              editForm={editForm}
              setEditForm={setEditForm}
              editUploading={editUploading}
              editFileInputRef={editFileInputRef}
              handleImageUpload={handleImageUpload}
              categories={categories}
              saveEdit={saveEdit}
              cancelEdit={() => setEditingId(null)}
              toggleAvailable={toggleAvailable}
              toggleFeatured={toggleFeatured}
              toggleChefSpecial={toggleChefSpecial}
              startEdit={startEdit}
              deleteItem={deleteItem}
              pureVeg={siteSettings.pureVeg}
            />
          ))}
        </div>
      )}
    </div>
  );

  // === RENDER: TABLES ===
  const renderTables = () => {
    const useFloors = features.floors && floors.length > 0;
    const floorsToShow = useFloors ? floors : [{ id: null, name: "All Tables" }];

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 24, fontWeight: 800, margin: 0, fontFamily: "'Fraunces', serif" }}>Tables</h2>
            <p style={{ fontSize: 13, color: "var(--text-secondary, #6b6b7b)", margin: "4px 0 0" }}>Green = free, red = occupied. Tap Print for a table's QR code.</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {features.floors && <button className="btn btn-ghost" onClick={() => setShowAddFloor((s) => !s)}>{showAddFloor ? "Close" : "+ Add Floor"}</button>}
            {mergeMode ? (
              <>
                <button className="btn btn-primary" onClick={confirmMerge}>Confirm Merge ({mergeSelected.length})</button>
                <button className="btn btn-ghost" onClick={cancelMerge}>Cancel</button>
              </>
            ) : (
              <button className="btn btn-primary" onClick={() => addTable(null)}>+ Add Table</button>
            )}
          </div>
        </div>

        {showAddFloor && (
          <div className="card" style={{ padding: 18, borderRadius: 14, marginBottom: 20, display: "flex", gap: 10, alignItems: "flex-end", border: "2px dashed var(--border, #e6e1d6)" }}>
            <div style={{ flex: 1, maxWidth: 260 }}>
              <label style={labelStyle}>Floor Name</label>
              <input placeholder="e.g. Ground Floor, Rooftop" value={newFloorName} onChange={(e) => setNewFloorName(e.target.value)} style={{ ...inputStyle, marginBottom: 0 }} />
            </div>
            <button className="btn btn-primary" onClick={addFloor}>Add Floor</button>
          </div>
        )}

        {mergeMode && (
          <div style={{ background: "#eff6ff", color: "#1e40af", padding: "10px 16px", borderRadius: 10, fontSize: 13, fontWeight: 600, marginBottom: 16 }}>
            Merging into Table {tables.find((t) => t.id === mergePrimary)?.number}. Tap other tables to add them to the group, then Confirm Merge.
          </div>
        )}

        {tables.length === 0 ? (
          <div className="card" style={{ padding: 48, textAlign: "center", color: "var(--text-secondary, #6b6b7b)", borderRadius: 16 }}>
            <div style={{ fontSize: 42, marginBottom: 12 }}>🪑</div>
            <p style={{ margin: 0 }}>No tables yet — add one to generate its QR code.</p>
          </div>
        ) : (
          floorsToShow.map((floor) => {
            const floorTables = useFloors ? tables.filter((t) => t.floorId === floor.id) : tables;
            return (
              <div key={floor.id || "none"} style={{ marginBottom: 32 }}>
                {useFloors && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                    <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>{floor.name}</h3>
                    <button className="btn btn-sm btn-ghost" onClick={() => addTable(floor.id)}>+ Table here</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => deleteFloor(floor)} style={{ color: "#dc2626" }}>Delete Floor</button>
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14 }}>
                  {floorTables.map((t) => {
                    const activeCount = orders.filter((o) => o.table === t.number && !["paid", "cancelled", "declined", "merged"].includes(o.status)).length;
                    const occupied = activeCount > 0;
                    const isMergeSelectable = mergeMode && t.id !== mergePrimary;
                    const isSelected = mergeSelected.includes(t.id);
                    return (
                      <div key={t.id} className="card" onClick={() => { if (isMergeSelectable) toggleMergeSelect(t.id); }}
                        style={{ borderRadius: 16, overflow: "hidden", border: `2px solid ${occupied ? "#dc2626" : "#16a34a"}`, cursor: isMergeSelectable ? "pointer" : "default", outline: isSelected ? "3px solid #7c3aed" : "none" }}>
                        <div style={{ background: occupied ? "#dc2626" : "#16a34a", color: "#fff", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontWeight: 800, fontSize: 15 }}>Table {t.number} {t.isVIP && <span>★</span>}</span>
                          <span style={{ fontSize: 10.5, background: "rgba(255,255,255,0.25)", padding: "3px 9px", borderRadius: 100, fontWeight: 700 }}>{occupied ? `${activeCount} ACTIVE` : "FREE"}</span>
                        </div>
                        <div style={{ padding: 16, textAlign: "center" }}>
                          {t.isMerged && (
                            <div style={{ background: "#ede9fe", color: "#6d28d9", fontSize: 11, fontWeight: 700, padding: "4px 8px", borderRadius: 8, marginBottom: 10 }}>
                              Merged with {(t.mergedWith || []).join(", ")}
                              <button onClick={(e) => { e.stopPropagation(); unmergeTable(t); }} style={{ marginLeft: 8, background: "none", border: "none", color: "#6d28d9", textDecoration: "underline", cursor: "pointer", fontSize: 11 }}>Unmerge</button>
                            </div>
                          )}
                          {features.vipTables && (
                            <button onClick={(e) => { e.stopPropagation(); toggleVip(t); }} className="btn btn-sm" style={{ width: "100%", marginBottom: 8, background: t.isVIP ? "#fef3c7" : "var(--surface-2, #f3efe6)", color: t.isVIP ? "#92400e" : "#888", border: "none" }}>
                              {t.isVIP ? "★ VIP Table" : "Mark as VIP"}
                            </button>
                          )}
                          {/* Seating a table is what opens its ordering window.
                              Until it is seated, its QR code will not accept an
                              order — which is what stops orders arriving from
                              outside the restaurant. */}
                          <button
                            onClick={(e) => { e.stopPropagation(); setSeated(t.number, !sessionOpenFor(t.number)); }}
                            disabled={sessionBusy === t.number}
                            className="btn btn-sm"
                            style={{
                              width: "100%", marginBottom: 8, border: "none",
                              background: sessionOpenFor(t.number) ? "#dcfce7" : "var(--surface-2, #f3efe6)",
                              color: sessionOpenFor(t.number) ? "#166534" : "#888",
                            }}>
                            {sessionBusy === t.number ? "…"
                              : sessionOpenFor(t.number) ? "🟢 Seated · ordering open" : "Seat table"}
                          </button>
                          <div style={{ display: "grid", gridTemplateColumns: (!mergeMode && !t.isMerged) ? "repeat(3, minmax(0, 1fr))" : "repeat(2, minmax(0, 1fr))", gap: 6, marginBottom: 8 }}>
                            <button onClick={(e) => { e.stopPropagation(); openQrFor(t); }} className="btn btn-sm btn-ghost" style={{ minWidth: 0, padding: "8px 4px", fontSize: 12 }}>Print QR</button>
                            {!mergeMode && !t.isMerged && (
                              <button onClick={(e) => { e.stopPropagation(); startMerge(t.id); }} className="btn btn-sm btn-ghost" style={{ minWidth: 0, padding: "8px 4px", fontSize: 12 }}>Merge</button>
                            )}
                            <button onClick={(e) => { e.stopPropagation(); deleteTable(t.id); }} className="btn btn-sm btn-ghost" style={{ minWidth: 0, padding: "8px 4px", fontSize: 12, color: "var(--danger, #dc2626)" }}>Delete</button>
                          </div>
                          {occupied && (
                            <button onClick={(e) => { e.stopPropagation(); freeTable(t.number); }} className="btn btn-sm" style={{ width: "100%", background: "#fef2f2", color: "#dc2626", border: "1px solid #fecaca" }}>
                              Free Table
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    );
  };

  // === RENDER: SETTINGS ===
  const renderSettings = () => (
    <div>
      <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 24, fontFamily: "'Fraunces', serif" }}>Settings</h2>

      {/* Flat full-width logo box — collapsed by default; edit fields only open via "Edit Profile" */}
      <div className="card" style={{ borderRadius: 20, overflow: "hidden", marginBottom: 24 }}>
        <div style={{
          height: 180, position: "relative",
          background: profileForm.logoUrl ? `url(${profileForm.logoUrl}) center/cover` : "linear-gradient(135deg, #1a1a2e, #3a3a5e)",
        }}>
          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(transparent 40%, rgba(0,0,0,0.75))", display: "flex", alignItems: "flex-end", justifyContent: "space-between", padding: 24, gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ fontSize: 22, fontWeight: 800, color: "#fff", margin: 0, fontFamily: "'Fraunces', serif" }}>{profileForm.name || "Your Restaurant"}</h3>
              <p style={{ fontSize: 13.5, color: "rgba(255,255,255,0.85)", margin: "2px 0 0" }}>{profileForm.tagline || "Add a tagline to introduce your place"}</p>
              {profileForm.address && <p style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", margin: "2px 0 0" }}>{profileForm.address}</p>}
            </div>
            {!editingProfile && (
              <button onClick={() => setEditingProfile(true)} className="btn btn-sm" style={{ background: "rgba(255,255,255,0.15)", color: "#fff", border: "1px solid rgba(255,255,255,0.35)", flexShrink: 0 }}>Edit Profile</button>
            )}
          </div>
        </div>
        {editingProfile && (
          <div style={{ padding: 28, maxWidth: 480, margin: "0 auto" }}>
            <label style={labelStyle}>Restaurant Name</label>
            <input value={profileForm.name || ""} onChange={(e) => setProfileForm((p) => ({ ...p, name: e.target.value }))} style={inputStyle} />
            <label style={labelStyle}>Tagline / Slogan</label>
            <input value={profileForm.tagline || ""} onChange={(e) => setProfileForm((p) => ({ ...p, tagline: e.target.value }))} style={inputStyle} />
            <label style={labelStyle}>Address</label>
            <input value={profileForm.address || ""} onChange={(e) => setProfileForm((p) => ({ ...p, address: e.target.value }))} style={inputStyle} />

            <label style={labelStyle}>Logo / Banner Image</label>
            <input ref={logoFileInputRef} type="file" accept="image/*" onChange={(e) => handleLogoUpload(e.target.files[0])} style={{ display: "none" }} />
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
              <button onClick={() => logoFileInputRef.current?.click()} disabled={logoUploading} className="btn btn-ghost" style={{ border: "2px dashed var(--border, #e6e1d6)" }}>{logoUploading ? "Uploading..." : "Upload Image"}</button>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => { setProfileForm(profile); setEditingProfile(false); }} style={{ flex: 1 }}>Cancel</button>
              <button className="btn btn-primary" onClick={saveProfile} style={{ flex: 2 }}>{savedMsg ? "Saved ✓" : "Save Profile"}</button>
            </div>
          </div>
        )}
      </div>

      {/* NEW: Subscription card */}
      <div className="card" style={{ padding: 24, borderRadius: 18, marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Your Plan</h3>
            <p style={{ fontSize: 12.5, color: "var(--text-secondary, #6b6b7b)", margin: 0 }}>{features?.planName || "Base"} plan — manage or upgrade anytime.</p>
          </div>
          <span style={{ background: "#1a1a2e", color: "#fff", fontSize: 12, fontWeight: 800, padding: "6px 14px", borderRadius: 100 }}>{(features?.planName || "BASE").toUpperCase()}</span>
        </div>
        <button className="btn btn-ghost" style={{ marginTop: 16 }} onClick={() => alert("Upgrade flow: contact support or use the in-app UPI upgrade QR once billing automation is wired up.")}>Upgrade Plan</button>
      </div>

      {/* NEW: Bar toggle + badge thresholds */}
      <div className="card" style={{ padding: 24, borderRadius: 18, marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Menu Intelligence</h3>
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5, fontWeight: 600, cursor: "pointer", marginBottom: 18 }}>
          <input type="checkbox" checked={!!siteSettingsForm.hasBar} onChange={(e) => setSiteSettingsForm((p) => ({ ...p, hasBar: e.target.checked }))} />
          🍸 This restaurant runs a Bar section
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5, fontWeight: 600, cursor: "pointer", marginBottom: 6, padding: "12px 14px", borderRadius: 12, background: siteSettingsForm.pureVeg ? "#16a34a12" : "var(--surface-2, #f3efe6)", border: siteSettingsForm.pureVeg ? "1px solid #16a34a55" : "1px solid transparent" }}>
          <input type="checkbox" checked={!!siteSettingsForm.pureVeg} onChange={(e) => setSiteSettingsForm((p) => ({ ...p, pureVeg: e.target.checked }))} />
          🌱 Pure Veg Restaurant
        </label>
        <p style={{ fontSize: 11.5, color: "#999", marginTop: -2, marginBottom: 18 }}>
          When on, "Non-veg" is removed everywhere — the veg/non-veg picker, indicator dots, import columns, and every other mention disappear across Menu, POS and imports. New items are always saved as veg.
        </p>

        <label style={labelStyle}>Google Review Link</label>
        <input
          placeholder="https://g.page/r/your-restaurant/review"
          value={siteSettingsForm.googleReviewLink}
          onChange={(e) => setSiteSettingsForm((p) => ({ ...p, googleReviewLink: e.target.value }))}
          style={inputStyle}
        />
        <p style={{ fontSize: 11.5, color: "#999", marginTop: -6, marginBottom: 14 }}>
          Find this on your Google Business Profile under "Ask for reviews" — it is a link, not your
          business's public listing URL.
        </p>
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5, fontWeight: 600, cursor: "pointer", marginBottom: 18 }}>
          <input type="checkbox" checked={!!siteSettingsForm.googleReviewEnabled} onChange={(e) => setSiteSettingsForm((p) => ({ ...p, googleReviewEnabled: e.target.checked }))} />
          ⭐ Prompt customers to rate us on Google
        </label>
        <p style={{ fontSize: 11.5, color: "#999", marginTop: -14, marginBottom: 18 }}>
          When on, a customer who rates their order in the app is offered a one-tap "Rate us on
          Google" button right after — the in-app star rating is still collected either way. Turning
          this off hides the button without losing the link you saved above, so you can switch it
          back on later without re-typing it.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <div>
            <label style={labelStyle}>Most Loved at ★</label>
            <input type="number" step="0.1" value={siteSettingsForm.thresholdMostLoved} onChange={(e) => setSiteSettingsForm((p) => ({ ...p, thresholdMostLoved: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Most Ordered at (orders)</label>
            <input type="number" value={siteSettingsForm.thresholdMostOrdered} onChange={(e) => setSiteSettingsForm((p) => ({ ...p, thresholdMostOrdered: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Most Rated at (reviews)</label>
            <input type="number" value={siteSettingsForm.thresholdMostRated} onChange={(e) => setSiteSettingsForm((p) => ({ ...p, thresholdMostRated: e.target.value }))} style={inputStyle} />
          </div>
        </div>
        <p style={{ fontSize: 11.5, color: "#999", marginTop: 10, marginBottom: 14 }}>
          These badges are calculated automatically — Most Ordered from your billed/paid orders, Most Loved and Most Rated from item ratings (once your review flow is writing <code>rating</code>/<code>ratingCount</code> onto menu items). They also drive the "Loved by Everyone" carousel on the customer menu (top 5, colour-coded).
        </p>
        <button className="btn btn-primary" onClick={saveSiteSettings} style={{ marginTop: 4 }}>{siteSettingsSaved ? "Saved ✓" : "Save Settings"}</button>
      </div>

      {/* Billing + Staff side by side */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 24, marginBottom: 24 }}>
        <div className="card" style={{ padding: 24, borderRadius: 18 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Billing Settings</h3>
          <label style={labelStyle}>Tax / GST %</label>
          <input type="number" value={billingForm.taxPercent} onChange={(e) => setBillingForm((p) => ({ ...p, taxPercent: e.target.value }))} style={inputStyle} />
          <label style={labelStyle}>Service Charge %</label>
          <input type="number" value={billingForm.servicePercent} onChange={(e) => setBillingForm((p) => ({ ...p, servicePercent: e.target.value }))} style={inputStyle} />
          {features.upiQr && (
            <>
              <label style={labelStyle}>UPI ID (for payment QR)</label>
              <input placeholder="yourhotel@upi" value={billingForm.upiId || ""} onChange={(e) => setBillingForm((p) => ({ ...p, upiId: e.target.value }))} style={inputStyle} />
              <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5, fontWeight: 600, cursor: "pointer", marginBottom: 16, marginTop: -2 }}>
                <input type="checkbox" checked={!!billingForm.upiSelfPayEnabled} onChange={(e) => setBillingForm((p) => ({ ...p, upiSelfPayEnabled: e.target.checked }))} />
                🔗 Enable customer self-payment via UPI QR
              </label>
              <p style={{ fontSize: 11.5, color: "#999", marginTop: -10, marginBottom: 14 }}>
                Off by default. Turn this on and save to make "Bill + QR" available on the dashboard — the QR only reaches the table's bill screen once a receptionist taps it with this enabled.
              </p>
            </>
          )}
          <button className="btn btn-primary" onClick={saveBilling}>{billingSaved ? "Saved ✓" : "Save Billing Settings"}</button>
        </div>

        {/* Staff management moved to the brand console (/brand -> Team).
            Inviting people is a brand-level act -- an owner adds managers and
            assigns them outlets, a manager adds floor staff for the outlets
            they hold -- and reception should not see it at all. */}
        {can(access, "inviteFloorStaff") && (
          <div className="card" style={{ padding: 24, borderRadius: 18 }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>Staff</h3>
            <p style={{ fontSize: 12.5, color: "var(--text-secondary, #6b6b7b)", marginBottom: 16 }}>
              Invitations and roles are managed in the brand console, where you can assign
              which outlets each person works at.
            </p>
            <button className="btn btn-primary" onClick={() => router.push("/brand")}>
              Manage team in the brand console
            </button>
          </div>
        )}
      </div>
    </div>
  );

  // === SPLASH ===
  const renderSplash = () => (
    <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "linear-gradient(135deg, #1a1a2e 0%, #241f3d 55%, #2d1b1b 100%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", opacity: splashLeaving ? 0 : 1, transition: "opacity 0.5s ease" }} onClick={dismissSplash}>
      <div style={{ animation: "splashPop 0.9s cubic-bezier(0.22, 1, 0.36, 1)", textAlign: "center", padding: 20 }}>
        {profile?.logoUrl && <img src={profile.logoUrl} alt="" style={{ width: 74, height: 74, borderRadius: "50%", objectFit: "cover", margin: "0 auto 20px", display: "block", border: "3px solid rgba(232,163,61,0.6)", animation: "splashGlow 2.2s ease-in-out infinite" }} />}
        <div style={{ fontFamily: "'Fraunces', serif", fontSize: isMobile ? 30 : 44, fontWeight: 700, color: "#fff", letterSpacing: 0.5, animation: "splashLetters 1s ease" }}>{profile?.name || "Cabadra"}</div>
        <div style={{ width: 46, height: 2, background: "#e8a33d", margin: "16px auto", animation: "splashLine 0.9s ease 0.3s both" }} />
        <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.55)", letterSpacing: 1.5, textTransform: "uppercase", animation: "splashFade 1s ease 0.5s both" }}>Powered by Cabadra</div>
      </div>
    </div>
  );

  // === floor picker modal ===
  const floorPickerModal = showFloorPicker && floors.length > 1 && (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", borderRadius: 20, padding: 28, maxWidth: 360, width: "90%", textAlign: "center" }}>
        <h3 style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>Which floor are you working today?</h3>
        <p style={{ fontSize: 13, color: "#888", marginBottom: 18 }}>You can switch anytime from the Tables tab.</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {floors.map((f) => (
            <button key={f.id} onClick={() => { setSelectedFloorId(f.id); setActiveTab("tables"); setShowFloorPicker(false); }} className="btn btn-ghost" style={{ padding: 14 }}>{f.name}</button>
          ))}
          <button onClick={() => setShowFloorPicker(false)} style={{ background: "none", border: "none", color: "#888", fontSize: 13, marginTop: 8, cursor: "pointer" }}>Skip — show all floors</button>
        </div>
      </div>
    </div>
  );

  // === split bill modal ===
  const splitBillModal = splitBillOrder && (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setSplitBillOrder(null)}>
      <div style={{ background: "#fff", borderRadius: 20, padding: 28, maxWidth: 340, width: "90%" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: 18, fontWeight: 800, marginBottom: 14 }}>Split Bill — Table {splitBillOrder.table}</h3>
        <p style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>Splits the ₹{splitBillOrder.billTotal} total evenly. Each guest gets their own "Mark Paid" — the table frees once everyone's paid.</p>
        <label style={labelStyle}>Number of guests</label>
        <input type="number" min={2} value={splitCount} onChange={(e) => setSplitCount(e.target.value)} style={inputStyle} />
        <div style={{ fontSize: 13, color: "#555", marginBottom: 16 }}>≈ ₹{Math.round((splitBillOrder.billTotal / Math.max(2, parseInt(splitCount) || 2)) * 100) / 100} per person</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => setSplitBillOrder(null)} style={{ flex: 1 }}>Cancel</button>
          <button className="btn btn-primary" onClick={confirmEvenSplit} style={{ flex: 1 }}>Split</button>
        </div>
      </div>
    </div>
  );

  // === NEW: QR modal ===
  const qrModal = qrModalTable && (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setQrModalTable(null)}>
      <div style={{ background: "#fff", borderRadius: 20, padding: 28, maxWidth: 320, width: "90%", textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: 18, fontWeight: 800, marginBottom: 4 }}>Table {qrModalTable.number}</h3>
        <p style={{ fontSize: 12.5, color: "#888", margin: "0 0 14px", lineHeight: 1.5 }}>
          {qrIssuing
            ? "Generating a secure code…"
            : "This code is unique to this table. Print it and replace the one currently on the table."}
        </p>
        {siteUrl && !qrIssuing && (
          <img src={qrUrlFor(qrModalTable.number, qrToken)} alt="" style={{ width: 200, height: 200, marginBottom: 12 }} />
        )}
        {qrToken && (
          <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", borderRadius: 10, padding: 11, fontSize: 12.5, lineHeight: 1.5, marginBottom: 14, textAlign: "left" }}>
            <strong>Table {qrModalTable.number} is now protected.</strong> Orders from this table need this
            code and an open session, so nobody can order for it from outside the restaurant.
            <br />Print this now — the code cannot be shown again.
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => { setQrModalTable(null); setQrToken(""); }} style={{ flex: 1 }}>Close</button>
          <button className="btn btn-primary" disabled={qrIssuing} onClick={() => printQr(qrModalTable.number, qrToken)} style={{ flex: 1 }}>Print</button>
        </div>
      </div>
    </div>
  );

  // === NEW: Move order modal ===
  const moveOrderModal = movingOrder && (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setMovingOrder(null)}>
      <div style={{ background: "#fff", borderRadius: 20, padding: 28, maxWidth: 320, width: "90%" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: 18, fontWeight: 800, marginBottom: 14 }}>Move Order — Table {movingOrder.table}</h3>
        <label style={labelStyle}>New Table</label>
        <select value={moveTargetTable} onChange={(e) => setMoveTargetTable(e.target.value)} style={inputStyle}>
          <option value="">Select table</option>
          {tables.filter((t) => t.number !== movingOrder.table).map((t) => <option key={t.id} value={t.number}>Table {t.number}</option>)}
        </select>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => setMovingOrder(null)} style={{ flex: 1 }}>Cancel</button>
          <button className="btn btn-primary" onClick={confirmMoveOrder} style={{ flex: 1 }}>Move</button>
        </div>
      </div>
    </div>
  );

  // === NEW: unified "Generate Bill" flow — collects optional customer info
  // AND the payment method up front (instead of asking payment method later
  // at Mark Paid time). Choosing UPI shows the QR + "Open in UPI App" button
  // right there on the bill; any other method just shows the plain bill.
  const availableRiders = activeRiders(riders);
  const dispatchModal = dispatchOrder && (
    <div style={modalOverlayStyle} onClick={() => setDispatchOrder(null)}>
      <div style={modalBoxStyle} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>Hand to a rider</h3>
        <p style={{ fontSize: 12.5, color: "#888", marginBottom: 16 }}>
          The customer is shown this name and number so they can be reached about a door code or a
          wrong turn. A rider nobody can call is the commonest reason a delivery goes wrong.
        </p>

        {availableRiders.length > 0 ? (
          <>
            <label style={labelStyle}>Rider</label>
            <div style={{ display: "grid", gap: 8, marginBottom: 6 }}>
              {availableRiders.map((r) => (
                <button key={r.id} type="button"
                  onClick={() => { setSelectedRiderId(r.id); setRiderErrors({}); }}
                  style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "12px 14px", borderRadius: 12, cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                    border: selectedRiderId === r.id ? "2px solid #1a1a2e" : "1.5px solid var(--border, #e6e1d6)",
                    background: selectedRiderId === r.id ? "#faf8f5" : "var(--surface, #fff)",
                  }}>
                  <span style={{ fontSize: 14.5, fontWeight: 700, color: "#1a1a2e" }}>{r.name}</span>
                  <span style={{ fontSize: 12.5, color: "#888" }}>{r.phone}</span>
                </button>
              ))}
            </div>
            {riderErrors.phone && <div style={{ color: "#dc2626", fontSize: 12, marginBottom: 10 }}>{riderErrors.phone}</div>}
          </>
        ) : (
          <div style={{ background: "#fef3c7", border: "1px solid #fde68a", color: "#92400e", borderRadius: 10, padding: 12, fontSize: 12.5, lineHeight: 1.5, marginBottom: 14 }}>
            No riders added yet. Add one under <strong>Online Ordering → Riders</strong> in settings, then come back here.
          </div>
        )}

        {deliveryDetails[dispatchOrder.id] && (
          <div style={{ background: "#e0f2fe", color: "#0369a1", borderRadius: 10, padding: 11, fontSize: 12.5, lineHeight: 1.5, marginBottom: 14 }}>
            <strong>{deliveryDetails[dispatchOrder.id].name}</strong> · {deliveryDetails[dispatchOrder.id].phone}
            <br />{formatDeliveryAddress(deliveryDetails[dispatchOrder.id])}
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setDispatchOrder(null)}>Cancel</button>
          <button className="btn btn-primary" style={{ flex: 1 }} disabled={!selectedRiderId} onClick={confirmDispatch}>Send it</button>
        </div>
      </div>
    </div>
  );

  const billFlowModal = billFlowOrder && (
    <div style={modalOverlayStyle} onClick={() => setBillFlowOrder(null)}>
      <div style={modalBoxStyle} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>
          Generate Bill — {isDelivery(billFlowOrder) ? "Delivery" : `Table ${billFlowOrder.table}`}
        </h3>
        {billFlowForm.prefilled ? (
          <div style={{ background: "#e0f2fe", border: "1px solid #bae6fd", color: "#0369a1", borderRadius: 10, padding: 11, fontSize: 12.5, lineHeight: 1.5, marginBottom: 16 }}>
            Filled in from what the customer entered at checkout. Edit anything that looks wrong.
          </div>
        ) : (
          <p style={{ fontSize: 12.5, color: "#888", marginBottom: 16 }}>Customer details are optional. Payment method decides whether a UPI QR is shown on the bill.</p>
        )}

        <label style={labelStyle}>Customer Name (optional)</label>
        <input placeholder="e.g. Rahul Sharma" value={billFlowForm.name} onChange={(e) => setBillFlowForm((p) => ({ ...p, name: e.target.value }))} style={inputStyle} />
        <label style={labelStyle}>Phone (optional)</label>
        <input placeholder="e.g. 98765 43210" value={billFlowForm.phone} onChange={(e) => setBillFlowForm((p) => ({ ...p, phone: e.target.value }))} style={inputStyle} />

        <label style={labelStyle}>Payment Method</label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, marginBottom: 6 }}>
          {PAYMENT_METHODS.map((m) => {
            const selected = billFlowForm.paymentMethod === m.key;
            return (
              <button key={m.key} type="button" onClick={() => setBillFlowForm((p) => ({ ...p, paymentMethod: m.key }))}
                style={{ padding: "10px 8px", borderRadius: 10, border: selected ? "2px solid #e8a33d" : "1px solid #ddd", background: selected ? "#e8a33d15" : "#fff", cursor: "pointer", fontWeight: 700, fontSize: 13 }}>
                {m.icon} {m.label}
              </button>
            );
          })}
        </div>
        {billFlowForm.paymentMethod === "upi" && !(billing.upiId && billing.upiSelfPayEnabled) && (
          <p style={{ fontSize: 11.5, color: "#e8a33d", background: "#fffbeb", padding: 10, borderRadius: 8, marginBottom: 4 }}>
            ⚠️ UPI self-pay QR isn't set up yet (Settings → Billing). The bill will still be generated and marked as UPI, just without a scannable QR.
          </p>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button className="btn btn-ghost" onClick={() => setBillFlowOrder(null)} style={{ flex: 1 }}>Cancel</button>
          <button className="btn btn-primary" onClick={() => { generateBill(billFlowOrder, billFlowForm.paymentMethod === "upi", billFlowForm); setBillFlowOrder(null); }} style={{ flex: 2 }}>Generate Bill</button>
        </div>
      </div>
    </div>
  );

  // === NEW: POS size / add-on picker — mirrors the customer table-side flow.
  // Opens whenever a tapped item has variations and/or add-ons configured.
  const posVariantModalUi = posVariantModal && (() => {
    const { item } = posVariantModal;
    const variations = item.variations || [];
    const addons = item.addons || [];
    const variation = variations.find((v) => v.id === posVariantModal.variationId);
    const basePrice = variation ? variation.price : item.price;
    const addonsTotal = addons.filter((a) => posVariantModal.addonIds.includes(a.id)).reduce((s, a) => s + a.price, 0);
    const linePrice = (basePrice + addonsTotal) * posVariantModal.qty;
    const canAdd = variations.length === 0 || !!posVariantModal.variationId;
    return (
      <div style={modalOverlayStyle} onClick={() => setPosVariantModal(null)}>
        <div style={{ ...modalBoxStyle, maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
          <h3 style={{ fontSize: 18, fontWeight: 800, marginBottom: 4 }}>{item.name}</h3>
          <p style={{ fontSize: 12.5, color: "#888", marginBottom: 14 }}>Choose options for this item.</p>

          {variations.length > 0 && (
            <>
              <label style={labelStyle}>Choose Size *</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                {variations.map((v) => {
                  const selected = posVariantModal.variationId === v.id;
                  return (
                    <label key={v.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderRadius: 10, border: selected ? "2px solid #e8a33d" : "1px solid #ddd", background: selected ? "#e8a33d10" : "#fff", cursor: "pointer" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 13.5 }}>
                        <input type="radio" name="posVariant" checked={selected} onChange={() => setPosVariantModal((p) => ({ ...p, variationId: v.id }))} /> {v.name}
                      </span>
                      <span style={{ fontWeight: 700, color: "#e8a33d" }}>₹{v.price}</span>
                    </label>
                  );
                })}
              </div>
            </>
          )}

          {addons.length > 0 && (
            <>
              <label style={labelStyle}>Add-ons (optional)</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                {addons.map((a) => {
                  const selected = posVariantModal.addonIds.includes(a.id);
                  return (
                    <label key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderRadius: 10, border: selected ? "2px solid #0369a1" : "1px solid #ddd", background: selected ? "#0369a110" : "#fff", cursor: "pointer" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 13.5 }}>
                        <input type="checkbox" checked={selected} onChange={() => setPosVariantModal((p) => ({ ...p, addonIds: selected ? p.addonIds.filter((id) => id !== a.id) : [...p.addonIds, a.id] }))} /> {a.name}
                      </span>
                      <span style={{ fontWeight: 700, color: "#0369a1" }}>+₹{a.price}</span>
                    </label>
                  );
                })}
              </div>
            </>
          )}

          <label style={labelStyle}>Quantity</label>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <button onClick={() => setPosVariantModal((p) => ({ ...p, qty: Math.max(1, p.qty - 1) }))} className="btn btn-sm btn-ghost" style={{ width: 32 }}>-</button>
            <span style={{ fontWeight: 800, fontSize: 16, minWidth: 20, textAlign: "center" }}>{posVariantModal.qty}</span>
            <button onClick={() => setPosVariantModal((p) => ({ ...p, qty: p.qty + 1 }))} className="btn btn-sm btn-ghost" style={{ width: 32 }}>+</button>
            <span style={{ marginLeft: "auto", fontWeight: 800, fontSize: 15 }}>₹{linePrice}</span>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => setPosVariantModal(null)} style={{ flex: 1 }}>Cancel</button>
            <button className="btn btn-primary" disabled={!canAdd} onClick={() => { posAddLine(item, posVariantModal.variationId, posVariantModal.addonIds, posVariantModal.qty); setPosVariantModal(null); }} style={{ flex: 2, opacity: canAdd ? 1 : 0.5 }}>Add to Cart</button>
          </div>
        </div>
      </div>
    );
  })();

  // === RETURN ===
  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@600;700&family=Inter:wght@400;500;600;700;800&display=swap');
        @keyframes riseIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes splashPop { from { opacity: 0; transform: scale(0.88); } to { opacity: 1; transform: scale(1); } }
        @keyframes splashGlow { 0%, 100% { box-shadow: 0 0 0 0 rgba(232,163,61,0.35); } 50% { box-shadow: 0 0 0 14px rgba(232,163,61,0); } }
        @keyframes splashLetters { from { opacity: 0; letter-spacing: 6px; } to { opacity: 1; letter-spacing: 0.5px; } }
        @keyframes splashLine { from { width: 0; } to { width: 46px; } }
        @keyframes splashFade { from { opacity: 0; } to { opacity: 1; } }

        .card { background: var(--surface, #ffffff) !important; border: 1px solid var(--border, #e6e1d6) !important; box-shadow: 0 1px 3px rgba(20,20,30,0.05), 0 1px 2px rgba(20,20,30,0.03) !important; border-radius: 14px; }
        .btn { font-family: inherit !important; font-weight: 700 !important; border-radius: 10px !important; cursor: pointer !important; border: none !important; padding: 11px 20px !important; font-size: 14px !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; gap: 6px !important; transition: transform 0.12s ease, box-shadow 0.12s ease, filter 0.12s ease !important; line-height: 1.2 !important; }
        .btn:hover { transform: translateY(-1px); filter: brightness(1.04); }
        .btn:active { transform: translateY(0); filter: brightness(0.98); }
        .btn-sm { padding: 8px 14px !important; font-size: 13px !important; border-radius: 8px !important; }
        .btn-primary { background: #e8a33d !important; color: #ffffff !important; box-shadow: 0 2px 6px rgba(232,163,61,0.35) !important; }
        .btn-danger { background: #fef2f2 !important; color: #dc2626 !important; }
        .btn-success { background: #16a34a !important; color: #ffffff !important; box-shadow: 0 2px 6px rgba(22,163,74,0.3) !important; }
        .btn-ghost { background: var(--surface-2, #f3efe6) !important; color: var(--text-secondary, #6b6b7b) !important; border: 1px solid var(--border, #e6e1d6) !important; }
        .badge { display: inline-flex !important; align-items: center !important; padding: 3px 10px !important; border-radius: 100px !important; font-size: 11.5px !important; font-weight: 700 !important; background: var(--surface-2, #f3efe6) !important; color: var(--text-secondary, #6b6b7b) !important; }
        .badge-billed { background: #ede9fe !important; color: #6d28d9 !important; }
        .to-input { width: 100%; box-sizing: border-box; padding: 11px 14px; border: 1px solid var(--border, #e6e1d6); border-radius: 10px; font-size: 14px; background: var(--surface, #ffffff); font-family: inherit; color: var(--text, #1a1a2e); }
        .to-input:focus, select:focus, input:focus { outline: none; border-color: #e8a33d; box-shadow: 0 0 0 3px rgba(232,163,61,0.15); }
      `}</style>

      {showSplash && renderSplash()}
      {floorPickerModal}
      {splitBillModal}
      {qrModal}
      {moveOrderModal}
      {dispatchModal}
      {billFlowModal}
      {posVariantModalUi}

      {isMobile && sidebarOpen && <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 99 }} onClick={() => setSidebarOpen(false)} />}

      <aside className="no-print" style={{
        width: isMobile ? 260 : (sidebarCollapsed ? 78 : 260), background: "#1a1a2e", color: "#fff", position: "fixed", left: 0, top: 0, bottom: 0,
        overflowY: "auto", overflowX: "hidden", zIndex: 100, display: "flex", flexDirection: "column",
        transform: isMobile ? (sidebarOpen ? "translateX(0)" : "translateX(-100%)") : "translateX(0)", transition: "transform 0.3s ease, width 0.22s ease",
      }}>
        <div style={{ padding: sidebarCollapsed && !isMobile ? "22px 14px" : "24px 20px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, overflow: "hidden" }}>
            {profile?.logoUrl ? <img src={profile.logoUrl} alt="" style={{ width: 30, height: 30, borderRadius: 9, objectFit: "cover", flexShrink: 0 }} /> : <div style={{ width: 30, height: 30, borderRadius: 9, background: "#5B9BD5", flexShrink: 0 }} />}
            {(!sidebarCollapsed || isMobile) && (
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 17, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{profile?.name || "Your Restaurant"}</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>Reception Desk</div>
              </div>
            )}
          </div>
          {!isMobile && (
            <button onClick={() => setSidebarCollapsed((c) => !c)} style={{ background: "rgba(255,255,255,0.08)", border: "none", color: "rgba(255,255,255,0.7)", width: 26, height: 26, borderRadius: 8, cursor: "pointer", flexShrink: 0, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center" }}>{sidebarCollapsed ? "»" : "«"}</button>
          )}
        </div>
        <nav style={{ padding: 12, display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
          {TABS.map((tab) => (
            <button key={tab.id} onClick={() => { setActiveTab(tab.id); setDashboardView("main"); if (isMobile) setSidebarOpen(false); }}
              style={{ width: "100%", textAlign: "left", padding: sidebarCollapsed && !isMobile ? "12px 0" : "12px 16px", justifyContent: sidebarCollapsed && !isMobile ? "center" : "flex-start", borderRadius: 10, border: "none", background: activeTab === tab.id ? "rgba(91,155,213,0.18)" : "transparent", color: activeTab === tab.id ? "#5B9BD5" : "rgba(255,255,255,0.75)", fontSize: 14.5, fontWeight: 800, cursor: "pointer", display: "flex", alignItems: "center", gap: 12, transition: "all 0.15s ease", position: "relative" }}>
              {(!sidebarCollapsed || isMobile) ? tab.label : tab.label.charAt(0)}
              {tab.id === "dashboard" && (pending.length + billRequested.length + pendingWaiterCalls.length > 0) && (
                <span style={{ marginLeft: sidebarCollapsed && !isMobile ? 0 : "auto", position: sidebarCollapsed && !isMobile ? "absolute" : "static", top: sidebarCollapsed && !isMobile ? 6 : "auto", right: sidebarCollapsed && !isMobile ? 10 : "auto", background: "#dc2626", color: "#fff", fontSize: 10.5, fontWeight: 800, padding: "2px 7px", borderRadius: 100 }}>{pending.length + billRequested.length + pendingWaiterCalls.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div style={{ padding: sidebarCollapsed && !isMobile ? "16px 0" : 20, borderTop: "1px solid rgba(255,255,255,0.08)", fontSize: 11.5, color: "rgba(255,255,255,0.4)", textAlign: sidebarCollapsed && !isMobile ? "center" : "left" }}>
          {sidebarCollapsed && !isMobile ? "T.O." : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {/* Outlet switcher — only meaningful once this person reaches more
                  than one. setActiveOutlet refuses ids outside their access. */}
              {/* Switcher is for people who manage across outlets. Reception
                  works one outlet and must not be able to move between them,
                  so this is gated on capability, not just on list length. */}
              {can(access, "viewAllOutletReports") && outlets.length > 1 && (
                <div>
                  <div style={{ fontSize: 10.5, letterSpacing: 0.6, textTransform: "uppercase", color: "rgba(255,255,255,0.35)", marginBottom: 6 }}>Outlet</div>
                  <select
                    value={restaurantId || ""}
                    onChange={(e) => setActiveOutlet(e.target.value)}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.08)", color: "#fff", fontSize: 12.5, fontWeight: 700, fontFamily: "inherit" }}
                  >
                    {outlets.map((o) => <option key={o.id} value={o.id} style={{ color: "#1a1a2e" }}>{o.name || o.id.slice(0, 6)}</option>)}
                  </select>
                </div>
              )}
              {brandId && can(access, "viewAllOutletReports") && (
                <button onClick={() => router.push("/brand")} style={{ background: "rgba(255,255,255,0.1)", border: "none", color: "#fff", padding: "8px 12px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 700, width: "100%" }}>
                  🏢 Brand console
                </button>
              )}
              <span>Powered by Cabadra</span>
              <button onClick={logout} style={{ background: "rgba(220,38,38,0.15)", border: "none", color: "#fca5a5", padding: "8px 12px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 700, width: "100%" }}>Logout {role ? `(${role})` : ""}</button>
            </div>
          )}
        </div>
      </aside>

      <main style={{ marginLeft: isMobile ? 0 : (sidebarCollapsed ? 78 : 260), flex: 1, background: "var(--bg, #faf8f2)", minHeight: "100vh", width: "100%", transition: "margin-left 0.22s ease" }}>
        {isMobile && (
          <div className="no-print" style={{ padding: "16px 20px", background: "#1a1a2e", color: "#fff", display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => setSidebarOpen(true)} style={{ background: "none", border: "none", color: "#fff", fontSize: 20, cursor: "pointer" }}>☰</button>
            <span style={{ fontWeight: 700 }}>{TABS.find((t) => t.id === activeTab)?.label}</span>
          </div>
        )}
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: isMobile ? "20px" : "32px" }}>
          {activeTab === "dashboard" && renderDashboard()}
          {activeTab === "pos" && renderPOS()}
          {activeTab === "kitchen" && renderKitchenView()}
          {activeTab === "menu" && renderMenu()}
          {activeTab === "tables" && renderTables()}
          {activeTab === "crm" && renderCRM()}
          {activeTab === "online" && (
            <OnlineOrderingSection
              outletId={restaurantId}
              restaurantName={profile?.name || ""}
              settings={settingsDoc}
            />
          )}
          {activeTab === "settings" && renderSettings()}
        </div>
      </main>
    </div>
  );
}