// components/VariationsAddonsEditor.jsx
//
// Size Variations & Add-ons editor — shared between the outlet POS's "Add New
// Item" / inline item-edit form and the brand console's master-menu "Add
// item" / edit form. Lets a dish collapse duplicate rows (e.g. "Pizza
// Regular" / "Pizza Medium" / "Pizza Large") into ONE item with size
// options, plus optional extra add-ons (toppings, extra cheese, etc.) that
// customers can tick when adding it to their cart.
//
// Previously this lived only in app/receptionist/page.js. The brand console
// had no equivalent — a master-menu item imported with variations (bulk
// import writes them fine) had nowhere to be seen or hand-edited, and there
// was no way to add them to a new item by hand at all.

export function addRow(setFn, key) {
  setFn((p) => ({ ...p, [key]: [...(p[key] || []), { id: `${key.slice(0, 3)}${Date.now()}${Math.random().toString(36).slice(2, 6)}`, name: "", price: "" }] }));
}
export function updateRow(setFn, key, id, field, value) {
  setFn((p) => ({ ...p, [key]: (p[key] || []).map((r) => (r.id === id ? { ...r, [field]: value } : r)) }));
}
export function removeRow(setFn, key, id) {
  setFn((p) => ({ ...p, [key]: (p[key] || []).filter((r) => r.id !== id) }));
}
export function cleanRows(list) {
  return (list || []).filter((r) => r.name?.trim() && r.price !== "").map((r) => ({ id: r.id, name: r.name.trim(), price: parseFloat(r.price) || 0 }));
}

const defaultInputStyle = { width: "100%", padding: "11px 14px", border: "1px solid var(--border, #e6e1d6)", borderRadius: 10, fontSize: 14, marginBottom: 12, background: "var(--surface, #ffffff)", fontFamily: "inherit", boxSizing: "border-box" };
const defaultLabelStyle = { fontSize: 12, color: "var(--text-secondary, #6b6b7b)", fontWeight: 700, display: "block", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 };

/**
 * `form`/`setForm` hold `variations`/`addons` arrays of {id, name, price}
 * (as strings while being typed — cleanRows() above is what a caller runs on
 * submit to drop blank rows and coerce price to a number).
 *
 * `inputStyle`/`labelStyle` are optional — each host page has its own, close
 * but not identical; omit them to get a reasonable default.
 */
export default function VariationsAddonsEditor({ form, setForm, inputStyle = defaultInputStyle, labelStyle = defaultLabelStyle }) {
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
