export const metadata = { title: "Privacy Policy — Cabadra" };

const wrap = { minHeight: "100vh", background: "linear-gradient(135deg, #faf8f5 0%, #f5f3ef 100%)", padding: "48px 20px" };
const card = { maxWidth: 760, margin: "0 auto", background: "#fff", borderRadius: 20, padding: "40px 36px", boxShadow: "0 2px 20px rgba(0,0,0,0.05)" };
const h2 = { fontSize: 18, fontWeight: 800, color: "#1a1a2e", margin: "32px 0 10px" };
const p = { fontSize: 14.5, color: "#4a4a55", lineHeight: 1.7, margin: "0 0 12px" };
const li = { fontSize: 14.5, color: "#4a4a55", lineHeight: 1.7, marginBottom: 6 };
const placeholder = { background: "#fef3c7", color: "#92400e", padding: "1px 6px", borderRadius: 4, fontWeight: 700 };

export default function PrivacyPolicy() {
  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>🍽️</div>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: "#1a1a2e", margin: "0 0 6px" }}>Privacy Policy</h1>
        <p style={{ ...p, color: "#999", fontSize: 13 }}>Last updated: <span style={placeholder}>[date you publish this]</span></p>

        <div style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 12, padding: 14, margin: "18px 0", fontSize: 13, lineHeight: 1.6, color: "#92400e" }}>
          This describes, accurately, what Cabadra's software actually collects and does with data —
          it is not legal advice, and has not been reviewed by a lawyer. Before showing this to real
          customers, fill in the bracketed placeholders below with your actual business details, and
          have it reviewed against India's Digital Personal Data Protection Act, 2023, which sets
          specific requirements this draft does not independently verify compliance with.
        </div>

        <p style={p}>
          <span style={placeholder}>[Your business/company name]</span> ("Cabadra", "we", "us") operates
          the Cabadra ordering platform, used by restaurants to take orders — at the table, for pickup,
          and for delivery. This policy explains what we collect from you, why, and what you can do about it.
        </p>

        <h2 style={h2}>What we collect</h2>
        <p style={p}>From a customer placing an order:</p>
        <ul style={{ margin: "0 0 12px", paddingLeft: 20 }}>
          <li style={li}><strong>Dine-in and pickup orders:</strong> the items ordered and a table or order number. No name or phone number is required.</li>
          <li style={li}><strong>Delivery orders:</strong> your name, phone number, and delivery address, so the restaurant can prepare, deliver, and reach you if something goes wrong.</li>
          <li style={li}><strong>Phone verification</strong> (where a restaurant has switched it on): your phone number, verified by an SMS code, to confirm it is genuinely yours before an order is accepted.</li>
          <li style={li}><strong>An optional rating</strong> you may leave after your order is complete.</li>
        </ul>
        <p style={p}>From a restaurant's own staff:</p>
        <ul style={{ margin: "0 0 12px", paddingLeft: 20 }}>
          <li style={li}>Name, email address (via Google Sign-In), phone number, and role (owner, manager, reception, or kitchen).</li>
          <li style={li}>The restaurant's own business details: name, menu, prices, photos, and payment collection details (a UPI ID — never card numbers, which we never handle or store).</li>
        </ul>

        <h2 style={h2}>What we do not collect</h2>
        <p style={p}>
          We do not process payments. Orders are settled directly between you and the restaurant — cash
          on delivery, or a UPI payment you make yourself, scanning a code the restaurant provides. We
          never see or store your card, bank, or UPI PIN details. We do not track your location, and we
          do not use advertising trackers or sell data to advertisers.
        </p>

        <h2 style={h2}>Why we collect it</h2>
        <ul style={{ margin: "0 0 12px", paddingLeft: 20 }}>
          <li style={li}>To take and prepare your order, and to let you check its status without creating an account.</li>
          <li style={li}>To let a delivery rider reach you, and to let you reach them.</li>
          <li style={li}>To help restaurants suggest dishes people order together — done using overall patterns, not by singling out what you personally ordered.</li>
          <li style={li}>To run the staff side of the platform — logins, permissions, and each restaurant's own records of its business.</li>
        </ul>

        <h2 style={h2}>Who else sees it</h2>
        <p style={p}>
          Cabadra runs on infrastructure operated by other companies, who process data on our behalf as
          part of providing that infrastructure:
        </p>
        <ul style={{ margin: "0 0 12px", paddingLeft: 20 }}>
          <li style={li}><strong>Google Firebase</strong> — where all data described above is stored, and which handles staff sign-in.</li>
          <li style={li}><strong>Cloudinary</strong> — hosts menu photos uploaded by restaurants.</li>
          <li style={li}><strong>Vercel</strong> — hosts the website itself.</li>
          <li style={li}><strong>Sentry</strong> — where enabled, receives technical details about errors (such as a stack trace) to help us fix bugs; not used for tracking or advertising.</li>
        </ul>
        <p style={p}>
          Each of these may process data outside India as part of how their infrastructure operates.
          We do not sell your data to anyone, or share it with advertisers.
        </p>

        <h2 style={h2}>How long we keep it</h2>
        <p style={p}>
          A restaurant's order history is kept as an ongoing business record. A rider's or customer's
          contact details for one order are kept as part of that order's record, not published or shared
          beyond the restaurant that took the order and (where relevant) the rider who delivered it.
        </p>

        <h2 style={h2}>Your choices</h2>
        <p style={p}>
          To ask what we hold about you, correct it, or have it deleted, contact the restaurant you
          ordered from, or write to us directly at <span style={placeholder}>[your contact email]</span>.
          We handle these requests manually today; if you do not hear back promptly, please follow up.
        </p>

        <h2 style={h2}>Children</h2>
        <p style={p}>Cabadra is not directed at children, and we do not knowingly collect data from anyone under 18.</p>

        <h2 style={h2}>Changes to this policy</h2>
        <p style={p}>
          If this policy changes in a way that matters, we will update the date at the top of this page.
        </p>

        <h2 style={h2}>Contact</h2>
        <p style={p}>
          <span style={placeholder}>[Your business/company name]</span><br />
          <span style={placeholder}>[Registered address]</span><br />
          <span style={placeholder}>[Contact email]</span>
        </p>

        <div style={{ marginTop: 32, paddingTop: 20, borderTop: "1px solid #f0ebe3" }}>
          <a href="/" style={{ color: "#e8a33d", fontWeight: 700, fontSize: 13.5, textDecoration: "none" }}>← Back to Cabadra</a>
        </div>
      </div>
    </div>
  );
}
