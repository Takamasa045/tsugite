const RELEASE_TAG = "v0.6.0-beta.1";
const RELEASE_URL = `https://github.com/Takamasa045/tsugite/releases/tag/${RELEASE_TAG}`;
const REPOSITORY_URL = "https://github.com/Takamasa045/tsugite";
const FEEDBACK_URL = `${REPOSITORY_URL}/issues/new`;
const MAC_DOWNLOAD_URL = `${REPOSITORY_URL}/releases/download/${RELEASE_TAG}/Tsugite-0.6.0-macos-arm64.dmg`;
const WINDOWS_DOWNLOAD_URL = `${REPOSITORY_URL}/releases/download/${RELEASE_TAG}/Tsugite-0.6.0-windows-x64-setup.exe`;
const APPLE_SUPPORT_URL = "https://support.apple.com/guide/mac-help/open-an-app-by-overriding-security-settings-mh40617/mac";
const MICROSOFT_SUPPORT_URL = "https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions";

const gates = [
  {
    gate: "GATE 1",
    title: "つくる前に、決める。",
    copy: "構成と絵コンテを見て、方向性を承認してから素材生成へ。アイデアの段階で手戻りを止めます。",
    state: "PLAN / REVIEW",
  },
  {
    gate: "GATE 2",
    title: "素材を見て、選ぶ。",
    copy: "生成された映像・画像・音声を確認。採用する素材が揃ってから、一本の映像に組み上げます。",
    state: "ASSET / QC",
  },
  {
    gate: "GATE 3",
    title: "完成を見て、決める。",
    copy: "黒画面や無音も含めて最終チェック。人が完成を承認するまで、制作は終わりません。",
    state: "FINAL / APPROVE",
  },
] as const;

export default function Home() {
  return (
    <main>
      <section className="hero" id="top">
        <nav className="nav" aria-label="メインナビゲーション">
          <a className="brand" href="#top" aria-label="Tsugite トップへ">
            {/* eslint-disable-next-line @next/next/no-img-element -- Pre-optimized local product mark. */}
            <img className="brand-icon" src="/favicon.png" width="46" height="46" alt="" aria-hidden="true" />
            <span className="brand-copy">
              <strong>TSUGITE</strong>
              <small>AI VIDEO WORKSHOP</small>
            </span>
          </a>
          <div className="nav-links">
            <a href="#workflow">制作工程</a>
            <a href="#download">ダウンロード</a>
            <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">
              GitHub <span aria-hidden="true">↗</span>
            </a>
          </div>
        </nav>

        <div className="hero-grid">
          <div className="hero-copy">
            <div className="release-line">
              <span>DESKTOP APP</span>
              <b>v0.6.0 Beta</b>
              <em>未署名ベータ</em>
            </div>
            <h1>
              映像づくりを、
              <span>組み上げる。</span>
            </h1>
            <p className="hero-lead">
              制作案件を見渡す。テンプレートを選ぶ。3D Viewerで工程を確かめる。
              <br />
              Tsugite Desktopの最初のベータ版を、MacとWindowsへ。
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href={MAC_DOWNLOAD_URL} aria-label="Mac版をダウンロード。Apple silicon、DMG、未署名ベータ">
                <span>Mac版をダウンロード</span>
                <b aria-hidden="true">↓</b>
              </a>
              <a className="text-link" href={WINDOWS_DOWNLOAD_URL} aria-label="Windows版をダウンロード。x64、EXE、未署名ベータ">
                Windows版をダウンロード <span aria-hidden="true">↓</span>
              </a>
            </div>
            <p className="availability">
              <span aria-hidden="true" /> 無料ベータ版・コード署名なし。macOS Apple silicon / Windows x64
            </p>
          </div>

          <figure className="product-screen">
            <div className="product-screen-frame">
              <picture>
                <source srcSet="/launcher-screen.avif" type="image/avif" />
                <source srcSet="/launcher-screen.webp" type="image/webp" />
                <img
                  src="/launcher-screen.jpg"
                  width="1280"
                  height="720"
                  alt="Tsugiteランチャーの実画面。制作案件の総数、進行中、確認待ち、完了の状況と制作棚を表示しています。"
                  fetchPriority="high"
                  decoding="async"
                />
              </picture>
            </div>
            <figcaption>
              <span>ACTUAL PRODUCT / v0.6.0 BETA</span>
              <p>
                <strong>現行ランチャーの実画面</strong>
                <small>ローカルの制作案件を実データで表示</small>
              </p>
            </figcaption>
          </figure>
        </div>

        <div className="hero-specs" aria-label="Tsugiteの特徴">
          <div><small>01 / OVERVIEW</small><strong>制作案件を一覧で確認</strong></div>
          <div><small>02 / TEMPLATE</small><strong>制作テンプレートを参照</strong></div>
          <div><small>03 / VIEWER</small><strong>3Dで工程を見渡す</strong></div>
        </div>
      </section>

      <section className="statement" aria-labelledby="statement-title">
        <div className="section-label"><span>THE CRAFT</span><i /></div>
        <div className="statement-grid">
          <h2 id="statement-title">
            AIに任せきらない。
            <br />
            <span>人の判断を、工程にする。</span>
          </h2>
          <div>
            <p>
              速さだけでは、いい映像は生まれません。Tsugiteは、構成・素材・完成の節目に人の判断を残します。
              だから、AIを使っても制作意図が抜け落ちません。
            </p>
            <p>
              選んだ理由も、やり直した理由も、次のテンプレートやチェックへ。使うほど、あなたの工房になっていきます。
            </p>
          </div>
        </div>
      </section>

      <section className="key-visual" aria-label="木組みと制作工程を重ねたTsugiteのキービジュアル">
        <div className="key-visual-caption">
          <span>TSUGITE / KEY VISUAL</span>
          <p>生成と判断を、ひとつの工程に継ぐ。</p>
        </div>
      </section>

      <section className="workflow-section" id="workflow" aria-labelledby="workflow-title">
        <header className="section-heading">
          <div>
            <span className="kicker">WORKFLOW DESIGN / BETA VIEWER</span>
            <h2 id="workflow-title">止まるから、迷わない。</h2>
          </div>
          <p>このベータ版では工程を3D Viewerで確認できます。生成・実行操作は今後のアップデートで追加します。</p>
        </header>

        <div className="gate-list">
          {gates.map((item, index) => (
            <article className="gate-card" key={item.gate}>
              <div className="gate-number"><span>0{index + 1}</span><small>{item.gate}</small></div>
              <div className="gate-card-copy"><h3>{item.title}</h3><p>{item.copy}</p></div>
              <div className="gate-state"><span>{item.state}</span><i aria-hidden="true" /></div>
            </article>
          ))}
        </div>
      </section>

      <section className="tools-section" aria-labelledby="tools-title">
        <div className="tools-copy">
          <span className="kicker">ROADMAP / NOT IN THIS BETA</span>
          <h2 id="tools-title">生成する道具は、<br />次の継ぎ目へ。</h2>
          <p>
            動画・画像・音声を生成するランチャーと生成ノードは、今回のベータ版には含まれていません。安全な実行境界と操作フローを整えたうえで、今後のアップデートで追加予定です。
          </p>
          <div className="tool-tags" aria-label="対応する制作領域">
            <span>NEXT / GENERATION NODES</span><span>PROVIDER CONNECTION</span><span>GATED RUN</span>
          </div>
        </div>
        <div className="joinery-diagram" aria-hidden="true">
          <div className="beam beam-horizontal"><span>NEXT UPDATE</span></div>
          <div className="beam beam-vertical"><span>REVIEW</span></div>
          <div className="joint-core"><i /><b>TSUGITE</b></div>
          <small className="diagram-label label-input">TOOLS IN</small>
          <small className="diagram-label label-output">FILM OUT</small>
        </div>
      </section>

      <section className="download-section" id="download" aria-labelledby="download-title">
        <div className="download-topline"><span>DOWNLOAD / v0.6.0 BETA 1</span><i /></div>
        <div className="download-grid">
          <div className="download-copy">
            <h2 id="download-title">Macにも、Windowsにも、<br />映像制作の工房を。</h2>
            <p>
              制作案件の一覧、制作テンプレート、3D Viewerなど、制作を整理して確認する機能を先行してお試しいただけます。
            </p>
            <aside className="beta-notice" aria-labelledby="beta-notice-title">
              <span>IMPORTANT / BETA SCOPE</span>
              <h3 id="beta-notice-title">未署名ベータ版について</h3>
              <p>本ベータ版はMac・Windowsともにコード署名を行っていません。Mac版はAppleの公証（notarization）も未実施です。初回起動時にOSの警告が表示されます。</p>
              <p>動画生成などを行う生成ランチャー／生成ノード機能は、今回のベータ版には含まれていません。後日あらためて実装・提供予定です。</p>
            </aside>
            <a className="button button-light" href={RELEASE_URL} target="_blank" rel="noreferrer">
              <span>リリース詳細とSHA-256</span><b aria-hidden="true">↗</b>
            </a>
            <small className="download-note">公式GitHub Releaseからのみ取得し、リリースノートのファイル名とSHA-256を確認してください。一致しない場合は起動せず削除してください。</small>
          </div>

          <div className="platform-list">
            <a className="platform-card platform-download" href={MAC_DOWNLOAD_URL} aria-label="Mac版をダウンロード。Apple silicon arm64、DMG、未署名ベータ">
              <div><span className="platform-icon" aria-hidden="true">⌘</span><p><strong>macOS</strong><small>macOS 12+ · Apple silicon (arm64) · DMG</small></p></div>
              <span className="download-state"><small>UNSIGNED BETA</small><b>ダウンロード ↓</b></span>
            </a>
            <a className="platform-card platform-download" href={WINDOWS_DOWNLOAD_URL} aria-label="Windows版をダウンロード。x64、EXE、未署名ベータ">
              <div><span className="platform-icon windows-icon" aria-hidden="true"><i /><i /><i /><i /></span><p><strong>Windows</strong><small>Windows 10+ · x64 · EXE</small></p></div>
              <span className="download-state"><small>UNSIGNED BETA</small><b>ダウンロード ↓</b></span>
            </a>
            <a className="platform-card platform-github" href={REPOSITORY_URL} target="_blank" rel="noreferrer">
              <div><span className="platform-icon">⌁</span><p><strong>GitHub</strong><small>Source & release notes</small></p></div>
              <span className="platform-arrow" aria-hidden="true">↗</span>
            </a>
          </div>
        </div>

        <section className="security-guide" aria-labelledby="security-title">
          <header>
            <span>FIRST LAUNCH / SECURITY</span>
            <h3 id="security-title">初回起動の前に、必ずご確認ください。</h3>
            <p>OSの保護機能を常時無効にする必要はありません。公式ReleaseとSHA-256を確認し、内容を理解できる場合だけ実行してください。</p>
          </header>
          <div className="security-grid">
            <article>
              <span>01 / macOS</span>
              <h4>Macで初めて開くとき</h4>
              <ol>
                <li>DMGを開き、Tsugiteを「アプリケーション」へ移動します。</li>
                <li>一度Tsugiteを開き、警告が表示されたら閉じます。</li>
                <li>「システム設定」→「プライバシーとセキュリティ」で、出所を再確認してから「このまま開く」を選びます。</li>
              </ol>
              <a href={APPLE_SUPPORT_URL} target="_blank" rel="noreferrer">Apple公式の案内を見る <span aria-hidden="true">↗</span></a>
            </article>
            <article>
              <span>02 / Windows</span>
              <h4>Windowsで初めて開くとき</h4>
              <ol>
                <li>インストーラーのファイル名とSHA-256を確認して起動します。</li>
                <li>警告が表示された場合は、発行元が未確認であることを理解したうえで判断してください。</li>
                <li>Smart App Controlや組織のポリシーでブロックされた場合は、保護機能を無効化せず起動を中止してください。</li>
              </ol>
              <a href={MICROSOFT_SUPPORT_URL} target="_blank" rel="noreferrer">Microsoft公式の案内を見る <span aria-hidden="true">↗</span></a>
            </article>
          </div>
          <div className="feedback-line">
            <p>不具合報告には、アプリのバージョン、OS、発生した操作を添えてください。APIキー・個人情報・制作素材は送らないでください。</p>
            <a href={FEEDBACK_URL} target="_blank" rel="noreferrer">不具合・ご意見を送る <span aria-hidden="true">↗</span></a>
          </div>
        </section>
      </section>

      <footer>
        <a className="brand footer-brand" href="#top">
          {/* eslint-disable-next-line @next/next/no-img-element -- Pre-optimized local product mark. */}
          <img className="brand-icon" src="/favicon.png" width="38" height="38" alt="" aria-hidden="true" />
          <span className="brand-copy"><strong>TSUGITE</strong><small>AI VIDEO WORKSHOP</small></span>
        </a>
        <p>映像づくりを、組み上げる。</p>
        <div><a href={REPOSITORY_URL} target="_blank" rel="noreferrer">GitHub</a><span>© 2026 AZUMI MUSUHI</span></div>
      </footer>
    </main>
  );
}
