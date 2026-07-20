import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("https://tsugite.example/", {
      headers: { accept: "text/html", host: "tsugite.example" },
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Tsugite download landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Tsugite — 映像づくりを、組み上げる。<\/title>/);
  assert.match(html, /映像づくりを、/);
  assert.match(html, /組み上げる。/);
  assert.match(html, /v0\.6\.0 Beta/);
  assert.match(html, /先行ベータ版/);
  assert.match(html, /Codex／Claude Codeでつくる。Desktopで見て決める。/);
  assert.match(html, /34種の構成法/);
  assert.match(html, /PixVerse、Kling、Seedance/);
  assert.match(html, /Codex AutomationやClaudeが昇格候補として整理/);
  assert.match(html, /Desktopは案件・工程・承認を確認する画面/);
  assert.match(html, /Codex／Claude CodeとDesktopで同じフォルダを選びます/);
  assert.match(html, /通知を入口に、学びを育てる/);
  assert.match(html, /承認だけでルールが自動変更されることはありません/);
  assert.match(html, /MacやWindowsの確認画面が表示される場合があります/);
  assert.match(html, /生成ランチャー／生成ノード機能は、今回のベータ版には含まれていません/);
  assert.match(html, /TSUGITE \/ KEY VISUAL/);
  assert.match(html, /生成と判断を、ひとつの工程に継ぐ。/);
  assert.match(html, /https:\/\/github\.com\/Takamasa045\/tsugite\/releases\/tag\/v0\.6\.0-beta\.1/);
  assert.match(html, /https:\/\/github\.com\/Takamasa045\/tsugite\/releases\/download\/v0\.6\.0-beta\.1\/Tsugite-0\.6\.0-macos-arm64\.dmg/);
  assert.match(html, /https:\/\/github\.com\/Takamasa045\/tsugite\/releases\/download\/v0\.6\.0-beta\.1\/Tsugite-0\.6\.0-windows-x64-setup\.exe/);
  assert.match(html, /Mac版をダウンロード/);
  assert.match(html, /Windows版をダウンロード/);
  assert.match(html, /macOS 12\+/);
  assert.match(html, /Windows 10\+/);
  assert.match(html, /システム設定/);
  assert.match(html, /Smart App Control/);
  assert.match(html, /https:\/\/tsugite\.example\/og\.png/);
  assert.match(html, /TSUGITE \/ ROUGH CUT TO CRAFT/);
  assert.match(html, /映像を、<br\s*\/><em>組み上げる。<\/em>/);
  assert.match(html, /選ぶほど、<em>自分好みに<br\s*\/>育ってくる。<\/em>/);
  assert.doesNotMatch(html, /launcher-screen\.(?:avif|webp|jpg)/);
  assert.match(html, /class="brand-icon"[^>]*src="\/favicon\.png"/);
  assert.doesNotMatch(html, /レビューを開く|3本の生成映像|新しい映像を組み上げる/);
  assert.doesNotMatch(html, /配布準備中|署名済みインストーラーの公開後|SIGNING|PREPARING|UNSIGNED BETA/);
  assert.doesNotMatch(html, /未署名|コード署名|notarization|公式GitHub|公式Release/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/);
});

test("ships site-specific metadata, assets, and accessibility styles", async () => {
  const [page, layout, css, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    access(new URL("../public/favicon.png", import.meta.url)),
    access(new URL("../public/og.png", import.meta.url)),
    access(new URL("../public/og-background.webp", import.meta.url)),
    access(new URL("../public/og-background.avif", import.meta.url)),
    access(new URL("../public/launcher-screen.jpg", import.meta.url)),
    access(new URL("../public/launcher-screen.webp", import.meta.url)),
    access(new URL("../public/launcher-screen.avif", import.meta.url)),
  ]);

  assert.match(page, /aria-label="メインナビゲーション"/);
  assert.match(page, /className="brand-icon" src="\/favicon\.png"/);
  assert.doesNotMatch(page, /joinery-mark/);
  assert.match(page, /className="hero-motion"/);
  assert.match(page, /aria-label="構成を描き、素材を選び、映像を組み上げる。選ぶほど、自分好みの制作環境に育ってくる工程を表すアニメーション"/);
  assert.doesNotMatch(page, /launcher-screen\.(?:avif|webp|jpg)/);
  assert.doesNotMatch(page, /レビューを開く|3本の生成映像|新しい映像を組み上げる/);
  assert.match(page, /id="download"/);
  assert.match(page, /id="knowledge"/);
  assert.match(page, /id="workspace"/);
  assert.match(page, /MAKE \/ CODEX・CLAUDE CODE/);
  assert.match(page, /className="platform-card platform-download/);
  assert.match(page, /APPLE_SUPPORT_URL/);
  assert.match(page, /MICROSOFT_SUPPORT_URL/);
  assert.match(layout, /generateMetadata/);
  assert.match(layout, /summary_large_image/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /url\("\/og\.png"\)/);
  assert.match(css, /\.key-visual/);
  assert.match(css, /\.knowledge-section/);
  assert.match(css, /\.hybrid-roles/);
  assert.match(css, /\.hero-motion\s*\{/);
  assert.match(css, /repeating-linear-gradient\(97deg/);
  assert.match(css, /\.motion-build\s*\{/);
  assert.match(css, /\.motion-part-base\s*\{/);
  assert.match(css, /@keyframes motion-part-base/);
  assert.match(css, /\.motion-film\s*\{/);
  assert.match(css, /@keyframes motion-film-resolve/);
  assert.match(css, /@keyframes motion-copy/);
  const heroRule = css.match(/\.hero\s*\{([^}]*)\}/s)?.[1] ?? "";
  assert.match(heroRule, /linear-gradient\(180deg, #090909/);
  assert.doesNotMatch(heroRule, /var\(--yakisugi\)/);
  assert.match(css, /\.motion-copy-assemble\s*\{[^}]*opacity:\s*1/s);
  assert.doesNotMatch(css, /mix-blend-mode:\s*luminosity/);
  assert.match(css, /\.key-visual\s*\{[^}]*image-set\([^}]*og-background\.avif/s);
  assert.match(css, /:focus-visible/);
  assert.match(css, /\.beta-notice/);
  assert.match(css, /\.platform-download/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton|drizzle/);
  await assert.rejects(
    access(new URL("../app/_sites-preview", import.meta.url)),
    (error) => error?.code === "ENOENT",
  );
});
