"use client";
// FINAL REDESIGN — table-side customer menu, matching the Oak Restro reference layout.
//
// UPDATE (this pass):
// 1. "Customise this item" is now a clearly-visible pill button (was a faint
//    underlined link tucked right under the description).
// 2. NEW: every cart line now has its own "Customise this item" link. Tapping
//    it reopens the item modal pre-filled with that line's current spice
//    level / notes and SAVES BACK onto that same line (no duplicate line).
// 3. "People also ordered" rebuilt as two full image cards (max 2 items).
// 4. "Complete your meal" rebuilt as one attractive image card instead of a
//    thin text row.
// 5. Call Waiter button now has a tiny "Call Staff" caption under it.
//
// Everything else (hero carousel, spotlight card, category pills, promo
// banner, Google-review flow, dine-in/takeaway, bill flow) is UNCHANGED.
//
// Firestore fields this page expects to exist (maintained elsewhere — reception
// dashboard / a future aggregation job, not by this file):
//   menuItems/{id}: averageRating, reviewCount, mostLoved, mostOrdered, mostRated
//   info/settings: googleReviewLink, spotlightMetric ("mostLoved"|"mostOrdered"|"mostRated")
// This file reads them defensively — everything degrades gracefully if absent.

import { Suspense, useEffect, useState, useRef, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { db } from "@/lib/firebase";
import { collection, addDoc, updateDoc, doc, onSnapshot, query, where, orderBy, writeBatch } from "firebase/firestore";

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

const MEAL_COMPLETION_RULES = {
  "Mains": { needs: ["Breads & Rice", "Bread", "Rice", "Breads"], suggestCategory: "Breads & Rice" },
  "Main Course": { needs: ["Breads & Rice", "Bread", "Rice", "Breads"], suggestCategory: "Breads & Rice" },
  "North Indian": { needs: ["Breads & Rice", "Bread", "Rice", "Breads"], suggestCategory: "Breads & Rice" },
  "Biryani": { needs: ["Beverages", "Drinks", "Mocktails"], suggestCategory: "Beverages" },
  "Starters": { needs: ["Mains", "Main Course", "North Indian", "Chinese"], suggestCategory: "Mains" },
  "Chinese": { needs: ["Beverages", "Drinks"], suggestCategory: "Beverages" },
  "Indo Chinese": { needs: ["Beverages", "Drinks"], suggestCategory: "Beverages" },
};

const WAITER_REASONS = [
  { key: "water", icon: "💧", label: "Water" },
  { key: "tissues", icon: "🧻", label: "Tissues" },
  { key: "cutlery", icon: "🍴", label: "Cutlery" },
  { key: "seasoning", icon: "🧂", label: "Seasoning / Condiments" },
  { key: "other", icon: "✋", label: "Something else" },
];

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

const GLOBAL_ANIMATION_CSS = `
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
  function handleAdd(e) {
    e.stopPropagation();
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
        {item.isCombo && (
          <span style={{ position: "absolute", top: 8, left: 8, background: "#1a1a2e", color: "#fff", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 100 }}>COMBO</span>
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
            <span style={{ fontWeight: 800, fontSize: 16, color: "#e8a33d" }}>₹{item.price}</span>
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

// Spotlight card — the single large feature between category pills & Popular
// Picks, matching the reference layout. Which metric it spotlights is set by
// the receptionist (info/settings.spotlightMetric).
function SpotlightCard({ item, metric, onAdd }) {
  if (!item) return null;
  const badge = metric === "mostOrdered"
    ? { icon: "🔥", label: "Most Ordered" }
    : metric === "mostRated"
      ? { icon: "⭐", label: "Most Rated" }
      : { icon: "🔥", label: "Most Loved" };

  return (
    <div style={{ padding: "0 20px 22px" }}>
      <div style={{ background: "#fff", borderRadius: 20, padding: 16, border: "1px solid #f0f0f0", boxShadow: "0 4px 20px rgba(0,0,0,0.05)", display: "flex", gap: 16 }}>
        <div style={{ position: "relative", width: 128, height: 128, borderRadius: 16, overflow: "hidden", flexShrink: 0, background: "#f8f6f3" }}>
          {item.imageUrl ? (
            <img src={item.imageUrl} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 36 }}>🍽️</div>
          )}
          <span style={{ position: "absolute", top: 8, left: 8, background: "#fff5e0", color: "#92400e", fontSize: 9.5, fontWeight: 800, padding: "3px 8px", borderRadius: 100, display: "flex", alignItems: "center", gap: 3, boxShadow: "0 2px 6px rgba(0,0,0,0.1)" }}>
            {badge.icon} {badge.label}
          </span>
        </div>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <VegBadge foodType={item.foodType} />
            <div style={{ fontWeight: 800, fontSize: 16, color: "#1a1a2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</div>
          </div>
          {item.description && (
            <div style={{ fontSize: 12, color: "#888", marginTop: 4, lineHeight: 1.4 }}>
              {item.description.slice(0, 62)}{item.description.length > 62 ? "…" : ""}
            </div>
          )}
          <div style={{ marginTop: "auto", display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 800, fontSize: 17, color: "#e8a33d" }}>₹{item.price}</span>
              {(item.averageRating || item.reviewCount) && <RatingBadge rating={item.averageRating} count={item.reviewCount} />}
            </div>
            <button onClick={() => onAdd(item.id, 1)} className="tap-btn" style={{ padding: "9px 20px", borderRadius: 10, border: "none", background: "#e8a33d", color: "#1a1a2e", fontWeight: 800, fontSize: 13, cursor: "pointer", flexShrink: 0 }}>
              Add +
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Item detail / customization modal.
// NEW: startMode / initialNotes / initialSpiceLevel let this modal be reopened
// from a CART LINE for editing — the parent decides (via `onAdd`) whether this
// call means "add a new line" or "update the line I was already editing".
function ItemDetailModal({ item, onClose, onAdd, startMode = "view", initialNotes = "", initialSpiceLevel = null }) {
  const [mode, setMode] = useState(startMode);
  const [notes, setNotes] = useState(initialNotes);
  const [spiceLevel, setSpiceLevel] = useState(initialSpiceLevel);

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
              <div style={{ fontSize: 18, fontWeight: 700, color: "#e8a33d" }}>₹{item.price}</div>
              {(item.averageRating || item.reviewCount) && (
                <RatingBadge rating={item.averageRating} count={item.reviewCount} size="md" />
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: "#888" }}>×</button>
        </div>

        {mode === "view" && (
          <>
            <p style={{ fontSize: 14, color: "#555", lineHeight: 1.5, marginTop: 12, marginBottom: 14 }}>{item.description || "No description available."}</p>
            <button onClick={() => setMode("customize")} className="tap-btn" style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#fff5e0", border: "1px solid #fde68a", color: "#92400e", fontSize: 12.5, fontWeight: 700, padding: "8px 14px", borderRadius: 100, cursor: "pointer", marginBottom: 20 }}>
              ✎ Customise this item
            </button>
            <button onClick={() => { onAdd(item.id, 1, null); onClose(); }} style={{ width: "100%", padding: 14, borderRadius: 14, border: "none", background: "#1a1a2e", color: "#fff", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>
              + Add to Cart
            </button>
          </>
        )}

        {mode === "customize" && (
          <div style={{ marginTop: 16, animation: "fadeIn 0.25s ease" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#6b6b7b", textTransform: "uppercase", marginBottom: 8 }}>Spice Level</div>
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
              <button onClick={() => { onAdd(item.id, 1, { notes, spiceLevel }); onClose(); }} style={{ flex: 2, padding: 14, borderRadius: 14, border: "none", background: "#e8a33d", color: "#1a1a2e", fontWeight: 700, cursor: "pointer" }}>
                {startMode === "customize" ? "Save Changes" : "Add Customised Item"}
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
// Recommendation banners — REDESIGNED: real photo cards, not text rows.
// ---------------------------------------------------------------------------

// "People also ordered" — exactly 2 items, each a full mini product card
// (photo, name, price, + button) so it's an attractive tap target, not a
// skinny scroll strip.
function PeopleAlsoOrderedBanner({ cart, menuItems, onAdd, compact }) {
  const cartItemIds = new Set(Object.values(cart).map((l) => l.itemId));
  const cartCategories = new Set();
  cartItemIds.forEach((id) => {
    const item = menuItems.find((m) => m.id === id);
    if (item) cartCategories.add(item.category);
  });

  const suggestions = menuItems
    .filter((m) => {
      if (cartItemIds.has(m.id)) return false;
      if (!m.available) return false;
      return cartCategories.has(m.category) || m.featured;
    })
    .slice(0, 2);

  if (suggestions.length === 0) return null;

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
                onClick={() => { playTone(680, 90, "triangle"); onAdd(item.id, 1); }}
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

// "Complete your meal" — one attractive photo card instead of a thin text row.
function CompleteMealBanner({ cart, menuItems, onAdd, compact }) {
  const cartItemIds = new Set(Object.values(cart).map((l) => l.itemId));
  const cartItems = menuItems.filter((m) => cartItemIds.has(m.id));

  let missingCategory = null;
  for (const item of cartItems) {
    const rule = MEAL_COMPLETION_RULES[item.category];
    if (rule) {
      const hasComplement = cartItems.some((m) => rule.needs.includes(m.category));
      if (!hasComplement) {
        missingCategory = rule.suggestCategory;
        break;
      }
    }
  }

  if (!missingCategory) return null;

  const suggestion = menuItems.find((m) => m.category === missingCategory && m.available && !cartItemIds.has(m.id));
  if (!suggestion) return null;

  return (
    <div className="rec-banner" style={{ margin: compact ? "0 0 16px" : "0 20px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <span style={{ fontSize: 15 }}>🍽️</span>
        <span style={{ fontSize: 13, fontWeight: 800, color: "#166534" }}>Complete your meal</span>
      </div>
      <div style={{ background: "#fff", borderRadius: 14, overflow: "hidden", border: "1px solid #bbf7d0", boxShadow: "0 2px 10px rgba(0,0,0,0.05)", display: "flex", alignItems: "center", gap: 12, padding: 10 }}>
        <div style={{ width: 64, height: 64, borderRadius: 12, overflow: "hidden", flexShrink: 0, background: "#f0fdf4" }}>
          {suggestion.imageUrl ? (
            <img src={suggestion.imageUrl} alt={suggestion.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>🍽️</div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{suggestion.name}</div>
          <div style={{ fontSize: 11, color: "#888" }}>Pairs perfectly with your order</div>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#16a34a", marginTop: 2 }}>₹{suggestion.price}</div>
        </div>
        <button
          onClick={() => { playTone(680, 90, "triangle"); onAdd(suggestion.id, 1); }}
          className="tap-btn"
          style={{ padding: "8px 16px", borderRadius: 10, border: "none", background: "#16a34a", color: "#fff", fontWeight: 800, fontSize: 12.5, cursor: "pointer", flexShrink: 0 }}
        >
          + Add
        </button>
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
function TableContent() {
  const searchParams = useSearchParams();
  const tableParam = searchParams.get("table");
  const restaurantId = searchParams.get("restaurant");

  const [tableNo, setTableNo] = useState(tableParam ? parseInt(tableParam) : null);
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
  const [heroIndex, setHeroIndex] = useState(0);
  const [heroItems, setHeroItems] = useState([]);
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
  const [vegFilter, setVegFilter] = useState("all");
  const [promoBanner, setPromoBanner] = useState(null);
  const [googleReviewLink, setGoogleReviewLink] = useState("");
  const [spotlightMetric, setSpotlightMetric] = useState("mostLoved");
  const [bundleRules, setBundleRules] = useState([]); // Smart Deals — same collection reception manages
  const [exploreFilter, setExploreFilter] = useState("all");
  const [showExploreFilter, setShowExploreFilter] = useState(false);
  const [showWaiterModal, setShowWaiterModal] = useState(false);

  const heroScrollRef = useRef(null);
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
    const unsub = onSnapshot(doc(db, "restaurants", restaurantId, "info", "promoBanner"), (snap) => {
      if (snap.exists()) setPromoBanner(snap.data());
    });
    return () => unsub();
  }, [restaurantId]);

  useEffect(() => {
    if (!restaurantId) return;
    const unsub = onSnapshot(doc(db, "restaurants", restaurantId, "info", "settings"), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setGoogleReviewLink(data.googleReviewLink || "");
        setSpotlightMetric(data.spotlightMetric || "mostLoved");
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
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setMenuItems(items);
      const featured = items.filter((m) => m.available && m.imageUrl).slice(0, 5);
      setHeroItems(featured);
    });
    return () => unsub();
  }, [restaurantId]);

  useEffect(() => {
    if (!restaurantId) return;
    const q = query(collection(db, "restaurants", restaurantId, "tables"), orderBy("number", "asc"));
    const unsub = onSnapshot(q, (snap) => setTables(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    return () => unsub();
  }, [restaurantId]);

  useEffect(() => {
    if (!restaurantId) return;
    const q = query(collection(db, "restaurants", restaurantId, "categories"), orderBy("order", "asc"));
    const unsub = onSnapshot(q, (snap) => setCategoryDocs(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    return () => unsub();
  }, [restaurantId]);

  useEffect(() => {
    if (!tableNo || !restaurantId) return;
    const q = query(collection(db, "restaurants", restaurantId, "orders"), where("table", "==", tableNo));
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
    if (heroItems.length <= 1) return;
    const t = setInterval(() => {
      setHeroIndex((prev) => {
        const next = (prev + 1) % heroItems.length;
        const el = heroScrollRef.current;
        if (el) el.scrollTo({ left: next * el.clientWidth, behavior: "smooth" });
        return next;
      });
    }, 4000);
    return () => clearInterval(t);
  }, [heroItems.length]);

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

  function handleHeroScroll(e) {
    const el = e.currentTarget;
    if (!el.clientWidth) return;
    const idx = Math.round(el.scrollLeft / el.clientWidth);
    if (idx !== heroIndex) setHeroIndex(idx);
  }
  function scrollHeroTo(idx) {
    setHeroIndex(idx);
    const el = heroScrollRef.current;
    if (el) el.scrollTo({ left: idx * el.clientWidth, behavior: "smooth" });
  }

  const currentTableDoc = tables.find((t) => t.number === tableNo);
  const availableItemsRaw = menuItems.filter((m) => m.available);
  const availableItems = vegFilter === "all" ? availableItemsRaw : availableItemsRaw.filter((m) => m.foodType === vegFilter);

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

  // Which single item gets the big spotlight card, based on the receptionist's
  // chosen metric — falls back sensibly if nothing is flagged yet.
  const spotlightItem = useMemo(() => {
    const flagKey = spotlightMetric === "mostOrdered" ? "mostOrdered" : spotlightMetric === "mostRated" ? "mostRated" : "mostLoved";
    const flagged = availableItems.filter((m) => m[flagKey]);
    if (flagged.length > 0) {
      return [...flagged].sort((a, b) => (b.averageRating || 0) - (a.averageRating || 0))[0];
    }
    const featured = availableItems.find((m) => m.featured);
    if (featured) return featured;
    const rated = [...availableItems].filter((m) => m.averageRating).sort((a, b) => b.averageRating - a.averageRating);
    return rated[0] || null;
  }, [availableItems, spotlightMetric]);

  function findItem(id) { return menuItems.find((m) => m.id === id); }

  // Opens the detail modal for "view / add new" — always clears any pending
  // cart-line-edit state so a fresh menu-card tap never gets mistaken for an
  // in-progress cart customization.
  function openItemDetail(item) {
    setEditingLineId(null);
    setDetailItem(item);
  }

  // NEW: opens the same modal, but pre-loaded with a specific cart line's
  // current customization, and flagged so the Save button updates that line
  // instead of adding a duplicate.
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
  // line, update that line in place; otherwise fall through to the normal
  // add-to-cart behaviour.
  function handleDetailAdd(itemId, qty, customization) {
    if (editingLineId) {
      const lineId = editingLineId;
      setCart((prev) => {
        const line = prev[lineId];
        if (!line) return prev;
        return { ...prev, [lineId]: { ...line, notes: customization?.notes || "", spiceLevel: customization?.spiceLevel || null } };
      });
      setEditingLineId(null);
    } else {
      addToCart(itemId, qty, customization);
    }
  }

  function addToCart(itemId, qty, customization = null) {
    setCart((prev) => {
      if (!customization) {
        const plainId = `${itemId}-plain`;
        const existing = prev[plainId];
        return { ...prev, [plainId]: { itemId, qty: (existing?.qty || 0) + qty, notes: "", spiceLevel: null } };
      }
      const lineId = `${itemId}-${Date.now()}`;
      return { ...prev, [lineId]: { itemId, qty, notes: customization.notes || "", spiceLevel: customization.spiceLevel || null } };
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
      return { name: item.name, qty: line.qty, price: item.price, notes: line.notes || "", spiceLevel: line.spiceLevel || null };
    });
    if (items.length === 0) return;

    // Note: no free-item injection here. Threshold/bundle deals are computed
    // once, at bill time, by reception's Smart Deals engine (bundleRules) —
    // that's the single source of truth. The ThresholdBanner below is just an
    // accurate preview of what the diner will see deducted from the bill.
    await addDoc(collection(db, "restaurants", restaurantId, "orders"), {
      table: tableNo,
      items,
      status: "pending",
      orderType,
      isVIP: !!currentTableDoc?.isVIP,
      etaMinutes: null,
      preparingAt: null,
      createdAt: Date.now(),
    });

    setCart({});
    setOrderType("dinein");
    setShowCartSummary(false);
    setAddingMore(false);
    setScreen("menu");
    const placedMsg = orderType === "takeaway" ? "Order placed for pickup!" : "Order placed!";
    triggerSuccessOverlay(activeOrders.length > 0 ? "Added to your order!" : placedMsg);
  }

  async function requestBill() {
    const servedOrders = activeOrders.filter((o) => o.status === "served");
    if (servedOrders.length === 0) return;

    const mergedMap = {};
    servedOrders.forEach((o) => {
      o.items.forEach((it) => {
        const key = it.name + "|" + (it.notes || "") + "|" + (it.spiceLevel || "");
        if (mergedMap[key]) mergedMap[key].qty += it.qty;
        else mergedMap[key] = { ...it };
      });
    });
    const mergedItems = Object.values(mergedMap);

    await addDoc(collection(db, "restaurants", restaurantId, "orders"), {
      table: tableNo, items: mergedItems, status: "bill_requested", etaMinutes: null, preparingAt: null, createdAt: Date.now(),
    });

    const batch = writeBatch(db);
    servedOrders.forEach((o) => batch.update(doc(db, "restaurants", restaurantId, "orders", o.id), { status: "merged" }));
    await batch.commit();

    playTone(700, 90, "triangle");
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
  const total = Object.values(cart).reduce((sum, l) => {
    const item = findItem(l.itemId);
    return sum + (item ? item.price * l.qty : 0);
  }, 0);

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
        {count > 0 ? `View Cart · ₹${total}` : "Back to Order Status"}
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

        <div style={{ display: "flex", gap: 8, background: "#f8f6f3", borderRadius: 12, padding: 4, marginBottom: 18 }}>
          {[["dinein", "🍽️ Dine-in"], ["takeaway", "📦 Takeaway"]].map(([val, label]) => (
            <button key={val} onClick={() => setOrderType(val)} className="tap-btn"
              style={{ flex: 1, padding: "10px", borderRadius: 9, border: "none", cursor: "pointer", fontWeight: 700, fontSize: 13,
                background: orderType === val ? "#1a1a2e" : "transparent", color: orderType === val ? "#fff" : "#888" }}>
              {label}
            </button>
          ))}
        </div>

        {Object.entries(cart).map(([lineId, line]) => {
          const item = findItem(line.itemId);
          if (!item) return null;
          return (
            <div key={lineId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid #f0f0f0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {item.imageUrl && (<img src={item.imageUrl} alt="" style={{ width: 48, height: 48, borderRadius: 10, objectFit: "cover" }} />)}
                <div>
                  <div style={{ fontWeight: 600 }}>{item.name}</div>
                  <div style={{ fontSize: 13, color: "#888" }}>₹{item.price} × {line.qty}</div>
                  {line.spiceLevel && <div style={{ fontSize: 11, color: "#e8a33d", marginTop: 2 }}>🌶 {line.spiceLevel}</div>}
                  {line.notes && <div style={{ fontSize: 11, color: "#888", fontStyle: "italic", marginTop: 2 }}>"{line.notes}"</div>}
                  <button
                    onClick={() => openLineCustomize(lineId)}
                    className="tap-btn"
                    style={{ background: "none", border: "none", color: "#e8a33d", fontSize: 11, fontWeight: 700, textDecoration: "underline", cursor: "pointer", padding: 0, marginTop: 4, display: "block" }}
                  >
                    ✎ Customise this item
                  </button>
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
            <ThresholdBanner cartTotal={total} activeOffer={thresholdBannerOffer} compact />
            <CompleteMealBanner cart={cart} menuItems={menuItems} onAdd={addToCart} compact />
            <PeopleAlsoOrderedBanner cart={cart} menuItems={menuItems} onAdd={addToCart} compact />
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20, paddingTop: 16, borderTop: "2px solid #1a1a2e", fontSize: 18, fontWeight: 800 }}>
          <span>Total</span><span>₹{total}</span>
        </div>
        <button onClick={submitCart} className="tap-btn" style={{ width: "100%", marginTop: 20, padding: 16, borderRadius: 14, border: "none", background: "#e8a33d", color: "#1a1a2e", fontSize: 16, fontWeight: 700, cursor: "pointer" }}>
          {activeOrders.length > 0 ? "Add to Order" : (orderType === "takeaway" ? "Place Takeaway Order" : "Place Order")}
        </button>
      </div>
    </div>
  ) : null;

  // ---------- Invalid QR guard ----------
  if (!restaurantId) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "#faf8f5" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: "#1a1a2e" }}>Invalid QR Code</h2>
          <p style={{ color: "#6b6b7b", marginTop: 8 }}>Please scan a valid table QR code.</p>
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
  if (!tableNo) {
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
            <div><div style={{ fontWeight: 700, fontSize: 18 }}>{profile?.name || "Table Order"}</div><div style={{ fontSize: 13, color: "#888" }}>Table {tableNo}</div></div>
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
                  <div style={{ fontSize: 20, fontWeight: 800, marginTop: 4 }}>{profile?.name || "Table Order"}</div>
                  <div style={{ fontSize: 12, color: "#888" }}>Table {tableNo}</div>
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
    const allServed = activeOrders.every((o) => o.status === "served");
    const dominantCountdown = getCountdown(dominantOrder);

    return (
      <div style={{ minHeight: "100vh", background: "#f8f6f3", padding: 24, fontFamily: "sans-serif", paddingBottom: 100 }}>
        {statusToast && <StatusToast emoji={statusToast.emoji} msg={statusToast.msg} />}
        {successOverlay && <SuccessOverlay message={successOverlay} />}
        {ratingOrder && <RatingPopup order={ratingOrder} restaurantId={restaurantId} onDone={() => setRatingOrder(null)} googleReviewLink={googleReviewLink} />}
        <div style={{ maxWidth: 480, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
            {profile?.logoUrl && (<img src={profile.logoUrl} alt="logo" style={{ width: 44, height: 44, borderRadius: "50%", objectFit: "cover" }} />)}
            <div><div style={{ fontWeight: 700, fontSize: 18 }}>{profile?.name || "Table Order"}</div><div style={{ fontSize: 13, color: "#888" }}>Table {tableNo}</div></div>
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
            {allServed && (
              <button onClick={() => { playTone(700, 90, "triangle"); requestBill(); }} className="tap-btn" style={{ width: "100%", padding: 16, fontSize: 16, fontWeight: 700, borderRadius: 14, border: "none", background: "#e8a33d", color: "#1a1a2e", cursor: "pointer" }}>
                🧾 Request Bill
              </button>
            )}
          </div>
        </div>

        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#fff", borderTop: "1px solid #eee", padding: "12px 20px", zIndex: 50 }}>
          <button onClick={() => { playTone(560, 70); setAddingMore(true); }} className="tap-btn" style={{ width: "100%", maxWidth: 480, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: 14, borderRadius: 50, border: "none", background: "#1a1a2e", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,0.15)" }}>
            <span>🛒</span>{count > 0 ? `${count} items · ₹${total}` : "Browse Menu"}
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
        />
      )}
      {ratingOrder && <RatingPopup order={ratingOrder} restaurantId={restaurantId} onDone={() => setRatingOrder(null)} googleReviewLink={googleReviewLink} />}
      {showWaiterModal && <WaiterModal onClose={() => setShowWaiterModal(false)} onSend={callWaiter} />}

      {/* ===== HEADER: Call Waiter (top-left) · Logo/name · Table pill (top-right) ===== */}
      <div style={{ background: "linear-gradient(135deg, #fff5e0 0%, #fef3c7 100%)", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: 480, margin: "0 auto", padding: "16px 20px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, flexShrink: 0 }}>
                <button onClick={() => { playTone(500, 60); setShowWaiterModal(true); }} className="tap-btn" aria-label="Call Waiter"
                  style={{ width: 38, height: 38, borderRadius: "50%", border: "none", background: "#1a1a2e", color: "#fff", fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 8px rgba(26,26,46,0.25)" }}>
                  🛎️
                </button>
                <span style={{ fontSize: 8.5, fontWeight: 700, color: "#a08a5c", whiteSpace: "nowrap", letterSpacing: 0.2 }}>Call Staff</span>
              </div>
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
                  <div style={{ fontSize: 11, color: "#a08a5c", fontWeight: 600 }}>📍 Table {tableNo}</div>
                )}
              </div>
            </div>

            <span style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.7)", padding: "6px 12px", borderRadius: 100, fontSize: 12.5, fontWeight: 700, color: "#1a1a2e", flexShrink: 0 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#dc2626", flexShrink: 0 }} />
              Table {tableNo}
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
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, background: "rgba(255,255,255,0.65)", borderRadius: 100, padding: "5px 10px 5px 12px" }}>
              <span style={{ fontSize: 13 }}>🌿</span>
              <div style={{ display: "flex", gap: 3 }}>
                {["all", "veg", "nonveg"].map((f) => (
                  <button key={f} onClick={() => { playTone(500, 50); setVegFilter(f); }}
                    style={{ padding: "5px 9px", borderRadius: 100, border: "none", cursor: "pointer", fontSize: 10.5, fontWeight: 800,
                      background: vegFilter === f ? (f === "veg" ? "#16a34a" : f === "nonveg" ? "#dc2626" : "#1a1a2e") : "transparent",
                      color: vegFilter === f ? "#fff" : "#888" }}>
                    {f === "all" ? "All" : f === "veg" ? "Veg" : "Non-veg"}
                  </button>
                ))}
              </div>
            </div>
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
            {/* ===== HERO BANNER: Image ONLY ===== */}
            {heroItems.length > 0 && !addingMore && (
              <div style={{ padding: "16px 20px 0" }}>
                <div ref={heroScrollRef} onScroll={handleHeroScroll} className="hscroll" style={{ display: "flex", overflowX: "auto", scrollSnapType: "x mandatory", borderRadius: 20, WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}>
                  {heroItems.map((item) => (
                    <div key={item.id} style={{ flex: "0 0 100%", scrollSnapAlign: "start", position: "relative", aspectRatio: "16 / 9", background: "#1a1a2e", overflow: "hidden" }}>
                      <img src={item.imageUrl} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    </div>
                  ))}
                </div>
                {heroItems.length > 1 && (
                  <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 10 }}>
                    {heroItems.map((_, idx) => (<div key={idx} onClick={() => scrollHeroTo(idx)} style={{ width: 8, height: 8, borderRadius: "50%", background: idx === heroIndex ? "#e8a33d" : "#ddd", cursor: "pointer" }} />))}
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

            {/* ===== SPOTLIGHT CARD: Most Loved / Most Ordered / Most Rated ===== */}
            <div style={{ marginTop: 18 }}>
              <SpotlightCard item={spotlightItem} metric={spotlightMetric} onAdd={addToCart} />
            </div>

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

            {/* ===== PROMO BANNER (below Popular Picks, image only) ===== */}
            {promoBanner?.imageUrl && !addingMore && (
              <div style={{ padding: "0 20px 24px" }}>
                <div
                  onClick={() => {
                    if (promoBanner.linkedItemId) { addToCart(promoBanner.linkedItemId, 1); setShowCartSummary(true); }
                  }}
                  style={{ position: "relative", borderRadius: 20, overflow: "hidden", cursor: promoBanner.linkedItemId ? "pointer" : "default" }}
                >
                  <img src={promoBanner.imageUrl} alt="Special" style={{ width: "100%", height: "auto", display: "block", borderRadius: 20 }} />
                </div>
              </div>
            )}

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