// Builds the recommendation model for every outlet, from real order history.
//
// This is the batch job firestore.rules refers to when it says recModels is
// "written by a trusted batch job using the Admin SDK, which bypasses these
// rules entirely" — that comment described an intention with nothing behind
// it until this file. It reads recent orders and the current menu for each
// outlet, mines what actually gets ordered together, blends that with a
// category-complement prior (lib/recommendations.js — the same file that
// scores recommendations in the diner's browser, so the two never disagree
// about what a pairing is worth), and writes one compact model document per
// outlet to restaurants/{outletId}/recModels/current.
//
// Deliberately NOT a live listener and not a Cloud Function reacting to every
// order: mining months of history to score every pair is batch work, cheap to
// do once a day, wasteful to redo on each request. Run this on a schedule —
// Windows Task Scheduler, cron, or later a scheduled Cloud Function if this
// project ever adds Functions infrastructure, which it does not have today.
//
// -----------------------------------------------------------------------
// RUNNING THIS
//
//   1. Firebase Console -> Project settings -> Service accounts ->
//      "Generate new private key". Save the JSON somewhere outside the repo.
//   2. Set GOOGLE_APPLICATION_CREDENTIALS to that file's path:
//        set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\key.json   (Windows)
//        export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json (bash)
//   3. npm run build:rec-models
//      npm run build:rec-models -- --outlet=<one outlet id>   (just one)
//
// The service account key is a credential, not a secret to commit — treat it
// like a password.
// -----------------------------------------------------------------------

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { buildRecModel } from "../lib/recommendations.js";

// How far back to mine. Long enough to learn a stable pattern from a single
// restaurant's real volume; bounded so a very old order that reflects a menu
// that no longer exists does not weigh forever on one that does. This is a
// nightly batch cost, not a per-request one, so it can afford to look further
// back than the reception dashboard's own 31-day display window does.
const HISTORY_DAYS = 180;

function parseArgs(argv) {
  const outletArg = argv.find((a) => a.startsWith("--outlet="));
  return { onlyOutlet: outletArg ? outletArg.split("=")[1] : null };
}

async function loadOutletOrders(db, outletId, sinceMs) {
  const snap = await db
    .collection("restaurants").doc(outletId).collection("orders")
    .where("createdAt", ">=", sinceMs)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadMenuItems(db, outletId) {
  const snap = await db.collection("restaurants").doc(outletId).collection("menuItems").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function buildForOutlet(db, outletId, sinceMs) {
  const [orders, menuItems] = await Promise.all([
    loadOutletOrders(db, outletId, sinceMs),
    loadMenuItems(db, outletId),
  ]);
  const model = buildRecModel({ orders, menuItems });

  await db.collection("restaurants").doc(outletId)
    .collection("recModels").doc("current")
    .set(model);

  const pairCount = Object.values(model.partners).reduce((n, list) => n + list.length, 0);
  console.log(
    `  ${outletId}: ${model.orderCount} orders mined, ${Object.keys(model.partners).length} items with learned partners, ${pairCount} partner links.`
  );
}

async function main() {
  const { onlyOutlet } = parseArgs(process.argv.slice(2));

  initializeApp({ credential: applicationDefault() });
  const db = getFirestore();
  const sinceMs = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;

  const outletIds = onlyOutlet
    ? [onlyOutlet]
    : (await db.collection("restaurants").listDocuments()).map((ref) => ref.id);

  console.log(`Building recommendation models for ${outletIds.length} outlet(s), from the last ${HISTORY_DAYS} days...`);

  let failures = 0;
  for (const outletId of outletIds) {
    try {
      await buildForOutlet(db, outletId, sinceMs);
    } catch (err) {
      failures++;
      // One outlet's bad data (a malformed order document, say) should not
      // stop every other outlet's model from being refreshed tonight.
      console.error(`  ${outletId}: FAILED — ${err.message}`);
    }
  }

  console.log(failures > 0 ? `Done, with ${failures} failure(s).` : "Done.");
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Could not run:", err.message);
  process.exit(1);
});
