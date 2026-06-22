import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { PwaRegister } from "./pwa-register";
import { ThemeProvider } from "./providers";

export const metadata: Metadata = {
  title: "ProgressFit",
  description: "Track workouts and progressively overload.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "512x512", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "ProgressFit",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#111111" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const themeInitScript = `
(() => {
  try {
    const saved = localStorage.getItem("progressfit-theme");
    const resolved = saved === "dark" || saved === "light" ? saved : "light";
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    const themeColor = document.querySelector("meta[name='theme-color']:not([media])") || document.head.appendChild(document.createElement("meta"));
    themeColor.setAttribute("name", "theme-color");
    themeColor.setAttribute("content", resolved === "dark" ? "#111111" : "#ffffff");
    const statusBar = document.querySelector("meta[name='apple-mobile-web-app-status-bar-style']");
    statusBar?.setAttribute("content", "black-translucent");
  } catch {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  }
})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <Script id="theme-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider>
          <PwaRegister />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
