"use client";

// Customers, built automatically from the names and phone numbers captured at
// billing time. Read-only: the CRM is a by-product of billing, not something
// reception maintains by hand.

import { isToday } from "@/lib/orders";
import { crmRows, reportFilename } from "@/lib/reports";
import { downloadCsv } from "@/lib/download";
import { StatCard, SectionHeader, EmptyState } from "./ui";

export default function CrmSection({ customers, restaurantName }) {
  const repeat = customers.filter((c) => (c.orderCount || 0) > 1);
  const newToday = customers.filter((c) => c.firstSeen && isToday(c.firstSeen));
  const sorted = [...customers].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

  function exportCsv() {
    const { rows } = crmRows({ customers, restaurantName });
    downloadCsv(rows, reportFilename("crm-report"));
  }

  return (
    <div>
      <SectionHeader
        title="Customers (CRM)"
        subtitle="Built automatically from names and phones entered while generating bills."
      >
        <button className="btn btn-primary" onClick={exportCsv} disabled={customers.length === 0}>
          ⬇ Export CRM Report
        </button>
      </SectionHeader>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 14, marginBottom: 24 }}>
        <StatCard label="Total Customers" value={customers.length} color="#3b82f6" />
        <StatCard
          label="Repeat Customers"
          value={repeat.length}
          color="#16a34a"
          sub={customers.length ? `${Math.round((repeat.length / customers.length) * 100)}% of total` : undefined}
        />
        <StatCard label="New Today" value={newToday.length} color="#e8a33d" />
      </div>

      <div className="card" style={{ borderRadius: 18, overflow: "hidden" }}>
        {sorted.length === 0 ? (
          <EmptyState
            icon="👥"
            message="No customers tracked yet. Add a name or phone when generating a bill to start building your CRM."
          />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border, #e6e1d6)", textAlign: "left", background: "var(--surface-2, #f3efe6)" }}>
                  {["Name", "Phone", "Orders", "Total Spent", "Last Visit", "Type"].map((h) => (
                    <th key={h} style={{ padding: "10px 14px" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((c) => (
                  <tr key={c.id} style={{ borderBottom: "1px solid #f4f4f4" }}>
                    <td style={{ padding: "10px 14px", fontWeight: 600 }}>{c.name || "—"}</td>
                    <td style={{ padding: "10px 14px" }}>{c.phone || "—"}</td>
                    <td style={{ padding: "10px 14px" }}>{c.orderCount || 0}</td>
                    <td style={{ padding: "10px 14px", fontWeight: 700 }}>₹{(c.totalSpent || 0).toLocaleString()}</td>
                    <td style={{ padding: "10px 14px", color: "#888" }}>
                      {c.lastSeen ? new Date(c.lastSeen).toLocaleDateString() : "-"}
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      {(c.orderCount || 0) > 1
                        ? <span className="badge" style={{ background: "#dcfce7", color: "#166534" }}>Repeat</span>
                        : <span className="badge">New</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
