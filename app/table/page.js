"use client";


import { Suspense, useEffect, useState, useRef, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { db } from "@/lib/firebase";
import { collection, addDoc, setDoc, updateDoc, doc, onSnapshot, query, where, orderBy, writeBatch } from "firebase/firestore";
import { computeOfferPrice, computeBogoDiscount, receiptFor } from "@/lib/pricing";
import { mergeItemLines, tableSessionWindowStart } from "@/lib/orders";
import { recommendationsFor } from "@/lib/recommendations";
import { PAYMENT_METHODS } from "@/lib/payment-methods";
import { useRecModel } from "@/lib/use-outlet-data";
import {
  ORDER_TYPES, DELIVERY_TABLE, validateDeliveryDetails, normalizePhone,
  deliveryTimeline, deliveryStage, isDeliveryComplete, DELIVERY_STAGES,
  deliveryOrderErrorMessage,
} from "@/lib/order-types";
import PhoneVerification from "@/components/PhoneVerification";
import { isOtpEnabled } from "@/lib/phone-auth";
import { toE164 } from "@/lib/phone";
import { isSessionOpen, BLOCKED_MESSAGES } from "@/lib/table-session";
import {
  DEFAULT_WEBSITE, orderingBlockedReason, blockedMessage,
  deliveryFeeFor, shortfallToFreeDelivery, todayHoursLabel, isOpenAt,
} from "@/lib/website-setup";

const POPULAR_LIMIT = 8;
const DISPLAY_FONT = "'Anton', sans-serif";
const SPICE_LEVELS = ["Mild", "Medium", "Hot", "Extra Hot"];

const CATEGORY_ICONS = {
  All: "🍽️", Starters: "🥗", Soups: "🍲", Soup: "🍲", Salads: "🥙", Salad: "🥙",
  Mains: "🍛", "Main Course": "🍛", "North Indian": "🍛", "South Indian": "🥞",
  Chinese: "🥡", "Indo Chinese": "🥡", Tandoor: "🍢", Tandoori: "🍢", Biryani: "🍚",
  "Breads & Rice": "🍞", Breads: "🫓", Bread: "🫓", Rice: "🍚", Rolls: "🌯",
  Wraps: "🌯", Sandwiches: "🥪", Pizza: "🍕", Continental: "🍝", Pasta: "🍝",
  Sizzlers: "🔥", Chaat: "🥘", "Pan Asian": "🍜", Noodles: "🍜", Seafood: "🦐",
  Grill: "🍖", BBQ: "🍖", Beverages: "🥤", Drinks: "🥤", Mocktails: "🍹",
  Shakes: "🥤", Milkshakes: "🥤", Juices: "🧃", Desserts: "🍰", "Ice Cream": "🍨",
  "Live Counter": "👨‍🍳", Combos: "🍱", "Combo Packs": "🍱", "Kids Menu": "🧒",
};

// NEW: catchy background palette for the "Loved by Everyone" spotlight carousel.
const SPOTLIGHT_COLORS = ["#FFF4E0", "#E7F8EF", "#EAF1FF", "#FDEAF0", "#F3ECFF"];

const WAITER_REASONS = [
  { key: "water", icon: "💧", label: "Water" },
  { key: "tissues", icon: "🧻", label: "Tissues" },
  { key: "cutlery", icon: "🍴", label: "Cutlery" },
  { key: "seasoning", icon: "🧂", label: "Seasoning / Condiments" },
  { key: "other", icon: "✋", label: "Something else" },
];
// The literal label a waiter call is raised with when a diner taps
// "Request Bill" on the Status screen — kept as one constant so the trigger
// and the reception-side icon lookup can never drift out of sync with each
// other, the way the two separate WAITER_REASONS copies already can.
const BILL_REQUEST_LABEL = "Request Bill";

function getCategoryIcon(cat, categoryIconMap) {
  if (categoryIconMap && categoryIconMap[cat]) return { type: "image", src: categoryIconMap[cat] };
  return { type: "emoji", value: CATEGORY_ICONS[cat] || "🍴" };
}

let _audioCtx = null;
function getAudioCtx() {
  if (typeof window === "undefined") return null;
  try {
    if (!_audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      _audioCtx = new Ctx();
    }
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    return _audioCtx;
  } catch { return null; }
}
function playTone(freq = 600, duration = 100, type = "sine") {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.07, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration / 1000);
  } catch {}
}
function playChime() {
  playTone(660, 130, "triangle");
  setTimeout(() => playTone(880, 190, "triangle"), 120);
  setTimeout(() => playTone(1040, 220, "triangle"), 260);
}

export const GLOBAL_ANIMATION_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700;800&display=swap');
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes slideUp { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes popIn { from { opacity: 0; transform: scale(0.85); } to { opacity: 1; transform: scale(1); } }
  @keyframes checkPop { 0% { transform: scale(0); } 60% { transform: scale(1.15); } 100% { transform: scale(1); } }
  @keyframes toastSlideDown { from { opacity: 0; transform: translate(-50%, -18px); } to { opacity: 1; transform: translate(-50%, 0); } }
  @keyframes floatUp { 0% { opacity: 0; transform: translateY(0) scale(0.8); } 25% { opacity: 1; transform: translateY(-6px) scale(1); } 100% { opacity: 0; transform: translateY(-40px) scale(1); } }
  @keyframes bump { 0% { transform: scale(1); } 35% { transform: scale(1.35) rotate(-8deg); } 60% { transform: scale(0.92) rotate(4deg); } 100% { transform: scale(1) rotate(0deg); } }
  @keyframes splashPop { from { opacity: 0; transform: scale(0.88); } to { opacity: 1; transform: scale(1); } }
  @keyframes splashGlow { 0%, 100% { box-shadow: 0 0 0 0 rgba(232,163,61,0.35); } 50% { box-shadow: 0 0 0 14px rgba(232,163,61,0); } }
  @keyframes splashLetters { from { opacity: 0; letter-spacing: 6px; } to { opacity: 1; letter-spacing: 0.5px; } }
  @keyframes splashLine { from { width: 0; } to { width: 46px; } }
  @keyframes splashFade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes layerDrop { 0% { opacity: 0; transform: translateY(-50px) rotate(-8deg); } 60% { opacity: 1; transform: translateY(6px) rotate(3deg); } 100% { opacity: 1; transform: translateY(0) rotate(0deg); } }
  @keyframes modalScaleIn { from { opacity: 0; transform: scale(0.9) translateY(10px); } to { opacity: 1; transform: scale(1) translateY(0); } }
  @keyframes starPulse { 0% { transform: scale(1); } 50% { transform: scale(1.3); } 100% { transform: scale(1); } }
  @keyframes recSlideIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
  .tap-btn { transition: transform 0.12s ease, filter 0.12s ease; }
  .tap-btn:active { transform: scale(0.94); filter: brightness(0.97); }
  .cart-bump { display: inline-flex; animation: bump 0.4s ease; }
  .menu-card-plus-float { position: absolute; top: 10px; right: 10px; background: #1a1a2e; color: #fff; font-size: 12px; font-weight: 800; padding: 2px 9px; border-radius: 100px; animation: floatUp 0.7s ease forwards; pointer-events: none; z-index: 3; }
  .rec-banner { animation: recSlideIn 0.4s cubic-bezier(0.22,1,0.36,1); }
  .shimmer-bg { background: linear-gradient(90deg, #fef3c7 25%, #fde68a 50%, #fef3c7 75%); background-size: 200% 100%; animation: shimmer 2s infinite; }
`;

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------
function VegBadge({ foodType }) {
  if (!foodType) return null;
  const isVeg = foodType === "veg";
  return (
    <span title={isVeg ? "Veg" : "Non-veg"} style={{ display: "inline-block", width: 13, height: 13, border: `1.5px solid ${isVeg ? "#16a34a" : "#dc2626"}`, borderRadius: 3, position: "relative", flexShrink: 0 }}>
      <span style={{ position: "absolute", inset: 2, borderRadius: "50%", background: isVeg ? "#16a34a" : "#dc2626" }} />
    </span>
  );
}

function RatingBadge({ rating, count, size = "sm" }) {
  if (!rating && !count) return null;
  const isSmall = size === "sm";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, background: "#dcfce7", color: "#166534", padding: isSmall ? "2px 7px" : "3px 10px", borderRadius: 100, fontSize: isSmall ? 10.5 : 12, fontWeight: 700 }}>
      <span style={{ color: "#16a34a" }}>★</span>
      {rating ? rating.toFixed(1) : "New"}
      {count ? <span style={{ color: "#86efac", fontWeight: 500 }}>({count >= 1000 ? (count / 1000).toFixed(1) + "k" : count})</span> : null}
    </span>
  );
}

function MenuCard({ item, qty, onAdd, onOpenDetail, width }) {
  const [pulses, setPulses] = useState([]);
  const hasVariations = item.variations?.length > 0;
  function handleAdd(e) {
    e.stopPropagation();
    if (hasVariations) { onOpenDetail(item); return; }
    const id = `${Date.now()}-${Math.random()}`;
    setPulses((p) => [...p, id]);
    setTimeout(() => setPulses((p) => p.filter((x) => x !== id)), 700);
    playTone(680, 90, "triangle");
    onAdd();
  }
  return (
    <div onClick={() => onOpenDetail(item)} style={{ background: "#fff", borderRadius: 16, overflow: "hidden", boxShadow: "0 2px 12px rgba(0,0,0,0.06)", border: "1px solid #f0f0f0", flexShrink: width ? 0 : undefined, width: width || "auto", cursor: "pointer", position: "relative" }}>
      <div style={{ position: "relative", height: 140, background: "#f8f6f3" }}>
        {item.imageUrl ? (
          <img src={item.imageUrl} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="eager" />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 40 }}>🍽️</div>
        )}
        {(item.isCombo || item.bogoEnabled) && (
          <div style={{ position: "absolute", top: 8, left: 8, display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start", zIndex: 2 }}>
            {item.isCombo && (
              <span style={{ background: "#1a1a2e", color: "#fff", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 100 }}>COMBO</span>
            )}
            {item.bogoEnabled && (
              <span style={{ background: "#16a34a", color: "#fff", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 100 }}>🎁 Buy 1 Get 1 Free</span>
            )}
          </div>
        )}
        {item.mostLoved && (
          <span style={{ position: "absolute", top: 8, right: 8, background: "#dc2626", color: "#fff", fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 100 }}>🔥 Most Loved</span>
        )}
        {item.mostOrdered && !item.mostLoved && (
          <span style={{ position: "absolute", top: 8, right: 8, background: "#e8a33d", color: "#1a1a2e", fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 100 }}>🔥 Most Ordered</span>
        )}
        {item.mostRated && !item.mostLoved && !item.mostOrdered && (
          <span style={{ position: "absolute", top: 8, right: 8, background: "#16a34a", color: "#fff", fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 100 }}>⭐ Most Rated</span>
        )}
        {pulses.map((id) => (<span key={id} className="menu-card-plus-float">+1</span>))}
        <button onClick={handleAdd} className="tap-btn" style={{ position: "absolute", bottom: -16, right: 12, width: 36, height: 36, borderRadius: "50%", border: "none", background: "#e8a33d", color: "#fff", fontSize: 20, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 8px rgba(232,163,61,0.4)" }}>+</button>
      </div>
      <div style={{ padding: "20px 12px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <VegBadge foodType={item.foodType} />
          <div style={{ fontWeight: 700, fontSize: 14, color: "#1a1a2e", lineHeight: 1.3, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</div>
        </div>
        <div style={{ fontSize: 11.5, color: "#999", marginBottom: 8, lineHeight: 1.3, minHeight: 15 }}>
          {item.description?.slice(0, 26)}{item.description?.length > 26 ? "…" : ""}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontWeight: 800, fontSize: 16, color: "#e8a33d" }}>{hasVariations ? `From ₹${Math.min(...item.variations.map((v) => v.price))}` : `₹${item.price}`}</span>
            {(item.averageRating || item.reviewCount) && (
              <RatingBadge rating={item.averageRating} count={item.reviewCount} />
            )}
          </div>
          {qty > 0 && (<span style={{ background: "#1a1a2e", color: "#fff", padding: "2px 10px", borderRadius: 100, fontSize: 12, fontWeight: 700 }}>{qty}</span>)}
        </div>
      </div>
    </div>
  );
}

// Item detail / customization modal.
// NEW: startMode / initialNotes / initialSpiceLevel let this modal be reopened
// from a CART LINE for editing — the parent decides (via `onAdd`) whether this
// call means "add a new line" or "update the line I was already editing".
function ItemDetailModal({ item, onClose, onAdd, startMode = "view", initialNotes = "", initialSpiceLevel = null, initialVariationId = null, initialAddonIds = [] }) {
  const [mode, setMode] = useState(startMode);
  const [notes, setNotes] = useState(initialNotes);
  const [spiceLevel, setSpiceLevel] = useState(initialSpiceLevel);
  const hasVariations = Array.isArray(item.variations) && item.variations.length > 0;
  const hasAddons = Array.isArray(item.addons) && item.addons.length > 0;
  const [variationId, setVariationId] = useState(initialVariationId || (hasVariations ? item.variations[0].id : null));
  const [addonIds, setAddonIds] = useState(initialAddonIds || []);

  const selectedVariation = hasVariations ? item.variations.find((v) => v.id === variationId) : null;
  const basePrice = selectedVariation ? selectedVariation.price : item.price;
  const addonsTotal = (item.addons || []).filter((a) => addonIds.includes(a.id)).reduce((s, a) => s + a.price, 0);
  const unitPrice = basePrice + addonsTotal;

  function toggleAddon(id) {
    setAddonIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  // Only builds a "customized" line (spice/notes/size/add-ons) when something
  // actually differs from the plain item — otherwise repeated taps on a plain
  // item wouldn't merge into a single cart line the way they used to.
  function buildCustomization(extra) {
    const addonNames = (item.addons || []).filter((a) => addonIds.includes(a.id)).map((a) => a.name);
    return {
      notes: extra?.notes || "",
      spiceLevel: extra?.spiceLevel || null,
      variationId: variationId || null,
      variationName: selectedVariation?.name || null,
      addonIds,
      addonNames,
      unitPrice,
    };
  }
  function isCustomized(extra) {
    return hasVariations || hasAddons || !!extra?.notes || !!extra?.spiceLevel;
  }

  const sizeAddonBlock = (
    <>
      {hasVariations && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#6b6b7b", textTransform: "uppercase", marginBottom: 8 }}>Choose Size</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {item.variations.map((v) => (
              <button key={v.id} onClick={() => setVariationId(v.id)} style={{ padding: "8px 14px", borderRadius: 100, fontSize: 13, fontWeight: 700, cursor: "pointer", border: variationId === v.id ? "2px solid #e8a33d" : "1px solid #ddd", background: variationId === v.id ? "#fff5e0" : "#fff" }}>
                {v.name} · ₹{v.price}
              </button>
            ))}
          </div>
        </div>
      )}
      {hasAddons && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#6b6b7b", textTransform: "uppercase", marginBottom: 8 }}>Add Extras</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {item.addons.map((a) => (
              <label key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", borderRadius: 10, border: addonIds.includes(a.id) ? "2px solid #e8a33d" : "1px solid #eee", background: addonIds.includes(a.id) ? "#fff5e0" : "#fff", cursor: "pointer" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 600 }}>
                  <input type="checkbox" checked={addonIds.includes(a.id)} onChange={() => toggleAddon(a.id)} />
                  {a.name}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#e8a33d" }}>+₹{a.price}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {(hasVariations || hasAddons) && (
        <div style={{ marginTop: 14, fontSize: 15, fontWeight: 800, color: "#1a1a2e" }}>Total: ₹{unitPrice}</div>
      )}
    </>
  );

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 250, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: "24px 24px 0 0", width: "100%", maxWidth: 480, maxHeight: "85vh", overflowY: "auto", padding: 24, animation: "modalScaleIn 0.3s cubic-bezier(0.22,1,0.36,1)" }}>
        {item.imageUrl && <img src={item.imageUrl} alt={item.name} style={{ width: "100%", height: 180, objectFit: "cover", borderRadius: 16, marginBottom: 16 }} />}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <VegBadge foodType={item.foodType} />
              <div style={{ fontSize: 20, fontWeight: 800 }}>{item.name}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#e8a33d" }}>{hasVariations ? `From ₹${Math.min(...item.variations.map((v) => v.price))}` : `₹${item.price}`}</div>
              {(item.averageRating || item.reviewCount) && (
                <RatingBadge rating={item.averageRating} count={item.reviewCount} size="md" />
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: "#888" }}>×</button>
        </div>

        {mode === "view" && (
          <>
            <p style={{ fontSize: 14, color: "#555", lineHeight: 1.5, marginTop: 12, marginBottom: 6 }}>{item.description || "No description available."}</p>
            {item.bogoEnabled && (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#dcfce7", color: "#166534", fontSize: 12, fontWeight: 800, padding: "6px 12px", borderRadius: 100, marginTop: 4 }}>
                🎁 Buy 1 Get 1 Free
              </div>
            )}
            {sizeAddonBlock}
            <button onClick={() => setMode("customize")} className="tap-btn" style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#fff5e0", border: "1px solid #fde68a", color: "#92400e", fontSize: 12.5, fontWeight: 700, padding: "8px 14px", borderRadius: 100, cursor: "pointer", margin: "16px 0 20px" }}>
              🌶 Spice level / special request
            </button>
            <button onClick={() => { const custom = isCustomized() ? buildCustomization() : null; onAdd(item.id, 1, custom); onClose(); }} style={{ width: "100%", padding: 14, borderRadius: 14, border: "none", background: "#1a1a2e", color: "#fff", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>
              + Add to Cart · ₹{unitPrice}
            </button>
          </>
        )}

        {mode === "customize" && (
          <div style={{ marginTop: 16, animation: "fadeIn 0.25s ease" }}>
            {sizeAddonBlock}
            <div style={{ fontSize: 12, fontWeight: 700, color: "#6b6b7b", textTransform: "uppercase", marginBottom: 8, marginTop: (hasVariations || hasAddons) ? 20 : 0 }}>Spice Level</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
              {SPICE_LEVELS.map((lvl) => (
                <button key={lvl} onClick={() => setSpiceLevel(lvl === spiceLevel ? null : lvl)} style={{ padding: "8px 14px", borderRadius: 100, fontSize: 13, fontWeight: 600, cursor: "pointer", border: spiceLevel === lvl ? "2px solid #e8a33d" : "1px solid #ddd", background: spiceLevel === lvl ? "#fff5e0" : "#fff" }}>
                  {lvl}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#6b6b7b", textTransform: "uppercase", marginBottom: 8 }}>Special Request</div>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. No onions, extra spicy..." rows={3}
              style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid #ddd", fontSize: 14, fontFamily: "inherit", marginBottom: 20, boxSizing: "border-box", resize: "none" }} />
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setMode("view")} style={{ flex: 1, padding: 14, borderRadius: 14, border: "1px solid #ddd", background: "#fff", fontWeight: 600, cursor: "pointer" }}>Back</button>
              <button onClick={() => { onAdd(item.id, 1, buildCustomization({ notes, spiceLevel })); onClose(); }} style={{ flex: 2, padding: 14, borderRadius: 14, border: "none", background: "#e8a33d", color: "#1a1a2e", fontWeight: 700, cursor: "pointer" }}>
                {startMode === "customize" ? "Save Changes" : `Add to Cart · ₹${unitPrice}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Call Waiter — bottom sheet with preset reasons. Writes a lightweight doc
// reception can see live; doesn't touch the order/kitchen pipeline at all.
function WaiterModal({ onClose, onSend }) {
  const [selected, setSelected] = useState(null);
  const [customText, setCustomText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);

  const canSend = selected && (selected !== "other" || customText.trim().length > 0);

  async function handleSend() {
    if (!canSend || sending) return;
    setSending(true);
    setError(null);
    const reason = selected === "other"
      ? customText.trim()
      : WAITER_REASONS.find((r) => r.key === selected)?.label || "Assistance";
    try {
      await onSend(reason);
      setSent(true);
      setTimeout(onClose, 1700);
    } catch (err) {
      setError("Couldn't reach the kitchen — check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 260, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
        <div style={{ background: "#fff", borderRadius: "24px 24px 0 0", width: "100%", maxWidth: 480, padding: "36px 24px", textAlign: "center", animation: "modalScaleIn 0.3s cubic-bezier(0.22,1,0.36,1)" }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>🛎️</div>
          <div style={{ fontSize: 17, fontWeight: 800, color: "#1a1a2e" }}>A staff member is on the way!</div>
          <div style={{ fontSize: 13, color: "#888", marginTop: 4 }}>Thanks for letting us know.</div>
        </div>
      </div>
    );
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 260, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: "24px 24px 0 0", width: "100%", maxWidth: 480, padding: 24, animation: "modalScaleIn 0.3s cubic-bezier(0.22,1,0.36,1)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <h3 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Call a waiter</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: "#888" }}>×</button>
        </div>
        <p style={{ fontSize: 13, color: "#888", marginTop: 2, marginBottom: 18 }}>What do you need at your table?</p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, marginBottom: 16 }}>
          {WAITER_REASONS.map((r) => (
            <button key={r.key} onClick={() => setSelected(r.key)} className="tap-btn"
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 12px", borderRadius: 14, cursor: "pointer", textAlign: "left",
                border: selected === r.key ? "2px solid #e8a33d" : "1px solid #eee",
                background: selected === r.key ? "#fff5e0" : "#fff" }}>
              <span style={{ fontSize: 18 }}>{r.icon}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e" }}>{r.label}</span>
            </button>
          ))}
        </div>

        {selected === "other" && (
          <input value={customText} onChange={(e) => setCustomText(e.target.value)} placeholder="Tell us what you need..."
            style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: "1px solid #ddd", fontSize: 14, marginBottom: 16, boxSizing: "border-box" }} autoFocus />
        )}

        <button onClick={handleSend} disabled={!canSend || sending} className="tap-btn"
          style={{ width: "100%", padding: 15, borderRadius: 14, border: "none", background: canSend ? "#1a1a2e" : "#eee", color: canSend ? "#fff" : "#aaa", fontWeight: 700, fontSize: 15, cursor: canSend ? "pointer" : "not-allowed" }}>
          {sending ? "Sending..." : "🛎️ Call Waiter"}
        </button>
        {error && <div style={{ color: "#dc2626", fontSize: 12.5, fontWeight: 600, marginTop: 10, textAlign: "center" }}>{error}</div>}
      </div>
    </div>
  );
}

function RatingPopup({ order, restaurantId, onDone, googleReviewLink }) {
  const [rating, setRating] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(10);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) { clearInterval(interval); if (!submitted) onDone(); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [submitted, onDone]);

  async function submitRating(stars) {
    setRating(stars);
    try {
      await updateDoc(doc(db, "restaurants", restaurantId, "orders", order.id), { rating: { stars, ratedAt: Date.now() } });
    } catch {}
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadeIn 0.25s ease" }}>
        <div style={{ background: "#fff", borderRadius: 24, padding: 32, textAlign: "center", maxWidth: 320, animation: "modalScaleIn 0.35s cubic-bezier(0.22,1,0.36,1)" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🙏</div>
          <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 6 }}>Thank you so much!</div>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 20, lineHeight: 1.5 }}>
            We hope you had a wonderful time with us.<br />Have a great day! 🌟
          </div>
          {googleReviewLink && (
            <>
              <div style={{ fontSize: 12, color: "#aaa", marginBottom: 12 }}>Loved our service?</div>
              <a href={googleReviewLink} target="_blank" rel="noopener noreferrer"
                style={{ display: "inline-block", padding: "12px 24px", borderRadius: 14, background: "#1a1a2e", color: "#fff", fontWeight: 700, fontSize: 14, textDecoration: "none", marginBottom: 12 }}>
                ⭐ Rate us on Google
              </a>
            </>
          )}
          <button onClick={onDone} style={{ background: "none", border: "none", color: "#aaa", fontSize: 13, cursor: "pointer", display: "block", margin: "0 auto" }}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadeIn 0.25s ease" }}>
      <div style={{ background: "#fff", borderRadius: 24, padding: 32, textAlign: "center", maxWidth: 300, animation: "modalScaleIn 0.35s cubic-bezier(0.22,1,0.36,1)" }}>
        <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 4 }}>How was your meal?</div>
        <div style={{ fontSize: 12, color: "#aaa", marginBottom: 20 }}>Closing in {secondsLeft}s</div>
        <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 24 }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} onClick={() => submitRating(n)} style={{ background: "none", border: "none", fontSize: 34, cursor: "pointer", color: n <= rating ? "#e8a33d" : "#ddd", animation: n <= rating ? "starPulse 0.3s ease" : "none" }}>★</button>
          ))}
        </div>
        <button onClick={onDone} style={{ background: "none", border: "none", color: "#aaa", fontSize: 13, cursor: "pointer" }}>Skip</button>
      </div>
    </div>
  );
}

function SuccessOverlay({ message }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(26,26,46,0.55)", display: "flex", alignItems: "center", justifyContent: "center", animation: "fadeIn 0.25s ease" }}>
      <div style={{ background: "#fff", borderRadius: 24, padding: "36px 32px", textAlign: "center", boxShadow: "0 12px 40px rgba(0,0,0,0.25)", animation: "popIn 0.4s cubic-bezier(0.22,1,0.36,1)", maxWidth: 280 }}>
        <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#e8a33d", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", animation: "checkPop 0.5s ease 0.1s both" }}>
          <span style={{ fontSize: 32, color: "#fff" }}>✓</span>
        </div>
        <div style={{ fontSize: 17, fontWeight: 800, color: "#1a1a2e" }}>{message}</div>
      </div>
    </div>
  );
}

function StatusToast({ emoji, msg }) {
  return (
    <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 200, background: "#1a1a2e", color: "#fff", padding: "12px 20px", borderRadius: 100, display: "flex", alignItems: "center", gap: 10, fontSize: 14, fontWeight: 700, boxShadow: "0 8px 24px rgba(0,0,0,0.25)", animation: "toastSlideDown 0.35s cubic-bezier(0.22,1,0.36,1)", maxWidth: "90vw", whiteSpace: "nowrap" }}>
      <span style={{ fontSize: 18 }}>{emoji}</span><span>{msg}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recommendation banners
// ---------------------------------------------------------------------------

// "People also ordered" — exactly 2 items, each a full mini product card
// (photo, name, price, + button) so it's an attractive tap target, not a
// skinny scroll strip.
// "People also ordered" — driven by lib/recommendations.js rather than the
// two heuristics this replaced (a same-category-or-featured filter, and a
// hand-typed table covering six category names that did nothing for any
// category spelled differently — which was most of them). One real engine,
// blending this outlet's own order history with a category-complement prior
// so a brand-new outlet still gets sensible suggestions from day one.
function PeopleAlsoOrderedBanner({ cart, menuItems, onAdd, compact, recModel, restaurantId }) {
  const cartItemIds = useMemo(() => Object.values(cart).map((l) => l.itemId), [cart]);
  const suggestions = useMemo(
    () => recommendationsFor({ cartItemIds, model: recModel, menuItems, limit: 2 }),
    [cartItemIds, recModel, menuItems],
  );

  // Logged once per distinct suggestion SET, not on every render — the cart
  // re-renders on nearly every interaction, and logging that would flood the
  // event log with noise instead of the signal it exists to capture. This is
  // instrumentation only: nothing here changes what the customer sees. It
  // exists so a later pass can measure whether a recommendation shown here
  // actually led to an add, rather than assuming the model is working.
  const shownKey = suggestions.map((s) => s.id).join(",");
  const loggedKeyRef = useRef("");
  useEffect(() => {
    if (!shownKey || !restaurantId || loggedKeyRef.current === shownKey) return;
    loggedKeyRef.current = shownKey;
    addDoc(collection(db, "restaurants", restaurantId, "recEvents"), {
      type: "impression",
      itemIds: suggestions.map((s) => s.id),
      createdAt: Date.now(),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey, restaurantId]);

  if (suggestions.length === 0) return null;

  function handleAdd(item) {
    playTone(680, 90, "triangle");
    onAdd(item.id, 1);
    if (restaurantId) {
      addDoc(collection(db, "restaurants", restaurantId, "recEvents"), {
        type: "add", itemId: item.id, createdAt: Date.now(),
      }).catch(() => {});
    }
  }

  return (
    <div className="rec-banner" style={{ margin: compact ? "0 0 16px" : "0 20px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <span style={{ fontSize: 15 }}>👥</span>
        <span style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e" }}>People also ordered</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {suggestions.map((item) => (
          <div key={item.id} style={{ background: "#fff", borderRadius: 14, overflow: "hidden", border: "1px solid #f0ebe3", boxShadow: "0 2px 10px rgba(0,0,0,0.05)" }}>
            <div style={{ position: "relative", height: 78, background: "#f8f6f3" }}>
              {item.imageUrl ? (
                <img src={item.imageUrl} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26 }}>🍽️</div>
              )}
              <button
                onClick={() => handleAdd(item)}
                className="tap-btn"
                style={{ position: "absolute", bottom: -14, right: 8, width: 30, height: 30, borderRadius: "50%", border: "none", background: "#e8a33d", color: "#1a1a2e", fontSize: 17, fontWeight: 800, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 8px rgba(232,163,61,0.4)" }}
              >
                +
              </button>
            </div>
            <div style={{ padding: "18px 10px 10px" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#1a1a2e", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</div>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: "#e8a33d", marginTop: 2 }}>₹{item.price}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ThresholdBanner({ cartTotal, activeOffer, compact }) {
  if (!activeOffer || !activeOffer.active) return null;
  const remaining = (activeOffer.threshold || 0) - cartTotal;
  if (remaining <= 0) {
    return (
      <div className="rec-banner" style={{ margin: compact ? "0 0 12px" : "0 20px 20px", background: "linear-gradient(135deg, #ede9fe 0%, #f5f3ff 100%)", borderRadius: compact ? 12 : 16, padding: compact ? 12 : 16, border: "1px solid #ddd6fe" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: compact ? 16 : 20 }}>🎉</span>
          <div>
            <div style={{ fontSize: compact ? 12 : 13, fontWeight: 800, color: "#6d28d9" }}>You unlocked a FREE {activeOffer.freeItemName || "treat"}!</div>
            <div style={{ fontSize: 11, color: "#888" }}>It'll be applied as a discount on your bill</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rec-banner" style={{ margin: compact ? "0 0 12px" : "0 20px 20px", background: "linear-gradient(135deg, #fef3c7 0%, #fff5e0 100%)", borderRadius: compact ? 12 : 16, padding: compact ? 12 : 16, border: "1px solid #fde68a" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: compact ? 16 : 20 }}>🎁</span>
        <div>
          <div style={{ fontSize: compact ? 12 : 13, fontWeight: 800, color: "#92400e" }}>Add ₹{remaining} more & get FREE {activeOffer.freeItemName || "dessert"}!</div>
          {!compact && <div style={{ fontSize: 11, color: "#a08a5c" }}>Do not miss out — you are so close!</div>}
        </div>
      </div>
      <div style={{ marginTop: compact ? 8 : 10, height: 4, background: "#fde68a", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.min(100, (cartTotal / activeOffer.threshold) * 100)}%`, background: "#e8a33d", borderRadius: 2, transition: "width 0.5s ease" }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TableContent
// ---------------------------------------------------------------------------
export function TableContent({ mode = "table" }) {
  const searchParams = useSearchParams();
  const tableParam = searchParams.get("table");
  const restaurantId = searchParams.get("restaurant");
  // Precomputed by scripts/build-rec-models.mjs, not by this page — null until
  // that job has run once for this outlet, which lib/recommendations.js treats
  // as "no data yet" rather than an error.
  const recModel = useRecModel(restaurantId);
  // The token from the QR code. Proves this device is actually at the table —
  // see lib/table-session.js. Absent for delivery, which has its own gate.
  const tableToken = searchParams.get("t") || "";

  // Delivery reuses this entire screen: the same menu, cart, offers and BOGO
  // preview. Only the last step differs, where a table number would have been.
  const isDeliveryMode = mode === "delivery";

  const [tableNo, setTableNo] = useState(tableParam ? parseInt(tableParam) : null);
  const [deliveryForm, setDeliveryForm] = useState({ name: "", phone: "", address: "", landmark: "" });
  const [deliveryErrors, setDeliveryErrors] = useState({});
  // Proven, not merely typed. Reset by the component itself whenever the
  // number is edited, so it cannot go stale.
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [payMethod, setPayMethod] = useState("cod");
  const [placedOrderId, setPlacedOrderId] = useState(null);
  const [trackedOrder, setTrackedOrder] = useState(null);
  // Who is carrying this order, if it has been dispatched. A separate
  // document, not a field on the order itself: orders are broadly listable,
  // and a rider's phone number has no reason to be enumerable alongside them.
  // Fetching one assignment by its own order id stays open by rule — the
  // same trust level the order id itself already carries.
  const [rider, setRider] = useState(null);
  const [website, setWebsite] = useState(DEFAULT_WEBSITE);
  const [tableSession, setTableSession] = useState(undefined); // undefined = still loading
  const [orderError, setOrderError] = useState("");
  // Shown on the Status screen specifically — orderError above only ever
  // renders on the menu/cart screen, a different branch of this component,
  // so a Request Bill failure needs its own place to actually be seen.
  const [billRequestError, setBillRequestError] = useState("");
  const [billRequestSent, setBillRequestSent] = useState(false);
  // Asked once, right before the request that actually goes to reception —
  // not name/phone specifically flagged as skippable, they are simply not
  // required to submit.
  const [billDetailsModalOpen, setBillDetailsModalOpen] = useState(false);
  const [billDetailsForm, setBillDetailsForm] = useState({ name: "", phone: "", paymentMethod: "cash" });
  const [allOrdersRaw, setAllOrdersRaw] = useState([]);
  const [activeOrders, setActiveOrders] = useState([]);
  const [cart, setCart] = useState({});
  const [orderType, setOrderType] = useState("dinein"); // "dinein" | "takeaway" — matches reception POS convention
  const [addingMore, setAddingMore] = useState(false);
  const [tick, setTick] = useState(0);
  const [profile, setProfile] = useState(null);
  const [menuItems, setMenuItems] = useState([]);
  const [tables, setTables] = useState([]);
  const [activeCategory, setActiveCategory] = useState("All");
  const [showCartSummary, setShowCartSummary] = useState(false);
  const [offerIndex, setOfferIndex] = useState(0);
  const [offerBanners, setOfferBanners] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryDocs, setCategoryDocs] = useState([]);
  const [screen, setScreen] = useState("menu");
  const [successOverlay, setSuccessOverlay] = useState(null);
  const [statusToast, setStatusToast] = useState(null);
  const [cartBump, setCartBump] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [splashLeaving, setSplashLeaving] = useState(false);
  const [detailItem, setDetailItem] = useState(null);
  // NEW: when set, the ItemDetailModal is editing THIS cart line instead of
  // adding a brand-new one. Set by openLineCustomize(), cleared on close.
  const [editingLineId, setEditingLineId] = useState(null);
  const [ratingOrder, setRatingOrder] = useState(null);
  const [vegOnly, setVegOnly] = useState(false);
  const [googleReviewLink, setGoogleReviewLink] = useState("");
  const [bundleRules, setBundleRules] = useState([]); // Smart Deals — same collection reception manages
  const [exploreFilter, setExploreFilter] = useState("all");
  const [showExploreFilter, setShowExploreFilter] = useState(false);
  const [showWaiterModal, setShowWaiterModal] = useState(false);

  const offerScrollRef = useRef(null);
  const spotlightScrollRef = useRef(null);
  const prevCartCountRef = useRef(0);
  const prevActiveOrdersRef = useRef([]);
  const prevStatusMapRef = useRef({});

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!restaurantId) return;
    const unsub = onSnapshot(doc(db, "restaurants", restaurantId, "info", "profile"), (snap) => {
      if (snap.exists()) setProfile(snap.data());
    });
    return () => unsub();
  }, [restaurantId]);

  useEffect(() => {
    if (!restaurantId) return;
    const unsub = onSnapshot(doc(db, "restaurants", restaurantId, "info", "settings"), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setGoogleReviewLink(data.googleReviewLink || "");
        setWebsite({
          ...DEFAULT_WEBSITE,
          ...(data.website || {}),
          deliveryEnabled: !!data.deliveryEnabled,
          // Lives at the root of info/settings because that is where the
          // security rule reads it from.
          requirePhoneVerification: !!data.requirePhoneVerification,
        });
      }
    });
    return () => unsub();
  }, [restaurantId]);

  useEffect(() => {
    if (!restaurantId) return;
    const q = query(collection(db, "restaurants", restaurantId, "bundleRules"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, (snap) => setBundleRules(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    return () => unsub();
  }, [restaurantId]);

  useEffect(() => {
    if (!restaurantId) return;
    const q = query(collection(db, "restaurants", restaurantId, "menuItems"), orderBy("createdAt", "asc"));
    const unsub = onSnapshot(q, (snap) => {
      setMenuItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return () => unsub();
  }, [restaurantId]);

  // NEW: Offer Carousel — reception-curated exclusive deal banners (up to 8),
  // replaces the old auto-picked hero carousel. Hidden entirely if empty.
  useEffect(() => {
    if (!restaurantId) return;
    const q = query(collection(db, "restaurants", restaurantId, "offerBanners"), orderBy("order", "asc"));
    const unsub = onSnapshot(q, (snap) => setOfferBanners(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    return () => unsub();
  }, [restaurantId]);

  useEffect(() => {
    if (!restaurantId) return;
    const q = query(collection(db, "restaurants", restaurantId, "tables"), orderBy("number", "asc"));
    const unsub = onSnapshot(q, (snap) => setTables(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    return () => unsub();
  }, [restaurantId]);

  // A delivery customer has no table, so the table listener never sees their
  // order. The id is kept in this browser when the order is placed, which is
  // what lets someone close the tab, come back, and still see where their food
  // is. Only an id is stored — the address stays behind the staff-only rule.
  useEffect(() => {
    if (!restaurantId || !isDeliveryMode || placedOrderId) return;
    try {
      const saved = localStorage.getItem(`cabadra:lastOrder:${restaurantId}`);
      if (saved) { setPlacedOrderId(saved); setScreen("deliveryPlaced"); }
    } catch {}
  }, [restaurantId, isDeliveryMode, placedOrderId]);

  // Follow that one order. A single document listener, so a hundred people
  // ordering at once is a hundred cheap listeners rather than anyone reading
  // anyone else's orders.
  useEffect(() => {
    if (!restaurantId || !placedOrderId) return;
    const unsub = onSnapshot(
      doc(db, "restaurants", restaurantId, "orders", placedOrderId),
      (snap) => {
        if (!snap.exists()) {
          // Declined and removed by the restaurant.
          setTrackedOrder(null);
          try { localStorage.removeItem(`cabadra:lastOrder:${restaurantId}`); } catch {}
          return;
        }
        const data = { id: snap.id, ...snap.data() };
        setTrackedOrder(data);
        if (!data.dispatchedAt) setRider(null);
        // Once the food has arrived the journey is over — the stored id is
        // dropped so the NEXT visit starts at the menu. The screen itself stays
        // up for this visit, showing "Delivered", rather than vanishing from
        // under someone who is still looking at it.
        if (isDeliveryComplete(data)) {
          try { localStorage.removeItem(`cabadra:lastOrder:${restaurantId}`); } catch {}
        }
      },
      () => setTrackedOrder(null),
    );
    return () => unsub();
  }, [restaurantId, placedOrderId]);

  useEffect(() => {
    if (!restaurantId || !placedOrderId) { setRider(null); return; }
    const unsub = onSnapshot(
      doc(db, "restaurants", restaurantId, "riderAssignments", placedOrderId),
      (snap) => setRider(snap.exists() ? snap.data() : null),
      () => setRider(null),
    );
    return () => unsub();
  }, [restaurantId, placedOrderId]);

  // This table's ordering window. Readable on purpose: a guest whose order is
  // refused should be told the table is closed, not shown a bare failure.
  useEffect(() => {
    if (!restaurantId || !tableNo || isDeliveryMode) return;
    const unsub = onSnapshot(
      doc(db, "restaurants", restaurantId, "tableSessions", String(tableNo)),
      (snap) => setTableSession(snap.exists() ? snap.data() : null),
      () => setTableSession(null),
    );
    return () => unsub();
  }, [restaurantId, tableNo, isDeliveryMode]);

  useEffect(() => {
    if (!restaurantId) return;
    const q = query(collection(db, "restaurants", restaurantId, "categories"), orderBy("order", "asc"));
    const unsub = onSnapshot(q, (snap) => setCategoryDocs(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    return () => unsub();
  }, [restaurantId]);

  useEffect(() => {
    if (!tableNo || !restaurantId) return;
    // Bounded to the current sitting. This used to subscribe to every order the
    // table had ever had, which meant a diner's browser downloaded the table's
    // entire order history — and anyone could read another table's by editing
    // the URL. Pair this with the security rules in firestore.rules.
    const q = query(
      collection(db, "restaurants", restaurantId, "orders"),
      where("table", "==", tableNo),
      where("createdAt", ">=", tableSessionWindowStart()),
    );
    const unsub = onSnapshot(q, (snap) => {
      const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setAllOrdersRaw(all);
      const active = all
        .filter((o) => !["paid", "cancelled", "declined", "merged"].includes(o.status))
        .sort((a, b) => a.createdAt - b.createdAt);
      setActiveOrders(active);
    }, (err) => console.error("Order listener failed:", err.code, err.message));
    return () => unsub();
  }, [tableNo, restaurantId]);

  useEffect(() => {
    const prev = prevActiveOrdersRef.current;
    activeOrders.forEach((o) => {
      const prevOrder = prev.find((p) => p.id === o.id);
      if (prevOrder && prevOrder.status !== o.status) {
        const configs = {
          confirmed: { emoji: "✅", msg: "Order confirmed!", tone: 520 },
          preparing: { emoji: "👨‍🍳", msg: "Your food is being cooked!", tone: 600 },
          ready: { emoji: "🔔", msg: "Your order is ready!", tone: 720 },
          served: { emoji: "🎉", msg: "Enjoy your meal!", tone: 840 },
        };
        const cfg = configs[o.status];
        if (cfg) {
          playTone(cfg.tone, 180, "triangle");
          setStatusToast(cfg);
          setTimeout(() => setStatusToast(null), 2600);
        }
      }
    });
    prevActiveOrdersRef.current = activeOrders;
  }, [activeOrders]);

  useEffect(() => {
    allOrdersRaw.forEach((o) => {
      const prevStatus = prevStatusMapRef.current[o.id];
      if (prevStatus && prevStatus !== "paid" && o.status === "paid" && !o.rating) {
        setRatingOrder(o);
      }
    });
    const map = {};
    allOrdersRaw.forEach((o) => { map[o.id] = o.status; });
    prevStatusMapRef.current = map;
  }, [allOrdersRaw]);

  useEffect(() => {
    if (offerBanners.length <= 1) return;
    const t = setInterval(() => {
      setOfferIndex((prev) => {
        const next = (prev + 1) % offerBanners.length;
        const el = offerScrollRef.current;
        if (el) el.scrollTo({ left: next * el.clientWidth, behavior: "smooth" });
        return next;
      });
    }, 4000);
    return () => clearInterval(t);
  }, [offerBanners.length]);

  // NEW: auto-scroll the "Loved by Everyone" spotlight carousel one card at a
  // time, looping back to the start once it reaches the end.
  useEffect(() => {
    const t = setInterval(() => {
      const el = spotlightScrollRef.current;
      if (!el || el.scrollWidth <= el.clientWidth) return;
      const cardStep = 180;
      const maxScroll = el.scrollWidth - el.clientWidth;
      const next = el.scrollLeft + cardStep > maxScroll + 4 ? 0 : el.scrollLeft + cardStep;
      el.scrollTo({ left: next, behavior: "smooth" });
    }, 2800);
    return () => clearInterval(t);
  }, [menuItems.length]);

  useEffect(() => {
    const c = Object.values(cart).reduce((a, l) => a + l.qty, 0);
    if (c > prevCartCountRef.current) {
      setCartBump(true);
      const t = setTimeout(() => setCartBump(false), 400);
      prevCartCountRef.current = c;
      return () => clearTimeout(t);
    }
    prevCartCountRef.current = c;
  }, [cart]);

  useEffect(() => {
    const leaveTimer = setTimeout(() => setSplashLeaving(true), 2200);
    const hideTimer = setTimeout(() => setShowSplash(false), 2650);
    return () => { clearTimeout(leaveTimer); clearTimeout(hideTimer); };
  }, []);

  function dismissSplash() {
    setSplashLeaving(true);
    setTimeout(() => setShowSplash(false), 350);
  }

  function handleOfferScroll(e) {
    const el = e.currentTarget;
    if (!el.clientWidth) return;
    const idx = Math.round(el.scrollLeft / el.clientWidth);
    if (idx !== offerIndex) setOfferIndex(idx);
  }
  function scrollOfferTo(idx) {
    setOfferIndex(idx);
    const el = offerScrollRef.current;
    if (el) el.scrollTo({ left: idx * el.clientWidth, behavior: "smooth" });
  }
  function handleOfferBannerClick(banner) {
    if (!banner.linkedItemId) return;
    playTone(680, 90, "triangle");
    const item = findItem(banner.linkedItemId);
    const discountedPrice = computeOfferPrice(banner, item);
    if (discountedPrice != null) {
      addToCart(banner.linkedItemId, 1, null, discountedPrice, { id: banner.id, label: `${banner.discountPercent}% off — ${banner.title}` });
    } else {
      addToCart(banner.linkedItemId, 1);
    }
    triggerSuccessOverlay(item ? `${item.name} added!` : "Added to cart!");
  }

  const currentTableDoc = tables.find((t) => t.number === tableNo);
  const availableItemsRaw = menuItems.filter((m) => m.available);
  const availableItems = vegOnly ? availableItemsRaw.filter((m) => m.foodType === "veg") : availableItemsRaw;

  const categoryIconMap = {};
  categoryDocs.forEach((c) => { if (c.imageUrl) categoryIconMap[c.name] = c.imageUrl; });
  const itemCategoryNames = new Set(availableItems.map((m) => m.category));
  const orderedCategoryNames = categoryDocs.map((c) => c.name).filter((n) => itemCategoryNames.has(n));
  const looseCategoryNames = [...itemCategoryNames].filter((n) => !categoryDocs.some((c) => c.name === n));
  const categories = ["All", ...orderedCategoryNames, ...looseCategoryNames];

  const filteredItems = activeCategory === "All" ? availableItems : availableItems.filter((m) => m.category === activeCategory);

  const isSearching = searchQuery.trim().length > 0;
  const searchResults = isSearching
    ? availableItems.filter((m) => m.name.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : [];

  // NEW: up to 5 standout items (Most Loved / Most Ordered / Most Rated /
  // Featured), ranked by how many badges they carry then by rating — shown
  // as an auto-scrolling, colourfully-boxed carousel instead of one static card.
  const spotlightItems = useMemo(() => {
    const scored = availableItems
      .map((m) => ({ item: m, score: (m.mostLoved ? 3 : 0) + (m.mostOrdered ? 2 : 0) + (m.mostRated ? 1 : 0) + (m.featured ? 0.5 : 0) }))
      .filter((s) => s.score > 0 || s.item.averageRating);
    scored.sort((a, b) => b.score - a.score || (b.item.averageRating || 0) - (a.item.averageRating || 0));
    return scored.slice(0, 5).map((s) => s.item);
  }, [availableItems]);

  function findItem(id) { return menuItems.find((m) => m.id === id); }

  // Opens the detail modal for "view / add new" — always clears any pending
  // cart-line-edit state so a fresh menu-card tap never gets mistaken for an
  // in-progress cart customization.
  function openItemDetail(item) {
    setEditingLineId(null);
    setDetailItem(item);
  }

  // NEW: opens the same modal, but pre-loaded with a specific cart line's
  // current customization (spice/notes AND size/add-ons), and flagged so the
  // Save button updates that line instead of adding a duplicate.
  function openLineCustomize(lineId) {
    const line = cart[lineId];
    if (!line) return;
    const item = findItem(line.itemId);
    if (!item) return;
    setEditingLineId(lineId);
    setDetailItem(item);
  }

  function closeDetailModal() {
    setDetailItem(null);
    setEditingLineId(null);
  }

  // Routes the modal's "Add" action: if we opened it to edit an existing cart
  // line, update that line (including any size/add-on change) in place;
  // otherwise fall through to the normal add-to-cart behaviour.
  function handleDetailAdd(itemId, qty, customization) {
    if (editingLineId) {
      const lineId = editingLineId;
      setCart((prev) => {
        const line = prev[lineId];
        if (!line) return prev;
        return {
          ...prev,
          [lineId]: {
            ...line,
            notes: customization?.notes || "",
            spiceLevel: customization?.spiceLevel || null,
            variationId: customization?.variationId ?? line.variationId ?? null,
            variationName: customization?.variationName ?? line.variationName ?? null,
            addonIds: customization?.addonIds ?? line.addonIds ?? [],
            addonNames: customization?.addonNames ?? line.addonNames ?? [],
            priceOverride: customization?.unitPrice != null ? customization.unitPrice : line.priceOverride,
          },
        };
      });
      setEditingLineId(null);
    } else {
      addToCart(itemId, qty, customization);
    }
  }

  // NEW: cart lines now carry an optional priceOverride (offer discounts, or
  // variation + add-on pricing computed in the item modal) plus variation/
  // add-on descriptors for display. `customization` (from the item modal) and
  // `priceOverride`+`offerInfo` (from an offer-banner tap) are separate entry
  // points so simple repeat taps on a plain item still merge into one line.
  function addToCart(itemId, qty, customization = null, priceOverride = null, offerInfo = null) {
    setCart((prev) => {
      if (!customization && priceOverride == null) {
        const plainId = `${itemId}-plain`;
        const existing = prev[plainId];
        return { ...prev, [plainId]: { itemId, qty: (existing?.qty || 0) + qty, notes: "", spiceLevel: null, variationId: null, variationName: null, addonIds: [], addonNames: [], priceOverride: null, offerLabel: null } };
      }
      if (priceOverride != null && !customization) {
        // Offer-triggered add — its own line per offer so it never merges
        // with (and silently overwrites the price of) a regular-price line.
        const lineId = `${itemId}-offer-${offerInfo?.id || "x"}`;
        const existing = prev[lineId];
        return { ...prev, [lineId]: { itemId, qty: (existing?.qty || 0) + qty, notes: "", spiceLevel: null, variationId: null, variationName: null, addonIds: [], addonNames: [], priceOverride, offerLabel: offerInfo?.label || null } };
      }
      const lineId = `${itemId}-${Date.now()}`;
      return {
        ...prev,
        [lineId]: {
          itemId, qty,
          notes: customization.notes || "",
          spiceLevel: customization.spiceLevel || null,
          variationId: customization.variationId || null,
          variationName: customization.variationName || null,
          addonIds: customization.addonIds || [],
          addonNames: customization.addonNames || [],
          priceOverride: customization.unitPrice != null ? customization.unitPrice : null,
          offerLabel: null,
        },
      };
    });
  }

  function changeLineQty(lineId, delta) {
    setCart((prev) => {
      const line = prev[lineId];
      if (!line) return prev;
      const newQty = Math.max(0, line.qty + delta);
      const next = { ...prev };
      if (newQty === 0) delete next[lineId]; else next[lineId] = { ...line, qty: newQty };
      return next;
    });
  }

  function qtyForItem(itemId) {
    return Object.values(cart).reduce((s, l) => (l.itemId === itemId ? s + l.qty : s), 0);
  }

  function triggerSuccessOverlay(message) {
    playChime();
    setSuccessOverlay(message);
    setTimeout(() => setSuccessOverlay(null), 1600);
  }

  async function callWaiter(reason) {
    if (!restaurantId || !tableNo) return;
    await addDoc(collection(db, "restaurants", restaurantId, "waiterCalls"), {
      table: tableNo,
      reason,
      status: "pending",
      createdAt: Date.now(),
    });
    playTone(600, 100, "triangle");
  }

  async function submitCart() {
    const items = Object.values(cart).map((line) => {
      const item = findItem(line.itemId);
      const composedName = item.name + (line.variationName ? ` — ${line.variationName}` : "");
      const addonsNote = line.addonNames?.length ? `Add-ons: ${line.addonNames.join(", ")}` : "";
      const composedNotes = [addonsNote, line.notes].filter(Boolean).join(" · ");
      const unitPrice = line.priceOverride != null ? line.priceOverride : item.price;
      // itemId is what every downstream consumer joins on — analytics, the
      // most-ordered badges, and the recommendation model. `name` is a composed
      // display string (dish + variation), so it can never be a reliable key:
      // renaming a dish would orphan its history and each variation would look
      // like a separate dish.
      return {
        itemId: line.itemId,
        name: composedName,
        qty: line.qty,
        price: unitPrice,
        notes: composedNotes || "",
        spiceLevel: line.spiceLevel || null,
        variationId: line.variationId || null,
        addonIds: line.addonIds || [],
      };
    });
    if (items.length === 0) return;

    // Note: no free-item injection here. Threshold/bundle deals — including
    // Buy 1 Get 1 Free — are computed once, at bill time, by reception's Smart
    // Deals engine (bundleRules + item.bogoEnabled). That's the single source
    // of truth. The banners below are just an accurate preview of what the
    // diner will see deducted from the bill.
    if (isDeliveryMode) {
      const errors = validateDeliveryDetails(deliveryForm);
      if (Object.keys(errors).length > 0) { setDeliveryErrors(errors); return; }

      // Refusing here is a courtesy, not the control. The security rule is what
      // actually enforces this — it compares the number against the token
      // Firebase issued, which no client can fake.
      if (verificationRequired && !phoneVerified) {
        setDeliveryErrors({ phone: "Please verify your phone number first." });
        return;
      }

      // The order id is generated up front so the address can be written FIRST,
      // under that same id. Security rules refuse a delivery order whose details
      // do not already exist, which is what stops an order arriving with nowhere
      // to send it. The address never goes on the order document itself: orders
      // are publicly readable so a customer can track their own, and a guessable
      // id must not become a lookup for somebody's home address.
      const orderRef = doc(collection(db, "restaurants", restaurantId, "orders"));

      // Wrapped, like the dine-in path below it. Without this, a refused write
      // became an unhandled rejection and the customer got a raw framework
      // error page instead of a sentence telling them what went wrong —
      // mid-checkout, with a full cart, which is the worst possible moment to
      // show somebody a stack trace.
      try {
        await setDoc(doc(db, "restaurants", restaurantId, "deliveryDetails", orderRef.id), {
          name: deliveryForm.name.trim(),
          phone: normalizePhone(deliveryForm.phone),
          // The rule checks this against request.auth.token.phone_number, so it
          // has to be the E.164 form rather than whatever was typed.
          phoneE164: phoneVerified ? toE164(deliveryForm.phone) : "",
          address: deliveryForm.address.trim(),
          landmark: deliveryForm.landmark.trim(),
          paymentMethod: payMethod,
          createdAt: Date.now(),
        });
        await setDoc(orderRef, {
          table: DELIVERY_TABLE,
          items,
          status: "pending",
          orderType: ORDER_TYPES.DELIVERY,
          isVIP: false,
          etaMinutes: null,
          preparingAt: null,
          // The fee quoted on this screen, recorded at the moment it was quoted.
          // Without it the bill would be recomputed later against settings that
          // may have changed, and the customer would be charged something other
          // than the total they agreed to.
          deliveryFee,
          createdAt: Date.now(),
        });
      } catch (e) {
        setOrderError(deliveryOrderErrorMessage(e));
        return;
      }

      // Kept so this device can follow its own order after a refresh. It is an
      // id, not personal data — the address stays behind the staff-only rule.
      try { localStorage.setItem(`cabadra:lastOrder:${restaurantId}`, orderRef.id); } catch {}
      setPlacedOrderId(orderRef.id);
      setCart({});
      setShowCartSummary(false);
      setScreen("deliveryPlaced");
      return;
    }

    // A table that has been given a code but is not seated will be refused by
    // security rules. Saying so first is kinder than letting the write fail.
    if (tableToken && tableSession !== undefined && !isSessionOpen(tableSession)) {
      setOrderError(BLOCKED_MESSAGES[tableSession ? "session-expired" : "no-session"]);
      return;
    }

    try {
      await addDoc(collection(db, "restaurants", restaurantId, "orders"), {
      table: tableNo,
      items,
      status: "pending",
      orderType,
      isVIP: !!currentTableDoc?.isVIP,
      etaMinutes: null,
      preparingAt: null,
      createdAt: Date.now(),
      // Only sent when the QR carried one. Tables whose codes predate the token
      // scheme keep working; see firestore.rules.
      ...(tableToken ? { tableToken } : {}),
      });
    } catch (e) {
      // The rules are the real gate; this is only what the guest sees when the
      // answer is no.
      setOrderError(e?.code === "permission-denied"
        ? BLOCKED_MESSAGES[tableToken ? "session-expired" : "no-token"]
        : "Could not place your order. Please try again or ask a staff member.");
      return;
    }
    setOrderError("");

    setCart({});
    setOrderType("dinein");
    setShowCartSummary(false);
    setAddingMore(false);
    setScreen("menu");
    const placedMsg = orderType === "takeaway" ? "Order placed for pickup!" : "Order placed!";
    triggerSuccessOverlay(activeOrders.length > 0 ? "Added to your order!" : placedMsg);
  }

  // Requesting the bill has to work regardless of what is still cooking — a
  // table cannot be made to wait on dessert before it is even allowed to ask
  // to pay. But an order actually in the kitchen's queue (confirmed,
  // preparing, ready) cannot be silently flipped to "bill_requested" either:
  // the kitchen board queries for exactly those three statuses, so a status
  // change here would make food vanish from the kitchen's screen mid-cook.
  // The security rule already reflects that — a diner may only move their
  // own order to bill_requested from "pending" or "served", nothing else.
  //
  // So this always does the one thing that is unconditionally allowed —
  // raise a waiter call, the only diner-writable collection with no
  // preconditions on it at all — and additionally, best-effort, folds any
  // already-served orders into a real bill_requested order so reception's
  // Bill Requested tab is populated immediately whenever that is possible.
  // The waiter call is the guarantee; the order transition is the bonus.
  // `billDetails` — { name, phone, paymentMethod } — comes from the modal
  // shown when there is something to actually bill (see the button below).
  // Written to its own staff-only document, not onto the order: exactly the
  // same reasoning as deliveryDetails, and reception's Generate Bill modal
  // already knows to look there for it.
  async function requestBill(billDetails = null) {
    setBillRequestError("");
    setBillRequestSent(false);

    try {
      await addDoc(collection(db, "restaurants", restaurantId, "waiterCalls"), {
        table: tableNo, reason: BILL_REQUEST_LABEL, status: "pending", createdAt: Date.now(),
      });
      playTone(700, 90, "triangle");
      setBillRequestSent(true);
      // Reverts to a tappable button rather than staying confirmed forever —
      // "whenever they want" means being able to ping again if nobody has
      // come by yet, not a one-shot action.
      setTimeout(() => setBillRequestSent(false), 5000);
    } catch (e) {
      // This has no preconditions at all, so reaching this means something
      // more fundamental is wrong (offline, outage) — not a table/session
      // problem, which is why this message does not try to guess at one.
      setBillRequestError("Could not reach the restaurant. Check your connection and try again.");
      return;
    }

    const servedOrders = activeOrders.filter((o) => o.status === "served");
    if (servedOrders.length === 0) return;

    // From here on is the bonus path — a table whose session has since
    // expired, say, would fail this half silently. That is acceptable: the
    // guaranteed waiter call above has already reached reception regardless.
    if (tableToken && tableSession !== undefined && !isSessionOpen(tableSession)) return;

    try {
      // Generated up front, the same way a delivery order's id is, so the
      // payment-preference document can be written under it BEFORE the order
      // that references it exists — never the other way around.
      const orderRef = doc(collection(db, "restaurants", restaurantId, "orders"));

      if (billDetails) {
        await setDoc(doc(db, "restaurants", restaurantId, "billRequestDetails", orderRef.id), {
          name: billDetails.name.trim(),
          phone: normalizePhone(billDetails.phone),
          paymentMethod: billDetails.paymentMethod,
          createdAt: Date.now(),
        });
      }

      const mergedItems = mergeItemLines(servedOrders.flatMap((o) => o.items));
      await setDoc(orderRef, {
        table: tableNo, items: mergedItems, status: "bill_requested", etaMinutes: null, preparingAt: null, createdAt: Date.now(),
        ...(tableToken ? { tableToken } : {}),
      });

      const batch = writeBatch(db);
      servedOrders.forEach((o) => batch.update(doc(db, "restaurants", restaurantId, "orders", o.id), { status: "merged" }));
      await batch.commit();
    } catch {
      // Best-effort only — the diner already got their confirmation above.
    }
  }

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

  const count = Object.values(cart).reduce((a, l) => a + l.qty, 0);

  // The cart as priced order lines — the same shape reception bills from, so
  // the shared pricing engine can be handed this directly.
  const cartLines = Object.values(cart).flatMap((l) => {
    const item = findItem(l.itemId);
    if (!item) return [];
    return [{
      itemId: l.itemId,
      name: item.name + (l.variationName ? ` — ${l.variationName}` : ""),
      qty: l.qty,
      price: l.priceOverride != null ? l.priceOverride : item.price,
    }];
  });
  const total = cartLines.reduce((sum, l) => sum + l.price * l.qty, 0);
  // NEW: Buy 1 Get 1 Free — computed by the SAME function reception bills
  // with, so the saving previewed here and the saving deducted on the final
  // bill cannot drift apart. `total` above is the face-value sum of every line;
  // `displayTotal` is what the diner will actually pay.
  const bogoSavings = computeBogoDiscount(cartLines, menuItems)?.amount || 0;
  const displayTotal = Math.max(0, total - bogoSavings);

  // Verification only applies when the outlet asked for it AND the platform
  // switch is on, so an outlet cannot demand a code the app cannot send.
  const verificationRequired = isDeliveryMode && isOtpEnabled() && !!website.requirePhoneVerification;
  const deliveryFee = isDeliveryMode ? deliveryFeeFor(displayTotal, website) : 0;
  const freeDeliveryShortfall = isDeliveryMode ? shortfallToFreeDelivery(displayTotal, website) : 0;
  // Checked here so the customer is told why before they fill in an address,
  // and enforced again by security rules, which is what actually holds.
  const orderingBlocked = isDeliveryMode && count > 0
    ? orderingBlockedReason({ website, subtotal: displayTotal, mode: "delivery" })
    : null;

  // Which Smart Deal (if any) to surface in the ThresholdBanner — the next
  // active thresholdFreeItem rule the diner hasn't unlocked yet, or if every
  // active rule is already unlocked, the highest-value one (for the "you
  // unlocked X" message). Same bundleRules collection reception manages.
  const thresholdBannerOffer = useMemo(() => {
    const active = bundleRules.filter((r) => r.type === "thresholdFreeItem" && r.active);
    if (active.length === 0) return null;
    const notYetMet = active.filter((r) => total < (r.threshold || 0)).sort((a, b) => a.threshold - b.threshold);
    const chosen = notYetMet.length > 0 ? notYetMet[0] : [...active].sort((a, b) => b.threshold - a.threshold)[0];
    const freeItem = menuItems.find((m) => m.id === chosen.freeItemId);
    return { threshold: chosen.threshold, active: true, name: chosen.name, freeItemName: freeItem?.name || "item" };
  }, [bundleRules, total, menuItems]);

  const exploreItems = useMemo(() => {
    let items = [...availableItems];
    switch (exploreFilter) {
      case "veg": items = items.filter((m) => m.foodType === "veg"); break;
      case "nonveg": items = items.filter((m) => m.foodType === "nonveg"); break;
      case "price-low": items.sort((a, b) => a.price - b.price); break;
      case "price-high": items.sort((a, b) => b.price - a.price); break;
      case "most-loved": items = items.filter((m) => m.mostLoved).sort((a, b) => (b.averageRating || 0) - (a.averageRating || 0)); break;
      case "most-ordered": items = items.filter((m) => m.mostOrdered).sort((a, b) => (b.orderCount || 0) - (a.orderCount || 0)); break;
      case "most-rated": items = items.filter((m) => m.mostRated).sort((a, b) => (b.reviewCount || 0) - (a.reviewCount || 0)); break;
      default: break;
    }
    return items;
  }, [availableItems, exploreFilter]);

  const statusWords = {
    pending: "Sent to the counter", confirmed: "Confirmed — heading to kitchen", preparing: "Being cooked",
    ready: "Ready — on its way to your table", served: "Served. Enjoy!", bill_requested: "Bill Requested", billed: "Awaiting payment",
  };

  const bottomCartBar = (count > 0 || activeOrders.length > 0) ? (
    <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#fff", borderTop: "1px solid #eee", padding: "12px 20px", zIndex: 50 }}>
      <button
        onClick={() => {
          playTone(560, 70, "sine");
          if (count > 0) setShowCartSummary(true);
          else if (addingMore) { setAddingMore(false); setCart({}); setScreen("menu"); }
        }}
        className="tap-btn"
        style={{ width: "100%", maxWidth: 480, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: 14, borderRadius: 50, border: "none", background: "#1a1a2e", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,0.15)" }}
      >
        <span style={{ position: "relative" }} className={cartBump ? "cart-bump" : ""}>
          🛒
          {count > 0 && <span style={{ position: "absolute", top: -8, right: -8, background: "#e8a33d", color: "#1a1a2e", fontSize: 11, fontWeight: 800, padding: "1px 6px", borderRadius: 100 }}>{count}</span>}
        </span>
        {count > 0 ? `View Cart · ₹${displayTotal}` : "Back to Order Status"}
      </button>
    </div>
  ) : null;

  const cartSummaryModal = showCartSummary ? (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={() => setShowCartSummary(false)}>
      <div style={{ background: "#fff", borderRadius: "24px 24px 0 0", width: "100%", maxWidth: 480, maxHeight: "80vh", overflow: "auto", padding: 24, animation: "slideUp 0.3s ease" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ fontSize: 20, fontWeight: 800 }}>Your Cart</h3>
          <button onClick={() => setShowCartSummary(false)} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: "#888" }}>×</button>
        </div>

        {/* Dine-in or takeaway is a choice you make in the building. Someone
            ordering from a link has already chosen delivery by being here. */}
        {!isDeliveryMode && (
          <div style={{ display: "flex", gap: 8, background: "#f8f6f3", borderRadius: 12, padding: 4, marginBottom: 18 }}>
            {[["dinein", "🍽️ Dine-in"], ["takeaway", "📦 Takeaway"]].map(([val, label]) => (
              <button key={val} onClick={() => setOrderType(val)} className="tap-btn"
                style={{ flex: 1, padding: "10px", borderRadius: 9, border: "none", cursor: "pointer", fontWeight: 700, fontSize: 13,
                  background: orderType === val ? "#1a1a2e" : "transparent", color: orderType === val ? "#fff" : "#888" }}>
                {label}
              </button>
            ))}
          </div>
        )}

        {isDeliveryMode && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#e0f2fe", color: "#0369a1", borderRadius: 12, padding: "10px 14px", marginBottom: 18, fontSize: 13, fontWeight: 700 }}>
            <span>🛵</span>
            <span>Delivery{website.deliveryEtaMinutes ? ` · about ${website.deliveryEtaMinutes} min` : ""}</span>
          </div>
        )}

        {Object.entries(cart).map(([lineId, line]) => {
          const item = findItem(line.itemId);
          if (!item) return null;
          const unitPrice = line.priceOverride != null ? line.priceOverride : item.price;
          const hasUnpickedAddons = item.addons?.length > 0 && (!line.addonNames || line.addonNames.length === 0);
          return (
            <div key={lineId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid #f0f0f0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {item.imageUrl && (<img src={item.imageUrl} alt="" style={{ width: 48, height: 48, borderRadius: 10, objectFit: "cover" }} />)}
                <div>
                  <div style={{ fontWeight: 600 }}>{item.name}{line.variationName ? ` — ${line.variationName}` : ""}{item.bogoEnabled ? " 🎁" : ""}</div>
                  <div style={{ fontSize: 13, color: "#888" }}>
                    ₹{unitPrice} × {line.qty}
                    {line.priceOverride != null && line.priceOverride < item.price && <span style={{ color: "#aaa", textDecoration: "line-through", marginLeft: 6 }}>₹{item.price}</span>}
                  </div>
                  {line.offerLabel && <div style={{ fontSize: 11, color: "#16a34a", fontWeight: 700, marginTop: 2 }}>🎉 {line.offerLabel}</div>}
                  {line.spiceLevel && <div style={{ fontSize: 11, color: "#e8a33d", marginTop: 2 }}>🌶 {line.spiceLevel}</div>}
                  {line.addonNames?.length > 0 && <div style={{ fontSize: 11, color: "#166534", marginTop: 2 }}>+ {line.addonNames.join(", ")}</div>}
                  {line.notes && <div style={{ fontSize: 11, color: "#888", fontStyle: "italic", marginTop: 2 }}>"{line.notes}"</div>}
                  {hasUnpickedAddons ? (
                    <button
                      onClick={() => openLineCustomize(lineId)}
                      className="tap-btn"
                      style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#fff5e0", border: "1px solid #fde68a", color: "#92400e", fontSize: 10.5, fontWeight: 800, padding: "5px 10px", borderRadius: 100, cursor: "pointer", marginTop: 6 }}
                    >
                      🧀 Add extra toppings +
                    </button>
                  ) : (
                    <button
                      onClick={() => openLineCustomize(lineId)}
                      className="tap-btn"
                      style={{ background: "none", border: "none", color: "#e8a33d", fontSize: 11, fontWeight: 700, textDecoration: "underline", cursor: "pointer", padding: 0, marginTop: 4, display: "block" }}
                    >
                      ✎ Customise this item
                    </button>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button onClick={() => { playTone(420, 60); changeLineQty(lineId, -1); }} className="tap-btn" style={{ width: 28, height: 28, borderRadius: "50%", border: "1px solid #ddd", background: "none", cursor: "pointer" }}>−</button>
                <span style={{ fontWeight: 700, minWidth: 20, textAlign: "center" }}>{line.qty}</span>
                <button onClick={() => { playTone(680, 70, "triangle"); changeLineQty(lineId, 1); }} className="tap-btn" style={{ width: 28, height: 28, borderRadius: "50%", border: "none", background: "#1a1a2e", color: "#fff", cursor: "pointer" }}>+</button>
              </div>
            </div>
          );
        })}

        {count > 0 && (
          <div style={{ marginTop: 18 }}>
            <ThresholdBanner cartTotal={displayTotal} activeOffer={thresholdBannerOffer} compact />
            <PeopleAlsoOrderedBanner
              cart={cart} menuItems={menuItems} onAdd={addToCart} compact
              recModel={recModel} restaurantId={restaurantId}
            />
          </div>
        )}

        {bogoSavings > 0 && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 18, fontSize: 14, color: "#888" }}>
              <span>Subtotal</span><span>₹{total}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 13.5, fontWeight: 700, color: "#16a34a" }}>
              <span>🎁 Buy 1 Get 1 Free</span><span>-₹{bogoSavings}</span>
            </div>
          </>
        )}
        {isDeliveryMode && deliveryFee > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontSize: 14, color: "#888" }}>
            <span>Delivery</span><span>₹{deliveryFee}</span>
          </div>
        )}
        {isDeliveryMode && deliveryFee === 0 && website.deliveryFee > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontSize: 14, color: "#16a34a", fontWeight: 700 }}>
            <span>Delivery</span><span>FREE</span>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: bogoSavings > 0 ? 10 : 20, paddingTop: 16, borderTop: "2px solid #1a1a2e", fontSize: 18, fontWeight: 800 }}>
          <span>Total</span><span>₹{displayTotal + (isDeliveryMode ? deliveryFee : 0)}</span>
        </div>

        {/* Delivery asks for contact and address only HERE, at the end. Asking
            before someone has decided what they want is the fastest way to lose
            them. */}
        {isDeliveryMode && (
          <div style={{ marginTop: 22 }}>
            {freeDeliveryShortfall > 0 && (
              <div style={{ background: "#fef3c7", border: "1px solid #fde68a", color: "#92400e", padding: 12, borderRadius: 12, fontSize: 13, marginBottom: 16 }}>
                Add ₹{freeDeliveryShortfall} more for free delivery
              </div>
            )}

            <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a2e", marginBottom: 12 }}>Where should we deliver?</div>

            {[
              { key: "name", label: "Your name", placeholder: "Asha Kumar", type: "text" },
              ...(verificationRequired ? [] : [{ key: "phone", label: "Phone number", placeholder: "98765 43210", type: "tel" }]),
              { key: "address", label: "Delivery address", placeholder: "Flat 4B, 12 Hill Road, Bandra West", type: "text" },
              { key: "landmark", label: "Landmark (optional)", placeholder: "Opposite the bakery", type: "text" },
            ].map((f) => (
              <div key={f.key} style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: "#888", display: "block", marginBottom: 5 }}>{f.label}</label>
                <input
                  type={f.type}
                  value={deliveryForm[f.key]}
                  placeholder={f.placeholder}
                  onChange={(e) => {
                    setDeliveryForm((prev) => ({ ...prev, [f.key]: e.target.value }));
                    if (deliveryErrors[f.key]) setDeliveryErrors((prev) => ({ ...prev, [f.key]: undefined }));
                  }}
                  style={{
                    width: "100%", padding: "13px 14px", fontSize: 15, borderRadius: 12, boxSizing: "border-box",
                    border: `1.5px solid ${deliveryErrors[f.key] ? "#dc2626" : "#e6e1d6"}`,
                    background: "#fff", fontFamily: "inherit",
                  }}
                />
                {deliveryErrors[f.key] && (
                  <div style={{ color: "#dc2626", fontSize: 12, marginTop: 4 }}>{deliveryErrors[f.key]}</div>
                )}
              </div>
            ))}

            {/* The phone field is replaced rather than decorated when
                verification is on: it has to own its own disabled/verified
                states, and threading those through the generic loop above
                would make every other field pay for it. */}
            {verificationRequired && (
              <PhoneVerification
                phone={deliveryForm.phone}
                onPhoneChange={(v) => {
                  setDeliveryForm((prev) => ({ ...prev, phone: v }));
                  if (deliveryErrors.phone) setDeliveryErrors((prev) => ({ ...prev, phone: undefined }));
                }}
                onVerifiedChange={setPhoneVerified}
                fieldError={deliveryErrors.phone}
              />
            )}

            <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a2e", margin: "20px 0 10px" }}>How would you like to pay?</div>
            <div style={{ display: "grid", gap: 8 }}>
              {[
                { key: "cod", label: "Cash on delivery", hint: "Pay the rider when your food arrives", on: website.acceptsCod },
                { key: "upi", label: "UPI on delivery", hint: "Scan and pay at the door", on: website.acceptsUpi },
              ].filter((o) => o.on).map((o) => (
                <button key={o.key} onClick={() => setPayMethod(o.key)} className="tap-btn"
                  style={{
                    textAlign: "left", padding: 14, borderRadius: 12, cursor: "pointer", fontFamily: "inherit",
                    border: payMethod === o.key ? "2px solid #1a1a2e" : "1.5px solid #e6e1d6",
                    background: payMethod === o.key ? "#faf8f5" : "#fff",
                  }}>
                  <div style={{ fontSize: 14.5, fontWeight: 700, color: "#1a1a2e" }}>{o.label}</div>
                  <div style={{ fontSize: 12.5, color: "#888", marginTop: 2 }}>{o.hint}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {orderError && (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", padding: 14, borderRadius: 12, fontSize: 13.5, marginTop: 18 }}>
            {orderError}
          </div>
        )}

        {orderingBlocked && (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", padding: 14, borderRadius: 12, fontSize: 13.5, marginTop: 18 }}>
            {blockedMessage(orderingBlocked, { website, subtotal: displayTotal })}
          </div>
        )}

        <button onClick={submitCart} disabled={!!orderingBlocked} className="tap-btn"
          style={{
            width: "100%", marginTop: 20, padding: 16, borderRadius: 14, border: "none",
            background: orderingBlocked ? "#d6d0c4" : "#e8a33d",
            color: "#1a1a2e", fontSize: 16, fontWeight: 700,
            cursor: orderingBlocked ? "not-allowed" : "pointer",
          }}>
          {isDeliveryMode
            ? `Place delivery order · ₹${displayTotal + deliveryFee}`
            : activeOrders.length > 0 ? "Add to Order" : (orderType === "takeaway" ? "Place Takeaway Order" : "Place Order")}
        </button>

        {isDeliveryMode && (
          <p style={{ fontSize: 11, color: "#aaa", textAlign: "center", marginTop: 12, lineHeight: 1.5 }}>
            By placing this order you agree to our{" "}
            <a href="/terms" target="_blank" style={{ color: "#aaa", textDecoration: "underline" }}>Terms</a>
            {" "}and{" "}
            <a href="/privacy" target="_blank" style={{ color: "#aaa", textDecoration: "underline" }}>Privacy Policy</a>.
          </p>
        )}
      </div>
    </div>
  ) : null;

  // ---------- Delivery order placed ----------
  if (screen === "deliveryPlaced") {
    const placed = trackedOrder || allOrdersRaw.find((o) => o.id === placedOrderId);
    // Derived rather than stored, so a status changed by the kitchen or a rider
    // handed the order is reflected here without anything having to sync.
    const steps = deliveryTimeline(placed || { orderType: "delivery", status: "pending" });
    const stage = deliveryStage(placed || { orderType: "delivery" });
    const arrived = stage === DELIVERY_STAGES.DELIVERED;
    // Estimated from the current menu until the order is billed at dispatch,
    // then the real figures the customer was actually charged, straight off
    // the order document.
    const receipt = placed ? receiptFor(placed, { menuItems, bundleRules }) : null;
    return (
      <div style={{ minHeight: "100vh", background: "#faf8f5", padding: "40px 20px", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ maxWidth: 460, margin: "0 auto", textAlign: "center" }}>
          <div style={{ fontSize: 52, marginBottom: 14 }}>{arrived ? "🎉" : "🛵"}</div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1a1a2e", margin: "0 0 8px" }}>
            {arrived ? "Delivered — enjoy!" : stage === DELIVERY_STAGES.DISPATCHED ? "On its way" : "Order placed"}
          </h1>
          <p style={{ color: "#6b6b7b", fontSize: 14.5, lineHeight: 1.6, margin: "0 0 22px" }}>
            {arrived
              ? `Thanks for ordering from ${profile?.name || "us"}.`
              : stage === DELIVERY_STAGES.DISPATCHED
                ? "Your food has left the restaurant."
                : `${profile?.name || "The restaurant"} has your order and will confirm it shortly.${website.deliveryEtaMinutes ? ` Delivery usually takes about ${website.deliveryEtaMinutes} minutes.` : ""}`}
          </p>

          {/* Being able to call the person carrying your dinner is most of the
              value of a tracking screen. */}
          {rider?.name && !arrived && (
            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 16, padding: 16, marginBottom: 20, textAlign: "left", display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 42, height: 42, borderRadius: "50%", background: "#16a34a", color: "#fff", display: "grid", placeItems: "center", fontSize: 19, flexShrink: 0 }}>🛵</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11.5, fontWeight: 800, color: "#166534", textTransform: "uppercase", letterSpacing: 0.4 }}>Your rider</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a2e" }}>{rider.name}</div>
              </div>
              {rider.phone && (
                <a href={`tel:${rider.phone}`} className="tap-btn"
                  style={{ background: "#16a34a", color: "#fff", padding: "10px 16px", borderRadius: 12, fontSize: 13.5, fontWeight: 700, textDecoration: "none", flexShrink: 0 }}>
                  Call
                </a>
              )}
            </div>
          )}

          <div style={{ background: "#fff", border: "1px solid #e6e1d6", borderRadius: 16, padding: 20, textAlign: "left", marginBottom: 20 }}>
            {steps.map((st, i) => (
              <div key={st.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", opacity: st.done ? 1 : 0.4 }}>
                <div style={{
                  width: 24, height: 24, borderRadius: "50%", flexShrink: 0, display: "grid", placeItems: "center",
                  background: st.done ? "#16a34a" : "#e6e1d6", color: "#fff", fontSize: 13, fontWeight: 800,
                }}>{st.done ? "✓" : i + 1}</div>
                <span style={{ fontSize: 14.5, fontWeight: st.done ? 700 : 500, color: "#1a1a2e" }}>{st.label}</span>
              </div>
            ))}
          </div>

          {/* What they ordered, what it came to, and what they saved. Estimated
              until the order is billed at dispatch, then the exact figures —
              reflecting anything reception may have adjusted — read straight
              off the order document, the same one the printed bill comes from. */}
          {receipt && receipt.items.length > 0 && (
          <div style={{ background: "#fff", border: "1px solid #e6e1d6", borderRadius: 16, padding: 18, textAlign: "left", marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
              <div style={{ fontSize: 11.5, fontWeight: 800, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>
                {receipt.isFinal ? "Your bill" : "Your order"}
              </div>
              {!receipt.isFinal && (
                <div style={{ fontSize: 11, color: "#b58a3d", fontWeight: 700 }}>Estimate</div>
              )}
            </div>

            {receipt.items.map((it, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "5px 0", color: "#1a1a2e" }}>
                <span>{it.name} × {it.qty}</span>
                <span>₹{it.price * it.qty}</span>
              </div>
            ))}

            <div style={{ borderTop: "1px solid #f0ebe3", margin: "8px 0" }} />

            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, color: "#666", padding: "3px 0" }}>
              <span>Subtotal</span><span>₹{receipt.subtotal}</span>
            </div>
            {receipt.discounts.map((d, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, color: "#16a34a", padding: "3px 0" }}>
                <span>{d.name}</span><span>-₹{d.amount}</span>
              </div>
            ))}
            {receipt.deliveryFee > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, color: "#666", padding: "3px 0" }}>
                <span>Delivery</span><span>₹{receipt.deliveryFee}</span>
              </div>
            )}
            {receipt.taxAmount > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, color: "#666", padding: "3px 0" }}>
                <span>Tax ({receipt.taxPercent}%)</span><span>₹{receipt.taxAmount}</span>
              </div>
            )}
            {receipt.serviceAmount > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, color: "#666", padding: "3px 0" }}>
                <span>Service ({receipt.servicePercent}%)</span><span>₹{receipt.serviceAmount}</span>
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, paddingTop: 10, borderTop: "2px solid #1a1a2e", fontSize: 16, fontWeight: 800, color: "#1a1a2e" }}>
              <span>Total</span><span>₹{receipt.total}</span>
            </div>

            {receipt.discountTotal > 0 && (
              <div style={{ fontSize: 12.5, color: "#16a34a", fontWeight: 700, marginTop: 8, textAlign: "center" }}>
                🎉 You saved ₹{receipt.discountTotal}
              </div>
            )}
            {!receipt.isFinal && (
              <div style={{ fontSize: 11.5, color: "#999", marginTop: 8, textAlign: "center" }}>
                Final bill, including tax, is confirmed once the restaurant dispatches your order.
              </div>
            )}
          </div>
          )}

          {/* Only while this browser still holds what was typed. After a
              refresh the address is genuinely unavailable — it lives in a
              staff-only collection, which is the point. The customer knows
              their own address; the tracking above is what they came back for. */}
          {deliveryForm.name && (
          <div style={{ background: "#fff", border: "1px solid #e6e1d6", borderRadius: 16, padding: 18, textAlign: "left", marginBottom: 22 }}>
            <div style={{ fontSize: 11.5, fontWeight: 800, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Delivering to</div>
            <div style={{ fontSize: 14, color: "#1a1a2e", lineHeight: 1.6 }}>
              <strong>{deliveryForm.name}</strong><br />
              {deliveryForm.address}{deliveryForm.landmark ? ` · ${deliveryForm.landmark}` : ""}<br />
              <span style={{ color: "#888" }}>{deliveryForm.phone}</span>
            </div>
            <div style={{ fontSize: 12.5, color: "#888", marginTop: 10, paddingTop: 10, borderTop: "1px solid #f0ebe3" }}>
              {payMethod === "cod" ? "Paying cash on delivery" : "Paying by UPI on delivery"}
            </div>
          </div>
          )}

          <button onClick={() => {
            setScreen("menu");
            setPlacedOrderId(null);
            setTrackedOrder(null);
            setDeliveryForm({ name: "", phone: "", address: "", landmark: "" });
            // Otherwise the restored-order effect would put them straight back
            // on this screen.
            try { localStorage.removeItem(`cabadra:lastOrder:${restaurantId}`); } catch {}
          }} className="tap-btn"
            style={{ padding: "13px 24px", borderRadius: 12, border: "1px solid #e6e1d6", background: "#fff", color: "#1a1a2e", fontWeight: 700, fontSize: 14.5, cursor: "pointer" }}>
            Order something else
          </button>
        </div>
      </div>
    );
  }

  // ---------- No restaurant in the link ----------
  if (!restaurantId) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "#faf8f5" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: "#1a1a2e" }}>
            {isDeliveryMode ? "Restaurant not found" : "Invalid QR Code"}
          </h2>
          <p style={{ color: "#6b6b7b", marginTop: 8 }}>
            {isDeliveryMode
              ? "This ordering link looks incomplete. Please use the link from the restaurant's page."
              : "Please scan a valid table QR code."}
          </p>
        </div>
      </div>
    );
  }

  // ---------- Closed, or not taking online orders ----------
  if (isDeliveryMode && !website.enabled) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "#faf8f5" }}>
        <div style={{ textAlign: "center", maxWidth: 380 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🌙</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: "#1a1a2e" }}>{profile?.name || "This restaurant"}</h2>
          <p style={{ color: "#6b6b7b", marginTop: 8, lineHeight: 1.6 }}>
            Online ordering isn&apos;t available here yet. You&apos;re very welcome to visit us in person.
          </p>
        </div>
      </div>
    );
  }

  // ---------- Splash ----------
  if (showSplash) {
    const layers = ["🍞", "🥬", "🍅", "🧀", "🥩", "🍞"];
    return (
      <div onClick={dismissSplash} style={{ position: "fixed", inset: 0, zIndex: 999, cursor: "pointer", background: "linear-gradient(135deg, #1a1a2e 0%, #241f3d 55%, #2d1b1b 100%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", opacity: splashLeaving ? 0 : 1, transition: "opacity 0.45s ease", overflow: "hidden" }}>
        <div style={{ fontSize: 11, letterSpacing: 3, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", marginBottom: 18, fontWeight: 700, animation: "splashFade 0.6s ease" }}>Preparing the kitchen...</div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          {layers.map((l, i) => (
            <span key={i} style={{ fontSize: 38, lineHeight: 1, marginTop: i === 0 ? 0 : -10, animation: `layerDrop 0.5s ease ${i * 0.18}s both`, filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.35))" }}>{l}</span>
          ))}
        </div>
        <div style={{ textAlign: "center", padding: 20, position: "relative", zIndex: 1, marginTop: 6 }}>
          {profile?.logoUrl && (<img src={profile.logoUrl} alt="" style={{ width: 64, height: 64, borderRadius: "50%", objectFit: "cover", margin: "0 auto 16px", display: "block", border: "3px solid rgba(232,163,61,0.6)", animation: `splashGlow 2.2s ease-in-out infinite ${layers.length * 0.18}s` }} />)}
          <div style={{ fontFamily: DISPLAY_FONT, fontWeight: 400, fontSize: 36, color: "#fff", letterSpacing: 0.5, textTransform: "uppercase", animation: `splashLetters 1s ease ${layers.length * 0.18 + 0.15}s both` }}>{profile?.name || "Welcome"}</div>
          <div style={{ width: 46, height: 2, background: "#e8a33d", margin: "16px auto", animation: `splashLine 0.9s ease ${layers.length * 0.18 + 0.35}s both` }} />
          <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.55)", letterSpacing: 1.5, textTransform: "uppercase", animation: `splashFade 1s ease ${layers.length * 0.18 + 0.5}s both` }}>{profile?.tagline || "Scan, order, enjoy"}</div>
        </div>
      </div>
    );
  }

  // ---------- Table picker ----------
  //
  // Only for someone sitting in the restaurant whose QR did not carry a table
  // number. A delivery customer has no table and must never be asked to pick
  // one — they came from a link on a Google profile, not from a seat.
  if (!tableNo && !isDeliveryMode) {
    return (
      <div style={{ minHeight: "100vh", background: "#fff", padding: 24, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>
        <div style={{ maxWidth: 480, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            {profile?.logoUrl && (<img src={profile.logoUrl} alt="logo" style={{ width: 80, height: 80, borderRadius: "50%", objectFit: "cover", marginBottom: 16 }} />)}
            <h1 style={{ fontFamily: DISPLAY_FONT, fontWeight: 400, fontSize: 30, color: "#1a1a2e", textTransform: "uppercase", letterSpacing: 0.4 }}>{profile?.name || "Welcome"}</h1>
            {profile?.tagline && <p style={{ color: "#888", marginTop: 4, fontSize: 14 }}>{profile.tagline}</p>}
          </div>
          <div style={{ background: "#fff", borderRadius: 20, padding: 24, boxShadow: "0 4px 20px rgba(0,0,0,0.08)", marginBottom: 20 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Which table are you at?</h2>
            <p style={{ fontSize: 14, color: "#888", marginBottom: 20 }}>Select your table number to view the menu</p>
            {tables.length === 0 ? (
              <div style={{ textAlign: "center", padding: 40, color: "#888" }}><div style={{ fontSize: 40, marginBottom: 12 }}>🪑</div><p>No tables set up yet.</p></div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
                {tables.map((t) => (
                  <button key={t.id} onClick={() => { playTone(520, 80, "triangle"); setTableNo(t.number); }} className="tap-btn"
                    style={{ padding: "20px 8px", fontSize: 22, fontWeight: 700, borderRadius: 16, border: "2px solid #eee", background: "#fff", color: "#1a1a2e", cursor: "pointer" }}>
                    {t.number}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const hasPreBillOrders = activeOrders.some((o) => ["pending", "confirmed", "preparing", "ready", "served"].includes(o.status));
  const billOrders = activeOrders.filter((o) => ["bill_requested", "billed"].includes(o.status));
  const showBillScreen = !hasPreBillOrders && billOrders.length > 0;

  // ---------- Bill screen ----------
  if (showBillScreen && !addingMore) {
    const o = billOrders[billOrders.length - 1];
    const billSubtotal = o.items.reduce((sum, it) => sum + it.price * it.qty, 0);
    return (
      <div style={{ minHeight: "100vh", background: "#f8f6f3", padding: 24, fontFamily: "sans-serif" }}>
        {ratingOrder && <RatingPopup order={ratingOrder} restaurantId={restaurantId} onDone={() => setRatingOrder(null)} googleReviewLink={googleReviewLink} />}
        <div style={{ maxWidth: 480, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
            {profile?.logoUrl && (<img src={profile.logoUrl} alt="logo" style={{ width: 44, height: 44, borderRadius: "50%", objectFit: "cover" }} />)}
            <div><div style={{ fontWeight: 700, fontSize: 18 }}>{profile?.name || "Cabadra"}</div><div style={{ fontSize: 13, color: "#888" }}>{isDeliveryMode ? "Delivery" : `Table ${tableNo}`}</div></div>
          </div>

          {o.status === "bill_requested" && (
            <div style={{ background: "linear-gradient(135deg, #fff5e0 0%, #fef3c7 100%)", borderRadius: 20, padding: 32, textAlign: "center", marginBottom: 20, border: "1px solid #fde68a" }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>🧾</div>
              <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Bill Requested</h3>
              <p style={{ color: "#92400e", fontSize: 14 }}>The front desk is preparing your bill now.</p>
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px dashed #fde68a" }}>
                {o.items.map((it, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 14 }}>
                    <span>{it.name} <span style={{ color: "#888" }}>×{it.qty}</span></span><span>₹{it.price * it.qty}</span>
                  </div>
                ))}
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, paddingTop: 10, borderTop: "2px solid #1a1a2e", fontWeight: 800, fontSize: 16 }}>
                  <span>Subtotal</span><span>₹{billSubtotal}</span>
                </div>
              </div>
            </div>
          )}

          {o.status === "billed" && (
            <div style={{ background: "#fff", borderRadius: 20, padding: 0, overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.06)" }}>
              <div style={{ padding: "24px 24px 16px", borderBottom: "2px dashed #eee" }}>
                <div style={{ textAlign: "center", marginBottom: 16 }}>
                  <div style={{ fontSize: 13, color: "#888", textTransform: "uppercase", letterSpacing: 1 }}>Receipt</div>
                  <div style={{ fontSize: 20, fontWeight: 800, marginTop: 4 }}>{profile?.name || "Cabadra"}</div>
                  <div style={{ fontSize: 12, color: "#888" }}>{isDeliveryMode ? "Delivery" : `Table ${tableNo}`}</div>
                </div>
                {o.items.map((it, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", fontSize: 15, borderBottom: i < o.items.length - 1 ? "1px dotted #eee" : "none" }}>
                    <span>{it.name} <span style={{ color: "#888" }}>×{it.qty}</span></span><span style={{ fontWeight: 600 }}>₹{it.price * it.qty}</span>
                  </div>
                ))}
              </div>
              <div style={{ padding: 20, background: "#f8f6f3" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 6 }}><span style={{ color: "#888" }}>Subtotal</span><span>₹{o.billSubtotal ?? billSubtotal}</span></div>
                {(o.billDiscounts || []).map((d, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6, color: "#16a34a" }}><span>🎁 {d.name}</span><span>-₹{d.amount}</span></div>
                ))}
                {o.billTaxAmount > 0 && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 6, color: "#888" }}><span>Tax ({o.billTaxPercent}%)</span><span>₹{o.billTaxAmount}</span></div>}
                {o.billServiceAmount > 0 && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 6, color: "#888" }}><span>Service ({o.billServicePercent}%)</span><span>₹{o.billServiceAmount}</span></div>}
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, fontWeight: 800, marginTop: 10, paddingTop: 10, borderTop: "2px solid #1a1a2e" }}><span>Total</span><span>₹{o.billTotal ?? billSubtotal}</span></div>
                {o.paymentQrUrl && (
                  <div style={{ textAlign: "center", marginTop: 20 }}>
                    <div style={{ fontSize: 12, color: "#888", marginBottom: 8, fontWeight: 600 }}>Scan to pay via UPI</div>
                    <img src={o.paymentQrUrl} alt="Pay via UPI" style={{ width: 180, margin: "0 auto", display: "block" }} />
                  </div>
                )}
              </div>
            </div>
          )}
          <div style={{ textAlign: "center", marginTop: 24, fontSize: 13, color: "#888" }}>Awaiting payment — pay at the counter or with staff.</div>
        </div>
      </div>
    );
  }

  // ---------- Status screen ----------
  if (activeOrders.length > 0 && !addingMore) {
    const dominantOrder = activeOrders.find((o) => o.status === "preparing")
      || activeOrders.find((o) => o.status === "ready")
      || activeOrders.find((o) => o.status === "confirmed")
      || activeOrders.find((o) => o.status === "pending")
      || activeOrders[activeOrders.length - 1];
    const dominantCountdown = getCountdown(dominantOrder);

    return (
      <div style={{ minHeight: "100vh", background: "#f8f6f3", padding: 24, fontFamily: "sans-serif", paddingBottom: 100 }}>
        {statusToast && <StatusToast emoji={statusToast.emoji} msg={statusToast.msg} />}
        {successOverlay && <SuccessOverlay message={successOverlay} />}
        {ratingOrder && <RatingPopup order={ratingOrder} restaurantId={restaurantId} onDone={() => setRatingOrder(null)} googleReviewLink={googleReviewLink} />}
        <div style={{ maxWidth: 480, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
            {profile?.logoUrl && (<img src={profile.logoUrl} alt="logo" style={{ width: 44, height: 44, borderRadius: "50%", objectFit: "cover" }} />)}
            <div><div style={{ fontWeight: 700, fontSize: 18 }}>{profile?.name || "Cabadra"}</div><div style={{ fontSize: 13, color: "#888" }}>{isDeliveryMode ? "Delivery" : `Table ${tableNo}`}</div></div>
          </div>

          <div style={{ background: "#1C1B1A", color: "#fff", borderRadius: 20, padding: 32, textAlign: "center", marginBottom: 24 }}>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{statusWords[dominantOrder.status] || dominantOrder.status}</div>
            {dominantOrder.status === "preparing" && dominantCountdown && (
              <div style={{ fontSize: 48, marginTop: 14, fontFamily: "monospace", fontWeight: 700, letterSpacing: 2, color: "#e8a33d" }}>{dominantCountdown}</div>
            )}
          </div>

          {activeOrders.map((o) => {
            const countdown = getCountdown(o);
            return (
              <div key={o.id} style={{ background: "#fff", borderRadius: 16, padding: 20, marginBottom: 16, boxShadow: "0 2px 12px rgba(0,0,0,0.04)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>
                    Order · {new Date(o.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {o.orderType === "takeaway" && <span style={{ marginLeft: 8, fontSize: 10.5, background: "#1a1a2e", color: "#fff", padding: "2px 8px", borderRadius: 100, fontWeight: 800 }}>📦 TAKEAWAY</span>}
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: "#e8a33d" }}>{statusWords[o.status] || o.status}</span>
                </div>
                {countdown && o.status === "preparing" && <div style={{ fontFamily: "monospace", fontSize: 28, fontWeight: 700, color: "#e8a33d", marginBottom: 10 }}>{countdown}</div>}
                {o.items.map((it, i) => (
                  <div key={i} style={{ padding: "6px 0", borderTop: i > 0 ? "1px solid #f4f4f4" : "none" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}><span>{it.name}</span><span style={{ fontWeight: 700 }}>×{it.qty}</span></div>
                    {it.spiceLevel && <div style={{ fontSize: 11, color: "#e8a33d" }}>🌶 {it.spiceLevel}</div>}
                    {it.notes && <div style={{ fontSize: 11, color: "#888", fontStyle: "italic" }}>"{it.notes}"</div>}
                  </div>
                ))}
              </div>
            );
          })}

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <button onClick={() => { playTone(560, 70); setAddingMore(true); }} className="tap-btn" style={{ width: "100%", padding: 16, fontSize: 15, fontWeight: 600, borderRadius: 14, border: "2px solid #1a1a2e", background: "#fff", color: "#1a1a2e", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <span>➕</span> Add more items
            </button>
            {/* Always available, whatever is still cooking — a table should
                never be blocked from asking to pay just because dessert
                hasn't come out yet. See requestBill() for why this is safe:
                it never touches an order still in the kitchen's queue. */}
            {billRequestSent ? (
              <div style={{ width: "100%", padding: 16, borderRadius: 14, background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", fontWeight: 700, fontSize: 14.5, textAlign: "center" }}>
                ✓ We've let the restaurant know — someone will be with you shortly
              </div>
            ) : (
              <button
                onClick={() => {
                  // Something to actually bill — ask how they'll pay (and,
                  // while we have them, their name and number) before it goes
                  // to reception, rather than reception asking for it later.
                  // Nothing to bill yet (everything still cooking) skips
                  // straight to the guaranteed ping — there is nothing here
                  // worth asking about.
                  if (activeOrders.some((o) => o.status === "served")) {
                    setBillDetailsForm({ name: "", phone: "", paymentMethod: "cash" });
                    setBillDetailsModalOpen(true);
                  } else {
                    requestBill();
                  }
                }}
                className="tap-btn" style={{ width: "100%", padding: 16, fontSize: 16, fontWeight: 700, borderRadius: 14, border: "none", background: "#e8a33d", color: "#1a1a2e", cursor: "pointer" }}>
                🧾 Request Bill
              </button>
            )}
            {billRequestError && (
              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", padding: 14, borderRadius: 12, fontSize: 13.5 }}>
                {billRequestError}
              </div>
            )}
          </div>
        </div>

        {billDetailsModalOpen && (
          <div onClick={() => setBillDetailsModalOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 260, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: "24px 24px 0 0", width: "100%", maxWidth: 480, padding: 24, animation: "modalScaleIn 0.3s cubic-bezier(0.22,1,0.36,1)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <h3 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>How will you be paying?</h3>
                <button onClick={() => setBillDetailsModalOpen(false)} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: "#888" }}>×</button>
              </div>
              <p style={{ fontSize: 13, color: "#888", marginTop: 2, marginBottom: 18 }}>This goes straight to the restaurant with your bill request.</p>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, marginBottom: 18 }}>
                {PAYMENT_METHODS.map((m) => (
                  <button key={m.key} type="button"
                    onClick={() => setBillDetailsForm((p) => ({ ...p, paymentMethod: m.key }))}
                    className="tap-btn"
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 12px", borderRadius: 14, cursor: "pointer", textAlign: "left",
                      border: billDetailsForm.paymentMethod === m.key ? "2px solid #e8a33d" : "1px solid #eee",
                      background: billDetailsForm.paymentMethod === m.key ? "#fff5e0" : "#fff" }}>
                    <span style={{ fontSize: 18 }}>{m.icon}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e" }}>{m.label}</span>
                  </button>
                ))}
              </div>

              <input value={billDetailsForm.name}
                onChange={(e) => setBillDetailsForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="Your name" autoComplete="name"
                style={{ width: "100%", padding: "13px 14px", fontSize: 15, borderRadius: 12, boxSizing: "border-box", border: "1.5px solid #e6e1d6", background: "#fff", fontFamily: "inherit", marginBottom: 10 }} />
              <input value={billDetailsForm.phone}
                onChange={(e) => setBillDetailsForm((p) => ({ ...p, phone: e.target.value }))}
                placeholder="Phone number" type="tel" autoComplete="tel"
                style={{ width: "100%", padding: "13px 14px", fontSize: 15, borderRadius: 12, boxSizing: "border-box", border: "1.5px solid #e6e1d6", background: "#fff", fontFamily: "inherit", marginBottom: 18 }} />

              <button onClick={() => { setBillDetailsModalOpen(false); requestBill(billDetailsForm); }} className="tap-btn"
                style={{ width: "100%", padding: 16, borderRadius: 14, border: "none", background: "#e8a33d", color: "#1a1a2e", fontSize: 16, fontWeight: 700, cursor: "pointer" }}>
                🧾 Send Bill Request
              </button>
            </div>
          </div>
        )}

        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#fff", borderTop: "1px solid #eee", padding: "12px 20px", zIndex: 50 }}>
          <button onClick={() => { playTone(560, 70); setAddingMore(true); }} className="tap-btn" style={{ width: "100%", maxWidth: 480, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: 14, borderRadius: 50, border: "none", background: "#1a1a2e", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,0.15)" }}>
            <span>🛒</span>{count > 0 ? `${count} items · ₹${displayTotal}` : "Browse Menu"}
          </button>
        </div>
      </div>
    );
  }

  // ---------- Full Menu ----------
  if (screen === "allMenu") {
    return (
      <div style={{ minHeight: "100vh", background: "#fff", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", paddingBottom: 100 }}>
        {successOverlay && <SuccessOverlay message={successOverlay} />}
        {detailItem && (
          <ItemDetailModal
            item={detailItem}
            onClose={closeDetailModal}
            onAdd={handleDetailAdd}
            startMode={editingLineId ? "customize" : "view"}
            initialNotes={editingLineId ? (cart[editingLineId]?.notes || "") : ""}
            initialSpiceLevel={editingLineId ? (cart[editingLineId]?.spiceLevel || null) : null}
            initialVariationId={editingLineId ? (cart[editingLineId]?.variationId || null) : null}
            initialAddonIds={editingLineId ? (cart[editingLineId]?.addonIds || []) : []}
          />
        )}
        <div style={{ position: "sticky", top: 0, zIndex: 10, background: "#fff", borderBottom: "1px solid #f0f0f0" }}>
          <div style={{ maxWidth: 480, margin: "0 auto", padding: "16px 20px", display: "flex", alignItems: "center", gap: 14 }}>
            <button onClick={() => { playTone(440, 70); setScreen("menu"); }} className="tap-btn" style={{ width: 36, height: 36, borderRadius: "50%", border: "1px solid #eee", background: "#fff", fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#1a1a2e", flexShrink: 0 }} aria-label="Back">←</button>
            <div style={{ fontFamily: DISPLAY_FONT, fontWeight: 400, fontSize: 20, color: "#1a1a2e", textTransform: "uppercase", letterSpacing: 0.3 }}>Full Menu</div>
          </div>
        </div>
        <div style={{ maxWidth: 480, margin: "0 auto", padding: 20 }}>
          {availableItems.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: "#888" }}><div style={{ fontSize: 40, marginBottom: 12 }}>🍽️</div><p>No items on the menu yet.</p></div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>
              {availableItems.map((it) => (<MenuCard key={it.id} item={it} qty={qtyForItem(it.id)} onAdd={() => addToCart(it.id, 1)} onOpenDetail={openItemDetail} />))}
            </div>
          )}
        </div>
        {bottomCartBar}
        {cartSummaryModal}
      </div>
    );
  }

  // ---------- MAIN MENU SCREEN ----------
  return (
    <div style={{ minHeight: "100vh", background: "#fff", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", paddingBottom: 100 }}>
      <style jsx>{` .hscroll::-webkit-scrollbar { display: none; } `}</style>
      {successOverlay && <SuccessOverlay message={successOverlay} />}
      {detailItem && (
        <ItemDetailModal
          item={detailItem}
          onClose={closeDetailModal}
          onAdd={handleDetailAdd}
          startMode={editingLineId ? "customize" : "view"}
          initialNotes={editingLineId ? (cart[editingLineId]?.notes || "") : ""}
          initialSpiceLevel={editingLineId ? (cart[editingLineId]?.spiceLevel || null) : null}
          initialVariationId={editingLineId ? (cart[editingLineId]?.variationId || null) : null}
          initialAddonIds={editingLineId ? (cart[editingLineId]?.addonIds || []) : []}
        />
      )}
      {ratingOrder && <RatingPopup order={ratingOrder} restaurantId={restaurantId} onDone={() => setRatingOrder(null)} googleReviewLink={googleReviewLink} />}
      {showWaiterModal && <WaiterModal onClose={() => setShowWaiterModal(false)} onSend={callWaiter} />}

      {/* ===== HEADER: Call Waiter (top-left) · Logo/name · Table pill (top-right) ===== */}
      <div style={{ background: "linear-gradient(135deg, #fff5e0 0%, #fef3c7 100%)", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: 480, margin: "0 auto", padding: "16px 20px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              {/* Calling a waiter means nothing to someone ordering from home. */}
              {!isDeliveryMode && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, flexShrink: 0 }}>
                  <button onClick={() => { playTone(500, 60); setShowWaiterModal(true); }} className="tap-btn" aria-label="Call Waiter"
                    style={{ width: 38, height: 38, borderRadius: "50%", border: "none", background: "#1a1a2e", color: "#fff", fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 8px rgba(26,26,46,0.25)" }}>
                    🛎️
                  </button>
                  <span style={{ fontSize: 8.5, fontWeight: 700, color: "#a08a5c", whiteSpace: "nowrap", letterSpacing: 0.2 }}>Call Staff</span>
                </div>
              )}
              {profile?.logoUrl ? (
                <img src={profile.logoUrl} alt="logo" style={{ width: 40, height: 40, borderRadius: 10, objectFit: "cover", flexShrink: 0 }} />
              ) : (
                <div style={{ width: 40, height: 40, borderRadius: 10, background: "#1a1a2e", display: "flex", alignItems: "center", justifyContent: "center", color: "#e8a33d", fontWeight: 800, fontSize: 16, flexShrink: 0 }}>
                  {profile?.name?.charAt(0) || "T"}
                </div>
              )}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: DISPLAY_FONT, fontWeight: 400, fontSize: 17, color: "#1a1a2e", textTransform: "uppercase", letterSpacing: 0.3, lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{profile?.name || "Menu"}</div>
                {profile?.tagline ? (
                  <div style={{ fontSize: 10.5, color: "#a08a5c", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{profile.tagline}</div>
                ) : (
                  <div style={{ fontSize: 11, color: "#a08a5c", fontWeight: 600 }}>
                    {isDeliveryMode ? "🛵 Delivery" : `📍 Table ${tableNo}`}
                  </div>
                )}
              </div>
            </div>

            <span style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.7)", padding: "6px 12px", borderRadius: 100, fontSize: 12.5, fontWeight: 700, color: "#1a1a2e", flexShrink: 0 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: isDeliveryMode ? (isOpenAt(website.hours) ? "#16a34a" : "#dc2626") : "#dc2626" }} />
              {isDeliveryMode ? (isOpenAt(website.hours) ? "Open now" : "Closed") : `Table ${tableNo}`}
            </span>
          </div>

          {/* Search bar + Veg filter */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
              <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontSize: 15, color: "#aaa" }}>🔍</span>
              <input
                type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search your favourite dish..."
                style={{ width: "100%", padding: "11px 14px 11px 40px", borderRadius: 14, border: "none", background: "rgba(255,255,255,0.75)", fontSize: 13.5, outline: "none", boxSizing: "border-box", color: "#1a1a2e" }}
              />
            </div>
            <button
              onClick={() => { playTone(500, 50); setVegOnly((v) => !v); }}
              className="tap-btn"
              style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, background: vegOnly ? "#16a34a" : "rgba(255,255,255,0.65)", borderRadius: 100, padding: "7px 12px", border: "none", cursor: "pointer" }}
            >
              <span style={{ width: 12, height: 12, border: `1.5px solid ${vegOnly ? "#fff" : "#16a34a"}`, borderRadius: 3, position: "relative", display: "inline-block", flexShrink: 0 }}>
                <span style={{ position: "absolute", inset: 1.5, borderRadius: "50%", background: vegOnly ? "#fff" : "#16a34a" }} />
              </span>
              <span style={{ fontSize: 11, fontWeight: 800, color: vegOnly ? "#fff" : "#1a1a2e" }}>Veg Only</span>
            </button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        {isSearching ? (
          <div style={{ padding: "20px 20px 24px" }}>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: "#1a1a2e", marginBottom: 16 }}>Results for &ldquo;{searchQuery}&rdquo;</h2>
            {searchResults.length === 0 ? (
              <div style={{ textAlign: "center", padding: 40, color: "#888" }}><div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div><p>No dishes match your search.</p></div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>
                {searchResults.map((it) => (<MenuCard key={it.id} item={it} qty={qtyForItem(it.id)} onAdd={() => addToCart(it.id, 1)} onOpenDetail={openItemDetail} />))}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* ===== OFFER CAROUSEL: reception-curated exclusive deals — hidden if empty ===== */}
            {offerBanners.length > 0 && !addingMore && (
              <div style={{ padding: "16px 20px 0" }}>
                <div ref={offerScrollRef} onScroll={handleOfferScroll} className="hscroll" style={{ display: "flex", overflowX: "auto", scrollSnapType: "x mandatory", borderRadius: 20, WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}>
                  {offerBanners.map((banner) => {
                    const linkedItem = findItem(banner.linkedItemId);
                    return (
                      <div key={banner.id} onClick={() => handleOfferBannerClick(banner)} className="tap-btn" style={{ flex: "0 0 100%", scrollSnapAlign: "start", position: "relative", aspectRatio: "16 / 9", background: "#1a1a2e", overflow: "hidden", cursor: banner.linkedItemId ? "pointer" : "default" }}>
                        {banner.imageUrl && <img src={banner.imageUrl} alt={banner.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(0,0,0,0.82) 0%, rgba(0,0,0,0.15) 55%, rgba(0,0,0,0) 75%)" }} />
                        <div style={{ position: "absolute", left: 18, right: 18, bottom: 16 }}>
                          <div style={{ fontSize: 10.5, fontWeight: 800, color: "#e8a33d", textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 5 }}>🎉 Exclusive Deal</div>
                          <div style={{ fontSize: 19, fontWeight: 800, color: "#fff", lineHeight: 1.25 }}>{banner.title}</div>
                          {linkedItem && (() => {
                            const dp = computeOfferPrice(banner, linkedItem);
                            return (
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                                <span style={{ fontSize: 12.5, color: "rgba(255,255,255,0.9)", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 160 }}>{linkedItem.name}</span>
                                {dp != null ? (
                                  <span style={{ fontSize: 12.5, fontWeight: 800, color: "#1a1a2e", background: "#e8a33d", padding: "3px 10px", borderRadius: 100, display: "flex", alignItems: "center", gap: 6 }}>
                                    ₹{dp} <s style={{ opacity: 0.6, fontWeight: 600 }}>₹{linkedItem.price}</s> · {banner.discountPercent}% OFF
                                  </span>
                                ) : (
                                  <span style={{ fontSize: 12.5, fontWeight: 800, color: "#1a1a2e", background: "#e8a33d", padding: "3px 10px", borderRadius: 100 }}>₹{linkedItem.price} · Tap to add</span>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {offerBanners.length > 1 && (
                  <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 10 }}>
                    {offerBanners.map((_, idx) => (<div key={idx} onClick={() => scrollOfferTo(idx)} style={{ width: 8, height: 8, borderRadius: "50%", background: idx === offerIndex ? "#e8a33d" : "#ddd", cursor: "pointer" }} />))}
                  </div>
                )}
              </div>
            )}

            {/* ===== CATEGORY PILLS (circular, unchanged) ===== */}
            <div style={{ padding: "18px 20px 0" }}>
              <div className="hscroll" style={{ display: "flex", gap: 14, overflowX: "auto", paddingBottom: 8, scrollbarWidth: "none" }}>
                {categories.map((cat) => {
                  const icon = getCategoryIcon(cat, categoryIconMap);
                  const isActive = activeCategory === cat;
                  return (
                    <button key={cat} onClick={() => { playTone(500, 60); setActiveCategory(cat); }} className="tap-btn" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", flexShrink: 0, padding: 0 }}>
                      <div style={{ width: 62, height: 62, borderRadius: "50%", overflow: "hidden", border: isActive ? "2.5px solid #e8a33d" : "2.5px solid #f0ebe3", background: icon.type === "image" ? "#f8f6f3" : (isActive ? "#1a1a2e" : "#f8f6f3"), display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {icon.type === "image" ? <img src={icon.src} alt={cat} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontSize: 24 }}>{icon.value}</span>}
                      </div>
                      <span style={{ fontSize: 10.5, fontWeight: isActive ? 800 : 600, color: isActive ? "#1a1a2e" : "#999", whiteSpace: "nowrap" }}>{cat}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ===== SPOTLIGHT CAROUSEL: up to 5 standout items, auto-scrolling, catchy backgrounds ===== */}
            {spotlightItems.length > 0 && (
              <div style={{ marginTop: 18, padding: "0 20px 4px" }}>
                <h2 style={{ fontFamily: DISPLAY_FONT, fontWeight: 400, fontSize: 19, color: "#1a1a2e", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 12 }}>Loved by Everyone</h2>
                <div ref={spotlightScrollRef} className="hscroll" style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 8, scrollbarWidth: "none" }}>
                  {spotlightItems.map((item, i) => {
                    const bg = SPOTLIGHT_COLORS[i % SPOTLIGHT_COLORS.length];
                    const badge = item.mostLoved ? { icon: "🔥", label: "Most Loved" } : item.mostOrdered ? { icon: "🔥", label: "Most Ordered" } : item.mostRated ? { icon: "⭐", label: "Most Rated" } : { icon: "★", label: "Featured" };
                    return (
                      <div key={item.id} onClick={() => openItemDetail(item)} className="tap-btn" style={{ flex: "0 0 168px", scrollSnapAlign: "start", background: bg, borderRadius: 18, padding: 12, cursor: "pointer" }}>
                        <div style={{ position: "relative", width: "100%", height: 100, borderRadius: 12, overflow: "hidden", marginBottom: 8, background: "#fff" }}>
                          {item.imageUrl ? <img src={item.imageUrl} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30 }}>🍽️</div>}
                          <span style={{ position: "absolute", top: 6, left: 6, background: "rgba(255,255,255,0.92)", color: "#92400e", fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 100 }}>{badge.icon} {badge.label}</span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <VegBadge foodType={item.foodType} />
                          <div style={{ fontWeight: 700, fontSize: 12.5, color: "#1a1a2e", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</div>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                          <span style={{ fontWeight: 800, fontSize: 14, color: "#1a1a2e" }}>₹{item.price}</span>
                          <button onClick={(e) => { e.stopPropagation(); playTone(680, 90, "triangle"); addToCart(item.id, 1); }} className="tap-btn" style={{ width: 26, height: 26, borderRadius: "50%", border: "none", background: "#1a1a2e", color: "#fff", fontSize: 15, fontWeight: 800, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ===== POPULAR PICKS (horizontal scroll) ===== */}
            <div style={{ padding: "0 20px 18px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <h2 style={{ fontFamily: DISPLAY_FONT, fontWeight: 400, fontSize: 19, color: "#1a1a2e", textTransform: "uppercase", letterSpacing: 0.3 }}>{activeCategory === "All" ? "Popular Picks" : activeCategory}</h2>
                {activeCategory === "All" && availableItems.length > POPULAR_LIMIT && (
                  <button onClick={() => { playTone(440, 70); setScreen("allMenu"); }} className="tap-btn" style={{ background: "none", border: "none", color: "#e8a33d", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>View All →</button>
                )}
                {activeCategory !== "All" && (
                  <button onClick={() => { playTone(440, 70); setActiveCategory("All"); }} className="tap-btn" style={{ background: "none", border: "none", color: "#e8a33d", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>View All →</button>
                )}
              </div>

              {filteredItems.length === 0 && (
                <div style={{ textAlign: "center", padding: 40, color: "#888" }}><div style={{ fontSize: 40, marginBottom: 12 }}>🍽️</div><p>No items in this category.</p></div>
              )}

              {activeCategory === "All" ? (
                <div className="hscroll" style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 8, scrollbarWidth: "none" }}>
                  {filteredItems.slice(0, POPULAR_LIMIT).map((it) => (<MenuCard key={it.id} item={it} qty={qtyForItem(it.id)} onAdd={() => addToCart(it.id, 1)} onOpenDetail={openItemDetail} width={132} />))}
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>
                  {filteredItems.map((it) => (<MenuCard key={it.id} item={it} qty={qtyForItem(it.id)} onAdd={() => addToCart(it.id, 1)} onOpenDetail={openItemDetail} />))}
                </div>
              )}
            </div>

            {/* ===== MORE TO EXPLORE (ALL items with filter) ===== */}
            <div style={{ padding: "0 20px 24px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <h2 style={{ fontFamily: DISPLAY_FONT, fontWeight: 400, fontSize: 19, color: "#1a1a2e", textTransform: "uppercase", letterSpacing: 0.3 }}>More to Explore</h2>
                <div style={{ position: "relative" }}>
                  <button onClick={() => setShowExploreFilter((s) => !s)} className="tap-btn" style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 100, border: "1px solid #e6e1d6", background: "#fff", fontSize: 12, fontWeight: 700, color: "#666", cursor: "pointer" }}>
                    <span>🔽</span> Filter
                  </button>
                  {showExploreFilter && (
                    <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", background: "#fff", borderRadius: 14, boxShadow: "0 8px 32px rgba(0,0,0,0.12)", border: "1px solid #f0f0f0", padding: 8, minWidth: 190, zIndex: 20 }}>
                      {[
                        { key: "all", label: "All Items" },
                        { key: "veg", label: "🥬 Veg Only" },
                        { key: "nonveg", label: "🍗 Non-veg Only" },
                        { key: "price-low", label: "💰 Price: Low to High" },
                        { key: "price-high", label: "💰 Price: High to Low" },
                        { key: "most-loved", label: "🔥 Most Loved" },
                        { key: "most-ordered", label: "🔥 Most Ordered" },
                        { key: "most-rated", label: "⭐ Most Rated" },
                      ].map((opt) => (
                        <button key={opt.key} onClick={() => { setExploreFilter(opt.key); setShowExploreFilter(false); }}
                          style={{ width: "100%", textAlign: "left", padding: "8px 12px", borderRadius: 8, border: "none", background: exploreFilter === opt.key ? "#fff5e0" : "transparent", color: exploreFilter === opt.key ? "#92400e" : "#666", fontSize: 13, fontWeight: exploreFilter === opt.key ? 700 : 600, cursor: "pointer" }}>
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {exploreItems.length === 0 ? (
                <div style={{ textAlign: "center", padding: 40, color: "#888" }}><div style={{ fontSize: 40, marginBottom: 12 }}>🍽️</div><p>No items match this filter.</p></div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>
                  {exploreItems.map((it) => (<MenuCard key={it.id} item={it} qty={qtyForItem(it.id)} onAdd={() => addToCart(it.id, 1)} onOpenDetail={openItemDetail} />))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {bottomCartBar}
      {cartSummaryModal}
    </div>
  );
}

export default function TablePage() {
  return (
    <>
      <style>{GLOBAL_ANIMATION_CSS}</style>
      <Suspense fallback={
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "sans-serif", color: "#888" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ width: 40, height: 40, border: "3px solid #eee", borderTopColor: "#e8a33d", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 16px" }} />
            Loading menu...
          </div>
        </div>
      }>
        <TableContent />
      </Suspense>
    </>
  );
}