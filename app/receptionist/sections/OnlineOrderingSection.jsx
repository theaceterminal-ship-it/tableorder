"use client";

// Setting up the restaurant's public ordering page — the link that goes on a
// Google profile, Instagram bio, or a printed flyer.
//
// Everything configured here is also enforced in security rules. What this
// screen provides is the courtesy: telling a customer the kitchen is closed
// before they build a basket, rather than after.

import { useEffect, useState } from "react";
import { db } from "@/lib/firebase";
import { doc, setDoc } from "firebase/firestore";
import {
  DEFAULT_WEBSITE, DEFAULT_HOURS, DAY_KEYS, DAY_LABELS,
  slugify, validateSlug, publicOrderUrl, isOpenAt, todayHoursLabel,
} from "@/lib/website-setup";
import { SectionHeader, labelStyle, inputStyle } from "./ui";

function Toggle({ on, onChange, title, hint }) {
  return (
    <button
      onClick={() => onChange(!on)}
      style={{
        display: "flex", alignItems: "center", gap: 14, width: "100%", textAlign: "left",
        padding: 16, borderRadius: 14, cursor: "pointer", fontFamily: "inherit", marginBottom: 10,
        border: on ? "2px solid #16a34a" : "1.5px solid var(--border, #e6e1d6)",
        background: on ? "#f0fdf4" : "var(--surface, #fff)",
      }}
    >
      <div style={{
        width: 42, height: 24, borderRadius: 100, flexShrink: 0, position: "relative",
        background: on ? "#16a34a" : "#d6d0c4", transition: "background 0.2s",
      }}>
        <div style={{
          position: "absolute", top: 3, left: on ? 21 : 3, width: 18, height: 18,
          borderRadius: "50%", background: "#fff", transition: "left 0.2s",
        }} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 700, color: "#1a1a2e" }}>{title}</div>
        {hint && <div style={{ fontSize: 12.5, color: "var(--text-secondary, #6b6b7b)", marginTop: 2 }}>{hint}</div>}
      </div>
    </button>
  );
}

export default function OnlineOrderingSection({ outletId, restaurantName, settings }) {
  const [form, setForm] = useState(DEFAULT_WEBSITE);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setForm({
      ...DEFAULT_WEBSITE,
      ...(settings?.website || {}),
      hours: { ...DEFAULT_HOURS, ...(settings?.website?.hours || {}) },
      // Mirrored to the top level because the security rule reads it there —
      // rules cannot reach into a nested map as cheaply.
      deliveryEnabled: settings?.deliveryEnabled ?? settings?.website?.deliveryEnabled ?? false,
    });
  }, [settings]);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const url = publicOrderUrl(origin, { slug: form.slug, outletId });
  const slugError = form.slug ? validateSlug(form.slug) : null;
  const openNow = isOpenAt(form.hours);

  const set = (patch) => setForm((p) => ({ ...p, ...patch }));
  const setDay = (day, patch) =>
    setForm((p) => ({ ...p, hours: { ...p.hours, [day]: { ...p.hours[day], ...patch } } }));

  async function save() {
    if (form.enabled && slugError) { setError(slugError); return; }
    setSaving(true);
    setError("");
    try {
      await setDoc(doc(db, "restaurants", outletId, "info", "settings"), {
        website: { ...form },
        // Duplicated at the top level for the security rule. Keeping both in one
        // write means they cannot disagree.
        deliveryEnabled: !!(form.enabled && form.deliveryEnabled),
      }, { merge: true });
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } catch (e) {
      setError(e?.code === "permission-denied"
        ? "You do not have permission to change this outlet's settings."
        : e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeader
        title="Online Ordering"
        subtitle="Your own ordering page — put this link on your Google profile, Instagram, or a flyer."
      />

      {/* The link, first: it is the thing this screen exists to produce. */}
      <div className="card" style={{ padding: 20, borderRadius: 16, marginBottom: 16, border: form.enabled ? "2px solid #16a34a" : "1.5px solid var(--border, #e6e1d6)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: "#1a1a2e" }}>Your ordering link</span>
          <span style={{
            fontSize: 10.5, fontWeight: 800, padding: "3px 9px", borderRadius: 100,
            background: form.enabled ? "#dcfce7" : "#f3f0e8",
            color: form.enabled ? "#166534" : "#888",
          }}>
            {form.enabled ? (openNow ? "LIVE · OPEN NOW" : "LIVE · CLOSED RIGHT NOW") : "NOT PUBLISHED"}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <code style={{
            flex: 1, minWidth: 220, padding: "11px 13px", borderRadius: 10, fontSize: 13,
            background: "var(--surface-2, #f3efe6)", color: "#1a1a2e", wordBreak: "break-all",
          }}>{url}</code>
          <button className="btn btn-primary" onClick={() => {
            navigator.clipboard?.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          }}>
            {copied ? "✓ Copied" : "Copy link"}
          </button>
          <a className="btn btn-ghost" href={url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
            Preview ↗
          </a>
        </div>

        {!form.enabled && (
          <p style={{ fontSize: 12.5, color: "var(--text-secondary, #6b6b7b)", margin: "12px 0 0" }}>
            The link works as soon as you switch online ordering on below. Until then anyone opening it
            is told you are not taking online orders yet.
          </p>
        )}
      </div>

      {/* What is on offer */}
      <div className="card" style={{ padding: 20, borderRadius: 16, marginBottom: 16 }}>
        <Toggle
          on={form.enabled}
          onChange={(v) => set({ enabled: v })}
          title="Online ordering"
          hint="The master switch. Off means the page politely says you are not taking orders."
        />
        <Toggle
          on={form.deliveryEnabled}
          onChange={(v) => set({ deliveryEnabled: v })}
          title="Delivery"
          hint="Customers enter an address at checkout. Orders arrive marked as delivery, not takeaway."
        />
        <Toggle
          on={form.pickupEnabled}
          onChange={(v) => set({ pickupEnabled: v })}
          title="Pickup"
          hint="Customers order ahead and collect at the counter."
        />
      </div>

      {/* Address on the web */}
      <div className="card" style={{ padding: 20, borderRadius: 16, marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 800, margin: "0 0 4px" }}>Your web address</h3>
        <p style={{ fontSize: 12.5, color: "var(--text-secondary, #6b6b7b)", margin: "0 0 14px" }}>
          A short name is easier to read out over the phone and looks better on a flyer.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={labelStyle}>Web address</label>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 13, color: "#888" }}>/r/</span>
              <input
                value={form.slug}
                placeholder={slugify(restaurantName) || "spice-garden"}
                onChange={(e) => set({ slug: slugify(e.target.value) })}
                style={{ ...inputStyle, marginBottom: 0, borderColor: slugError ? "#dc2626" : undefined }}
              />
            </div>
            {slugError && <div style={{ color: "#dc2626", fontSize: 12, marginTop: 5 }}>{slugError}</div>}
          </div>
          {!form.slug && restaurantName && (
            <button className="btn btn-ghost" style={{ marginTop: 22 }}
              onClick={() => set({ slug: slugify(restaurantName) })}>
              Use “{slugify(restaurantName)}”
            </button>
          )}
        </div>
      </div>

      {/* Delivery economics */}
      {form.deliveryEnabled && (
        <div className="card" style={{ padding: 20, borderRadius: 16, marginBottom: 16 }}>
          <h3 style={{ fontSize: 15, fontWeight: 800, margin: "0 0 4px" }}>Delivery charges</h3>
          <p style={{ fontSize: 12.5, color: "var(--text-secondary, #6b6b7b)", margin: "0 0 14px" }}>
            Customers see these while building their basket — “add ₹80 more for free delivery” — rather
            than meeting them at checkout.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            {[
              { key: "deliveryFee", label: "Delivery fee (₹)", hint: "0 for always free" },
              { key: "freeDeliveryAbove", label: "Free delivery above (₹)", hint: "0 to never waive it" },
              { key: "minimumOrder", label: "Minimum order (₹)", hint: "0 for no minimum" },
              { key: "deliveryEtaMinutes", label: "Typical delivery time (min)", hint: "Shown to the customer" },
              { key: "deliveryRadiusKm", label: "Delivery radius (km)", hint: "Shown as guidance" },
            ].map((f) => (
              <div key={f.key}>
                <label style={labelStyle}>{f.label}</label>
                <input type="number" min={0} value={form[f.key]}
                  onChange={(e) => set({ [f.key]: parseInt(e.target.value) || 0 })}
                  style={{ ...inputStyle, marginBottom: 4 }} />
                <div style={{ fontSize: 11.5, color: "#999" }}>{f.hint}</div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 16 }}>
            <label style={labelStyle}>Payment accepted on delivery</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[{ key: "acceptsCod", label: "💵 Cash" }, { key: "acceptsUpi", label: "📱 UPI" }].map((o) => (
                <button key={o.key} onClick={() => set({ [o.key]: !form[o.key] })}
                  style={{
                    padding: "9px 16px", borderRadius: 100, fontSize: 13, fontWeight: 700, cursor: "pointer",
                    fontFamily: "inherit",
                    border: form[o.key] ? "2px solid #1a1a2e" : "1.5px solid var(--border, #e6e1d6)",
                    background: form[o.key] ? "#1a1a2e" : "transparent",
                    color: form[o.key] ? "#fff" : "#1a1a2e",
                  }}>
                  {o.label}
                </button>
              ))}
            </div>
            {!form.acceptsCod && !form.acceptsUpi && (
              <div style={{ color: "#b45309", fontSize: 12.5, marginTop: 8 }}>
                With neither selected, a customer has no way to pay — turn at least one on.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Hours */}
      <div className="card" style={{ padding: 20, borderRadius: 16, marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 800, margin: "0 0 4px" }}>Opening hours</h3>
        <p style={{ fontSize: 12.5, color: "var(--text-secondary, #6b6b7b)", margin: "0 0 14px" }}>
          Orders are refused outside these hours. {todayHoursLabel(form.hours)} — currently{" "}
          <strong style={{ color: openNow ? "#166534" : "#b91c1c" }}>{openNow ? "open" : "closed"}</strong>.
          A closing time earlier than the opening time means you run past midnight.
        </p>
        {DAY_KEYS.map((d) => {
          const cfg = form.hours[d] || {};
          return (
            <div key={d} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid var(--border, #f0ebe3)", flexWrap: "wrap" }}>
              <span style={{ width: 92, fontSize: 13.5, fontWeight: 700, color: "#1a1a2e" }}>{DAY_LABELS[d]}</span>
              <button onClick={() => setDay(d, { closed: !cfg.closed })}
                style={{
                  padding: "5px 12px", borderRadius: 100, fontSize: 11.5, fontWeight: 800, cursor: "pointer",
                  fontFamily: "inherit", border: "none",
                  background: cfg.closed ? "#fee2e2" : "#dcfce7",
                  color: cfg.closed ? "#b91c1c" : "#166534",
                }}>
                {cfg.closed ? "CLOSED" : "OPEN"}
              </button>
              {!cfg.closed && (
                <>
                  <input type="time" value={cfg.open || "11:00"} onChange={(e) => setDay(d, { open: e.target.value })}
                    style={{ ...inputStyle, marginBottom: 0, width: 120 }} />
                  <span style={{ color: "#888" }}>–</span>
                  <input type="time" value={cfg.close || "23:00"} onChange={(e) => setDay(d, { close: e.target.value })}
                    style={{ ...inputStyle, marginBottom: 0, width: 120 }} />
                </>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", padding: 14, borderRadius: 12, fontSize: 13.5, marginBottom: 14 }}>
          {error}
        </div>
      )}

      <button className="btn btn-primary" onClick={save} disabled={saving} style={{ minWidth: 190 }}>
        {saving ? "Saving…" : saved ? "✓ Saved" : "Save online ordering"}
      </button>
    </div>
  );
}
