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

test("server-renders the source-first Tsugite landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Tsugite — 映像づくりを、組み上げる。<\/title>/);
  assert.match(html, /映像づくりを、/);
  assert.match(html, /組み上げる。/);
  assert.match(html, /SOURCE WORKFLOW/);
  assert.match(html, /Codex／Claude Codeでつくる。ローカルViewerで見て決める。/);
  assert.match(html, /34種の構成法/);
  assert.match(html, /PixVerse、Kling、Seedance/);
  assert.match(html, /Codex AutomationやClaudeが昇格候補として整理/);
  assert.match(html, /確認画面はブラウザで開くローカルViewerを使います/);
  assert.match(html, /CodexまたはClaude CodeでTsugiteのフォルダを選びます/);
  assert.match(html, /通知を入口に、学びを育てる/);
  assert.match(html, /承認だけでルールが自動変更されることはありません/);
  assert.match(html, /長尺・大量の動画解析は、利用量にご注意ください/);
  assert.match(html, /Codex／Claude側のコンテキストやトークンを多く使用する場合があります/);
  assert.match(html, /生成サービスのcreditsとは別に確認してください/);
  assert.match(html, /Desktopアプリの一般配布は終了しました/);
  assert.match(html, /今後は最新版のソースと、Codex／Claude Codeを使うローカルワークフローを提供します/);
  assert.match(html, /TSUGITE \/ KEY VISUAL/);
  assert.match(html, /生成と判断を、ひとつの工程に継ぐ。/);
  assert.match(html, /https:\/\/github\.com\/Takamasa045\/tsugite\/releases\/tag\/v0\.6\.0/);
  assert.match(html, /GitHubのSource codeを取得してください/);
  assert.doesNotMatch(html, /releases\/download|\.dmg|\.exe|Mac版をダウンロード|Windows版をダウンロード/);
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

test("highlights the latest release and keeps the third summer camp update", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /id="pickup"/);
  assert.match(html, /Tsugite<br\s*\/>v0\.6\.0/);
  assert.doesNotMatch(html, /Tsugite<br\s*\/>v0\.6\.0 Beta 2/);
  assert.match(html, /v0\.6\.0 タグを公開しました/);
  assert.match(html, /2026年7月23日 タグ作成/);
  assert.match(html, /LATEST TAG/);
  assert.match(html, /https:\/\/github\.com\/Takamasa045\/tsugite\/releases\/tag\/v0\.6\.0/);
  assert.match(html, /複数の手持ち動画から構成案を最大3案提示/);
  assert.match(html, /Mac／Windows向けインストーラーの一般配布は終了しました/);
  assert.match(html, /CodexまたはClaude Codeから利用する方法を案内します/);
  assert.match(html, /第3回目、全部で3回やります。/);
  assert.match(html, /2026年8月11日（火）21:00/);
  assert.match(html, /<details[^>]*class="pickup-history"/);
  assert.match(html, /<summary>[^<]*<span>前の更新を見る（3件）<\/span>/);
  assert.match(html, /第2回｜2026年8月4日（火）21:00/);
  assert.match(html, /第1回｜2026年7月28日（火）21:00/);
  assert.match(html, /https:\/\/brain-market\.com\/u\/itopan\/a\/b1kjM3UjMgoTZsNWa0JXY/);
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
  assert.match(page, /id="start"/);
  assert.match(page, /id="knowledge"/);
  assert.match(page, /id="workspace"/);
  assert.match(page, /id="pickup"/);
  assert.match(page, /<details className="pickup-history">/);
  assert.match(page, /MAKE \/ CODEX・CLAUDE CODE/);
  assert.doesNotMatch(page, /platform-download|MAC_DOWNLOAD_URL|WINDOWS_DOWNLOAD_URL|APPLE_SUPPORT_URL|MICROSOFT_SUPPORT_URL/);
  assert.match(layout, /generateMetadata/);
  assert.match(layout, /summary_large_image/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /url\("\/og\.png"\)/);
  assert.match(css, /\.key-visual/);
  assert.match(css, /\.knowledge-section/);
  assert.match(css, /\.hybrid-roles/);
  assert.match(css, /\.pickup-section/);
  assert.match(css, /\.pickup-history\[open\]/);
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
  assert.doesNotMatch(css, /\.platform-download|\.download-state|\.windows-icon/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton|drizzle/);
  await assert.rejects(
    access(new URL("../app/_sites-preview", import.meta.url)),
    (error) => error?.code === "ENOENT",
  );
});
