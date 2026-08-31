// lib/menu-import.js
//
// Parsing menu data out of CSV or JSON. Pure functions over text — no Firestore,
// no React — so both the outlet importer in the POS and the master-menu importer
// in the brand console can share one implementation instead of drifting apart.

// Splits one CSV line, honouring quoted fields that contain commas and escaped
// double-quotes. A naive split(",") mangles any description with a comma in it,
// which in a restaurant menu is most of them.
export function parseCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }  // "" is a literal quote
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export function parseCSV(text) {
  const lines = (text || "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, j) => { row[h] = values[j] ?? ""; });
    rows.push(row);
  }
  return rows;
}

// Accepts several spellings of each column so a restaurant's own export does not
// have to match ours exactly. Falls back sensibly rather than rejecting a row.
function pick(row, ...keys) {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== "") return String(row[k]).trim();
  }
  return "";
}

function truthy(v) {
  return ["true", "yes", "y", "1"].includes(String(v || "").trim().toLowerCase());
}

/**
 * Turn parsed rows into menu items, reporting what could not be used.
 *
 * Rows without a name or a usable price are skipped rather than imported as
 * broken records — a menu item priced NaN corrupts every bill it lands on.
 */
export function normalizeMenuRows(rows) {
  const items = [];
  const skipped = [];

  (rows || []).forEach((row, i) => {
    const name = pick(row, "name", "item", "itemname", "item name", "dish");
    const priceRaw = pick(row, "price", "amount", "rate", "cost");
    const price = parseFloat(String(priceRaw).replace(/[^0-9.]/g, ""));

    if (!name) { skipped.push({ line: i + 2, reason: "no name" }); return; }
    if (!priceRaw || isNaN(price)) { skipped.push({ line: i + 2, name, reason: "no usable price" }); return; }

    const foodTypeRaw = pick(row, "foodtype", "food type", "type", "veg").toLowerCase();
    const foodType = foodTypeRaw.startsWith("non") ? "nonveg" : "veg";

    items.push({
      name,
      price,
      category: pick(row, "category", "section", "group") || "Mains",
      description: pick(row, "description", "desc", "details"),
      foodType,
      imageUrl: pick(row, "imageurl", "image url", "image", "photo"),
      chefSpecial: truthy(pick(row, "chefspecial", "chef special")),
      featured: truthy(pick(row, "featured")),
      etaMinutes: parseInt(pick(row, "etaminutes", "eta", "prep time")) || 15,
    });
  });

  return { items, skipped };
}

/**
 * Parse pasted or uploaded text in either format.
 * Returns { items, skipped, error } — never throws, so a malformed paste shows
 * a message instead of a stack trace.
 */
export function parseMenuText(text, format = "csv") {
  try {
    let rows;
    if (format === "json") {
      const parsed = JSON.parse(text);
      rows = Array.isArray(parsed) ? parsed : parsed.items;
      if (!Array.isArray(rows)) return { items: [], skipped: [], error: "JSON must be an array of items, or an object with an `items` array." };
      // Normalize keys to lowercase so the CSV column aliases work here too.
      rows = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])));
    } else {
      rows = parseCSV(text);
      if (rows.length === 0) return { items: [], skipped: [], error: "No rows found. The first line must be a header row." };
    }
    const { items, skipped } = normalizeMenuRows(rows);
    if (items.length === 0) {
      return { items: [], skipped, error: "Nothing importable was found. Check that you have Name and Price columns." };
    }
    return { items, skipped, error: null };
  } catch (e) {
    return { items: [], skipped: [], error: `Could not read that ${format.toUpperCase()}: ${e.message}` };
  }
}

export const MENU_CSV_TEMPLATE =
  "Name,Price,Category,Description,FoodType,ChefSpecial,Featured,ImageUrl\n" +
  "Paneer Tikka,280,Starters,Char-grilled cottage cheese,veg,true,false,\n" +
  "Butter Chicken,420,Mains,Slow-cooked in tomato and cream,nonveg,false,true,\n" +
  "Butter Naan,60,Breads & Rice,,veg,false,false,\n";
