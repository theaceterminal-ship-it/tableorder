# Cabadra

QR-code table ordering for restaurants. Diners scan a code at the table, browse
the menu, and order from their phone; reception runs a POS, billing, and
analytics console; the kitchen gets a live order board.

Next.js (App Router) + Firebase Firestore. Everything runs client-side today —
there is no server layer.

## Running it

```bash
npm install
```

Create `.env.local` with your Firebase and Cloudinary config:

```
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME=
NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET=
```

The build prerenders pages that import the Firebase client, so these must be set
for `npm run build` to succeed, not just for `npm run dev`.

```bash
npm run dev
```

| Route | Who it's for |
| --- | --- |
| `/table?restaurant=<id>&table=<n>` | Diner — the QR code target, unauthenticated |
| `/receptionist` | Front of house — POS, billing, menu, analytics |
| `/kitchen` | Kitchen order board |
| `/login`, `/signup` | Staff auth and onboarding |

## Tests

```bash
npm test
```

137 unit tests over `lib/` — billing, discounts, BOGO, order normalization,
the permission model, the kitchen queue, and menu import. This is the code most
likely to cost a client real money if it breaks, so changes to it should come
with a test.

### Security rules

```bash
npm run test:rules
```

54 tests run against the real Firestore emulator, exercising `firestore.rules`
directly: what a diner can and cannot do from an unauthenticated page, what an
outlet manager may reach, who may invite whom and over which outlets, that an
owner cannot activate their own subscription, and that the audit log cannot be
edited by anybody.

**Run this before deploying rules.** Every boundary it covers was broken at
least once during development and found by a human clicking through the app —
including failures that locked staff out of their own restaurant mid-service.

The emulator runs on the JVM, so Java is required. The script locates an
installed JDK itself, so it works even in a terminal that was already open when
Java was installed — no PATH setup, no restarting your shell. If none is found
it prints the install command for your platform.

## Deploying Firestore rules and indexes

Security rules and composite indexes live in this repo and must be deployed
whenever they change:

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

Two things depend on this and will break without it:

- The diner's table client queries orders by `table` **and** `createdAt`, which
  needs the composite index in `firestore.indexes.json`.
- `firestore.rules` is what keeps the unauthenticated diner client from writing
  bills or reading staff-only collections.

## Layout

```
app/table/         diner ordering flow (unauthenticated)
app/receptionist/  POS, billing, menu management, analytics
app/kitchen/       kitchen order board
lib/pricing.js     discounts, BOGO, bill totals — pure, tested
lib/orders.js      item-id resolution, line merging, revenue de-duplication — pure, tested
lib/firebase.js    Firestore + auth client
lib/plans.js       subscription tiers and pricing
firestore.rules    security rules (deploy them — see above)
```

### Order data

Order lines carry an `itemId`. The `name` field is a *composed display string*
(dish plus variation plus add-ons) and must never be used as a join key —
renaming a dish would orphan its sales history and each variation would look
like a separate dish. Use `resolveItemId` / `withItemIds` from `lib/orders.js`
to recover ids from older lines written before this rule existed.

### Merged-table bills

When several merged tables are billed together, every order in the group is
given the same consolidated bill so each table's device can display it, and
exactly one is flagged `isBillPrimary: true`. **Anything that sums revenue or
counts items must go through `revenueOrders()`** from `lib/orders.js`, which
keeps only the primary — otherwise a three-table party is counted three times.
