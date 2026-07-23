import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "Tsugite — 映像づくりを、組み上げる。";
const description = "GitHubのソースをCodex／Claude Codeで使い、制作案件、テンプレート、Gate、3D Viewerをひとつのローカルワークフローで確認するTsugite。";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title,
    description,
    icons: { icon: "/favicon.png", shortcut: "/favicon.png" },
    openGraph: {
      type: "website",
      locale: "ja_JP",
      siteName: "Tsugite",
      title,
      description: "GitHubとCodex／Claude Codeから始める、ローカル中心のAI映像制作ワークフロー。",
      images: [{ url: `${origin}/og.png`, width: 1200, height: 630, alt: "TSUGITE AI VIDEO WORKSHOP" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: "GitHubとCodex／Claude Codeから始める、ローカル中心のAI映像制作ワークフロー。",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
