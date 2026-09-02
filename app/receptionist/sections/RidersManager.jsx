"use client";

// The outlet's saved list of riders.
//
// Before this, handing an order to a rider meant reception typed a name and a
// phone number in, every single time, for the same two or three people who
// actually do the outlet's deliveries. This is that list — added once here,
// then picked from a dropdown at dispatch (see the "Hand to a rider" modal in
// app/receptionist/page.js).
//
// Deactivating a rider (rather than deleting them) is the default way to
// retire one: it drops them from the dispatch picker without touching past
// orders, which already carry a COPY of the rider's name and phone from the
// moment they were dispatched, not a reference to this list.

import { useState } from "react";
import { db } from "@/lib/firebase";
import { collection, addDoc, updateDoc, deleteDoc, doc } from "firebase/firestore";
import { validateRiderProfile } from "@/lib/riders";
import { labelStyle, inputStyle } from "./ui";

export default function RidersManager({ outletId, riders }) {
  const [form, setForm] = useState({ name: "", phone: "" });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [listError, setListError] = useState("");

  async function addRider() {
    const problems = validateRiderProfile(form);
    if (Object.keys(problems).length > 0) { setErrors(problems); return; }
    setSaving(true);
    setListError("");
    try {
      await addDoc(collection(db, "restaurants", outletId, "riders"), {
        name: form.name.trim(),
        phone: form.phone.trim(),
        active: true,
        createdAt: Date.now(),
      });
      setForm({ name: "", phone: "" });
      setErrors({});
    } catch (e) {
      setListError(e?.code === "permission-denied"
        ? "You do not have permission to manage riders for this outlet."
        : e.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(rider) {
    try {
      await updateDoc(doc(db, "restaurants", outletId, "riders", rider.id), { active: rider.active === false });
    } catch (e) {
      setListError(e.message);
    }
  }

  async function removeRider(rider) {
    if (!confirm(`Remove ${rider.name} from the rider list? Past deliveries keep their record either way.`)) return;
    try {
      await deleteDoc(doc(db, "restaurants", outletId, "riders", rider.id));
    } catch (e) {
      setListError(e.message);
    }
  }

  return (
    <div className="card" style={{ padding: 20, borderRadius: 16, marginBottom: 16 }}>
      <h3 style={{ fontSize: 15, fontWeight: 800, margin: "0 0 4px" }}>Riders</h3>
      <p style={{ fontSize: 12.5, color: "var(--text-secondary, #6b6b7b)", margin: "0 0 14px" }}>
        Add the people who deliver for you here, once. Handing an order to a rider then means picking a
        name, not typing one in.
      </p>

      {riders.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {riders.map((r) => (
            <div key={r.id} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 0",
              borderTop: "1px solid var(--border, #f0ebe3)", opacity: r.active === false ? 0.5 : 1,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#1a1a2e" }}>{r.name}</div>
                <div style={{ fontSize: 12.5, color: "#888" }}>{r.phone}</div>
              </div>
              <button onClick={() => toggleActive(r)}
                style={{
                  padding: "5px 12px", borderRadius: 100, fontSize: 11.5, fontWeight: 800, cursor: "pointer",
                  fontFamily: "inherit", border: "none",
                  background: r.active === false ? "#f3efe6" : "#dcfce7",
                  color: r.active === false ? "#888" : "#166534",
                }}>
                {r.active === false ? "OFF DUTY" : "AVAILABLE"}
              </button>
              <button onClick={() => removeRider(r)} className="btn btn-ghost btn-sm" title="Remove">🗑</button>
            </div>
          ))}
        </div>
      )}

      <label style={labelStyle}>Add a rider</label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 160px" }}>
          <input placeholder="Name" value={form.name}
            onChange={(e) => { setForm((p) => ({ ...p, name: e.target.value })); setErrors((p) => ({ ...p, name: undefined })); }}
            style={{ ...inputStyle, marginBottom: 4, borderColor: errors.name ? "#dc2626" : undefined }} />
          {errors.name && <div style={{ color: "#dc2626", fontSize: 12 }}>{errors.name}</div>}
        </div>
        <div style={{ flex: "1 1 160px" }}>
          <input placeholder="Phone" value={form.phone}
            onChange={(e) => { setForm((p) => ({ ...p, phone: e.target.value })); setErrors((p) => ({ ...p, phone: undefined })); }}
            style={{ ...inputStyle, marginBottom: 4, borderColor: errors.phone ? "#dc2626" : undefined }} />
          {errors.phone && <div style={{ color: "#dc2626", fontSize: 12 }}>{errors.phone}</div>}
        </div>
        <button className="btn btn-primary" disabled={saving} onClick={addRider} style={{ marginTop: 0 }}>
          {saving ? "Adding…" : "+ Add"}
        </button>
      </div>

      {listError && <div style={{ color: "#b91c1c", fontSize: 12.5, marginTop: 10 }}>{listError}</div>}
    </div>
  );
}
