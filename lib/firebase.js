import { initializeApp, getApps } from "firebase/app";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

// initializeFirestore() may only be called ONCE per app — a second call
// throws. In dev, Turbopack Fast Refresh can re-run this module (any edit to
// a file that imports it, transitively, is enough) while the FIRST Firestore
// instance's IndexedDB connection is still open. The second initializeFirestore
// call then collides with it, and a request against the orphaned first
// instance surfaces as "Database is closing/hidden" — not an application bug,
// but this file not surviving hot reload.
//
// getFirestore(app) returns the ALREADY-RUNNING instance rather than starting
// a second one, so Fast Refresh reuses it instead of fighting it.
let dbInstance;
try {
  dbInstance = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
    experimentalForceLongPolling: true,
  });
} catch {
  dbInstance = getFirestore(app);
}
export const db = dbInstance;

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export async function uploadToCloudinary(file) {
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
  const uploadPreset = process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET;

  if (!cloudName || !uploadPreset) {
    throw new Error("Cloudinary config missing. Check env vars.");
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", uploadPreset);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    { method: "POST", body: formData }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || `Upload failed: ${response.status}`);
  }

  const data = await response.json();
  return data.secure_url;
}