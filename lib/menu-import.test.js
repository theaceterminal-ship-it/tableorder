import { describe, it, expect } from "vitest";
import {
  parseCSVLine, parseCSV, normalizeMenuRows, parseMenuText,
  parseImportRows, matchImageFile,
} from "./menu-import";

describe("parseCSVLine", () => {
  it("splits a plain line", () => {
    expect(parseCSVLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("keeps commas inside quoted fields", () => {
    // The case a naive split(",") gets wrong, and most menu descriptions hit it.
    expect(parseCSVLine('Paneer,"Rich, creamy, spiced",280'))
      .toEqual(["Paneer", "Rich, creamy, spiced", "280"]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCSVLine('a,"He said ""hi""",c')).toEqual(["a", 'He said "hi"', "c"]);
  });

  it("preserves empty trailing fields", () => {
    expect(parseCSVLine("a,,")).toEqual(["a", "", ""]);
  });
});

describe("parseCSV", () => {
  it("maps rows onto lowercased headers", () => {
    const rows = parseCSV("Name,Price\nPaneer Tikka,280");
    expect(rows).toEqual([{ name: "Paneer Tikka", price: "280" }]);
  });

  it("returns nothing for a header-only file", () => {
    expect(parseCSV("Name,Price")).toEqual([]);
    expect(parseCSV("")).toEqual([]);
  });

  it("ignores blank lines", () => {
    expect(parseCSV("Name,Price\n\nPaneer,280\n\n")).toHaveLength(1);
  });
});

describe("normalizeMenuRows", () => {
  it("accepts alternative column names", () => {
    const { items } = normalizeMenuRows([{ item: "Dal Makhani", rate: "320", section: "Mains" }]);
    expect(items[0]).toMatchObject({ name: "Dal Makhani", price: 320, category: "Mains" });
  });

  it("strips currency symbols from the price", () => {
    const { items } = normalizeMenuRows([{ name: "Naan", price: "₹60" }]);
    expect(items[0].price).toBe(60);
  });

  it("defaults a missing category rather than failing the row", () => {
    const { items } = normalizeMenuRows([{ name: "Naan", price: "60" }]);
    expect(items[0].category).toBe("Mains");
  });

  it("reads non-veg in any of its spellings", () => {
    expect(normalizeMenuRows([{ name: "A", price: "1", foodtype: "Non-Veg" }]).items[0].foodType).toBe("nonveg");
    expect(normalizeMenuRows([{ name: "B", price: "1", type: "nonveg" }]).items[0].foodType).toBe("nonveg");
    expect(normalizeMenuRows([{ name: "C", price: "1", foodtype: "veg" }]).items[0].foodType).toBe("veg");
  });

  it("skips a row with no name, reporting its line", () => {
    const { items, skipped } = normalizeMenuRows([{ price: "60" }]);
    expect(items).toHaveLength(0);
    expect(skipped[0]).toMatchObject({ line: 2, reason: "no name" });
  });

  it("skips an unpriced row rather than importing NaN", () => {
    // A menu item priced NaN corrupts every bill it appears on.
    const { items, skipped } = normalizeMenuRows([{ name: "Mystery", price: "ask staff" }]);
    expect(items).toHaveLength(0);
    expect(skipped[0].reason).toBe("no usable price");
  });

  it("reads boolean flags loosely", () => {
    const { items } = normalizeMenuRows([{ name: "A", price: "1", chefspecial: "YES", featured: "1" }]);
    expect(items[0].chefSpecial).toBe(true);
    expect(items[0].featured).toBe(true);
  });
});

describe("parseMenuText", () => {
  it("imports a CSV", () => {
    const r = parseMenuText("Name,Price,Category\nPaneer,280,Starters", "csv");
    expect(r.error).toBeNull();
    expect(r.items).toHaveLength(1);
  });

  it("imports a JSON array", () => {
    const r = parseMenuText('[{"Name":"Paneer","Price":280}]', "json");
    expect(r.error).toBeNull();
    expect(r.items[0].name).toBe("Paneer");
  });

  it("imports JSON wrapped in an items key", () => {
    const r = parseMenuText('{"items":[{"name":"Naan","price":60}]}', "json");
    expect(r.items).toHaveLength(1);
  });

  it("explains malformed JSON instead of throwing", () => {
    const r = parseMenuText("{not json", "json");
    expect(r.error).toContain("Could not read that JSON");
    expect(r.items).toEqual([]);
  });

  it("explains a header-only CSV", () => {
    expect(parseMenuText("Name,Price", "csv").error).toContain("No rows found");
  });

  it("explains a CSV with no usable rows", () => {
    const r = parseMenuText("Name,Price\n,\n,", "csv");
    expect(r.error).toContain("Nothing importable");
  });
});

describe("parseImportRows — the reception importer", () => {
  it("imports a complete row", () => {
    const { items, errors } = parseImportRows("Name,Price,Category\nDal,320,Mains", "csv");
    expect(errors).toEqual([]);
    expect(items[0]).toMatchObject({ name: "Dal", price: 320, category: "Mains", available: true });
  });

  it("REPORTS a missing category rather than defaulting it", () => {
    // Stricter than the master-menu importer on purpose: a dish landing in the
    // wrong section is worse than one the operator was told to fix.
    const { items, errors } = parseImportRows("Name,Price\nDal,320", "csv");
    expect(items).toEqual([]);
    expect(errors[0]).toContain("Category is required");
  });

  it("names the row so the operator can find it in their spreadsheet", () => {
    const { errors } = parseImportRows("Name,Price,Category\nDal,320,Mains\n,60,Breads", "csv");
    expect(errors[0]).toContain("Row 2");
  });

  it("quotes back the unusable price", () => {
    const { errors } = parseImportRows("Name,Price,Category\nDal,ask staff,Mains", "csv");
    expect(errors[0]).toContain('got "ask staff"');
  });

  it("imports the good rows even when others fail", () => {
    const { items, errors } = parseImportRows("Name,Price,Category\nDal,320,Mains\nBad,,Mains", "csv");
    expect(items).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("forces veg when the outlet is Pure Veg, whatever the file claims", () => {
    const { items } = parseImportRows("Name,Price,Category,FoodType\nX,100,Mains,nonveg", "csv", { pureVeg: true });
    expect(items[0].foodType).toBe("veg");
  });

  it("explains malformed JSON instead of throwing", () => {
    expect(parseImportRows("{nope", "json").error).toContain("Invalid format");
  });

  it("accepts a single JSON object as one row", () => {
    const { items } = parseImportRows('{"name":"Dal","price":320,"category":"Mains"}', "json");
    expect(items).toHaveLength(1);
  });
});

describe("matchImageFile", () => {
  const images = { "dosa.png": "A", "paneer tikka.jpg": "B" };

  it("matches exactly", () => {
    expect(matchImageFile("dosa.png", images)).toBe("A");
  });

  it("ignores the path a spreadsheet may include", () => {
    expect(matchImageFile("images/dosa.png", images)).toBe("A");
  });

  it("ignores case", () => {
    expect(matchImageFile("Dosa.PNG", images)).toBe("A");
  });

  it("falls back past the extension, so a .jpg in the sheet finds a .png in the zip", () => {
    expect(matchImageFile("dosa.jpg", images)).toBe("A");
  });

  it("returns nothing when there is genuinely no match", () => {
    expect(matchImageFile("missing.png", images)).toBeNull();
    expect(matchImageFile("", images)).toBeNull();
    expect(matchImageFile("dosa.png", null)).toBeNull();
  });
});
