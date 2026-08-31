import { AuthProvider } from "@/lib/auth-context";
import { PWAProvider } from "@/components/PWAProvider";

export const metadata = {
  title: "Cabadra",
  description: "QR-based restaurant ordering",
  manifest: "/manifest.json",
  themeColor: "#1a1a2e",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Cabadra Staff",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/icon-192x192.png" />
      </head>
      <body
        style={{
          margin: 0,
          padding: 0,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <AuthProvider>
          <PWAProvider>{children}</PWAProvider>
        </AuthProvider>
      </body>
    </html>
  );
}