// Handing the browser a file. The only DOM-touching part of the reporting
// path, kept apart from lib/reports.js so the row-building stays testable.

import { toCSV } from "./reports";

export function downloadCsv(rows, filename) {
  const blob = new Blob([toCSV(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking immediately can cancel the download in some browsers; a tick is
  // enough for the click to be dispatched.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens a print-ready window. Returns false if a popup blocker stopped it. */
export function printHtml(html, { width = 900, height = 900 } = {}) {
  const win = window.open("", "_blank", `width=${width},height=${height}`);
  if (!win) return false;
  win.document.write(html);
  win.document.close();
  return true;
}
