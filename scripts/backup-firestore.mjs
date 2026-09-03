// Backs up the whole Firestore database to Cloud Storage, on a schedule.
//
// Firestore's own multi-region replication protects against hardware
// failure, but it protects nothing against a bad rules deploy, an accidental
// bulk delete, or a bug that quietly corrupts data — replication faithfully
// copies a mistake to every region just as fast as it copies anything else.
// This is the other kind of protection: a point-in-time snapshot you can
// restore FROM, taken independently of whatever the application is doing.
//
// Uses Firestore's own managed export (the same mechanism `gcloud firestore
// export` drives), reached here through the Admin SDK's v1 client so this
// needs no extra tool installed — just the same service account credentials
// already set up for scripts/build-rec-models.mjs.
//
// -----------------------------------------------------------------------
// RUNNING THIS
//
//   Same credentials as the recommendation model job:
//     set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\key.json
//     npm run backup:firestore
//
//   Each run writes a full snapshot to:
//     gs://<project-id>.appspot.com/firestore-backups/<timestamp>/
//
//   To restore from one (this REPLACES live data — never run this against a
//   database with data you want to keep, only into an empty project or one
//   you are deliberately rolling back):
//     gcloud firestore import gs://<project-id>.appspot.com/firestore-backups/<timestamp>/
//
// Nothing here deletes old backups. Cloud Storage bills for what it stores,
// so set a lifecycle rule on the bucket (Console -> Cloud Storage -> the
// bucket -> Lifecycle -> add rule -> delete objects under
// firestore-backups/ older than N days) or this grows forever.
// -----------------------------------------------------------------------

import { v1 } from "firebase-admin/firestore";

function timestampSlug(d = new Date()) {
  // Filesystem- and URL-safe, sorts chronologically as plain text.
  return d.toISOString().replace(/[:.]/g, "-");
}

async function main() {
  // No initializeApp() needed here — this GAPIC client reads the same
  // GOOGLE_APPLICATION_CREDENTIALS directly and resolves the project id
  // straight off the service account key.
  const client = new v1.FirestoreAdminClient();
  const projectId = await client.getProjectId();
  const databaseName = client.databasePath(projectId, "(default)");
  const bucket = `gs://${projectId}.appspot.com`;
  const outputUriPrefix = `${bucket}/firestore-backups/${timestampSlug()}`;

  console.log(`Starting export of ${projectId} to ${outputUriPrefix} ...`);

  const [operation] = await client.exportDocuments({
    name: databaseName,
    outputUriPrefix,
    // Every collection, not a chosen subset — a partial backup is a trap
    // for whoever restores it later without noticing what was left out.
    collectionIds: [],
  });

  console.log(`Export started (operation: ${operation.name}). Waiting for it to finish...`);
  const [result] = await operation.promise();

  console.log(`Done. Snapshot written to: ${result.outputUriPrefix}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Backup failed:", err.message);
  process.exit(1);
});
