export const metadata = { title: "Terms of Service — Cabadra" };

const wrap = { minHeight: "100vh", background: "linear-gradient(135deg, #faf8f5 0%, #f5f3ef 100%)", padding: "48px 20px" };
const card = { maxWidth: 760, margin: "0 auto", background: "#fff", borderRadius: 20, padding: "40px 36px", boxShadow: "0 2px 20px rgba(0,0,0,0.05)" };
const h2 = { fontSize: 18, fontWeight: 800, color: "#1a1a2e", margin: "32px 0 10px" };
const p = { fontSize: 14.5, color: "#4a4a55", lineHeight: 1.7, margin: "0 0 12px" };
const li = { fontSize: 14.5, color: "#4a4a55", lineHeight: 1.7, marginBottom: 6 };
const placeholder = { background: "#fef3c7", color: "#92400e", padding: "1px 6px", borderRadius: 4, fontWeight: 700 };

export default function TermsOfService() {
  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>🍽️</div>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: "#1a1a2e", margin: "0 0 6px" }}>Terms of Service</h1>
        <p style={{ ...p, color: "#999", fontSize: 13 }}>Last updated: 4 September 2026</p>

        <div style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 12, padding: 14, margin: "18px 0", fontSize: 13, lineHeight: 1.6, color: "#92400e" }}>
          A working starting point, grounded in what the platform actually does — not legal advice,
          and not reviewed by a lawyer. Fill in the bracketed placeholders and have a lawyer check this
          before relying on it, especially the liability and governing-law sections below.
        </div>

        <p style={p}>
          These terms govern use of Cabadra ("the platform"). By using it — as a restaurant, a member
          of a restaurant's staff, or a customer placing an order — you agree to them.
        </p>

        <h2 style={h2}>What Cabadra is</h2>
        <p style={p}>
          Cabadra is software that lets a restaurant take orders — by table QR code, for pickup, or for
          delivery — and run its kitchen and billing. Cabadra is not a restaurant, does not prepare food,
          does not employ delivery riders, and is not a party to any order placed through it. The
          contract for that food and its delivery is between the customer and the restaurant.
        </p>

        <h2 style={h2}>Payment</h2>
        <p style={p}>
          Cabadra does not process payments. Orders are settled directly with the restaurant — cash on
          delivery, or a UPI payment the customer makes themselves. Any dispute about a charge, a refund,
          or the quality of food or delivery is between the customer and the restaurant; Cabadra is not
          responsible for resolving it, though we are happy to help put the two of you in touch.
        </p>

        <h2 style={h2}>Restaurant accounts</h2>
        <ul style={{ margin: "0 0 12px", paddingLeft: 20 }}>
          <li style={li}>A restaurant is responsible for the accuracy of its own menu, prices, and offers.</li>
          <li style={li}>A restaurant is responsible for who it invites as staff, and for what those staff members do with the access it grants them.</li>
          <li style={li}>A restaurant may not use the platform for anything unlawful, or to collect customer data for purposes beyond running its own orders.</li>
        </ul>

        <h2 style={h2}>Availability</h2>
        <p style={p}>
          We aim to keep Cabadra running reliably, but we do not guarantee it will always be available,
          error-free, or uninterrupted. <span style={placeholder}>[If you offer a paid plan with an
          uptime commitment, describe it here instead of this sentence.]</span>
        </p>

        <h2 style={h2}>Limitation of liability</h2>
        <p style={p}>
          To the fullest extent the law allows, Cabadra is not liable for indirect, incidental, or
          consequential damages arising from use of the platform, including a failed or late order, a
          billing mistake made by a restaurant, or an outage. <span style={placeholder}>[This section
          carries real legal weight and the exact wording should be set by your own lawyer, not left as
          a template.]</span>
        </p>

        <h2 style={h2}>Termination</h2>
        <p style={p}>
          We may suspend or close a restaurant's account for breaching these terms, non-payment of any
          agreed fee, or misuse of the platform. A restaurant may stop using the platform at any time.
        </p>

        <h2 style={h2}>Changes</h2>
        <p style={p}>
          We may update these terms as the platform changes. Continued use after an update means you
          accept the new terms.
        </p>

        <h2 style={h2}>Governing law</h2>
        <p style={p}>
          These terms are governed by the laws of <span style={placeholder}>[your state]</span>, India.
        </p>

        <h2 style={h2}>Contact</h2>
        <p style={p}>
          Cabadra<br />
          <span style={placeholder}>[Registered address]</span><br />
          <a href="mailto:theaceterminal@gmail.com" style={{ color: "#e8a33d" }}>theaceterminal@gmail.com</a>
        </p>

        <div style={{ marginTop: 32, paddingTop: 20, borderTop: "1px solid #f0ebe3" }}>
          <a href="/" style={{ color: "#e8a33d", fontWeight: 700, fontSize: 13.5, textDecoration: "none" }}>← Back to Cabadra</a>
        </div>
      </div>
    </div>
  );
}
