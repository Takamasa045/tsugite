const RELEASE_TAG = "v0.6.0-beta.1";
const RELEASE_URL = `https://github.com/Takamasa045/tsugite/releases/tag/${RELEASE_TAG}`;
const REPOSITORY_URL = "https://github.com/Takamasa045/tsugite";
const LATEST_VERSION_TAG = "v0.6.0";
const LATEST_VERSION_URL = `${REPOSITORY_URL}/tree/${LATEST_VERSION_TAG}`;
const FEEDBACK_URL = `${REPOSITORY_URL}/issues/new`;
const MAC_DOWNLOAD_URL = `${REPOSITORY_URL}/releases/download/${RELEASE_TAG}/Tsugite-0.6.0-macos-arm64.dmg`;
const WINDOWS_DOWNLOAD_URL = `${REPOSITORY_URL}/releases/download/${RELEASE_TAG}/Tsugite-0.6.0-windows-x64-setup.exe`;
const APPLE_SUPPORT_URL = "https://support.apple.com/guide/mac-help/open-an-app-by-overriding-security-settings-mh40617/mac";
const MICROSOFT_SUPPORT_URL = "https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions";
const SUMMER_CAMP_URL = "https://brain-market.com/u/itopan/a/b1kjM3UjMgoTZsNWa0JXY";

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

const knowledgeFeatures = [
  {
    label: "STORY GUIDANCE",
    title: "物語の型を、選ぶ根拠に。",
    copy: "起承転結、三幕構成、広告・解説・MVなど34種の構成法を収録。目的と尺から第一候補、補助候補、不採用理由、尺配分、映像文法を比較します。",
    detail: "34 FRAMEWORKS / 35 FILM PRINCIPLES",
  },
  {
    label: "PROMPT GUIDANCE",
    title: "モデルごとの作法を、計画に。",
    copy: "PixVerse、Kling、SeedanceのT2V／I2V知識を参照し、プロンプトの組み立て、避ける事項、尺や画角の制約を生成前に確認します。",
    detail: "MODEL-AWARE / SOURCE-BACKED",
  },
  {
    label: "LEARNING LOOP",
    title: "判断を、次の制作へ。",
    copy: "案件をまたいで繰り返された好みや学びを、Codex AutomationやClaudeが昇格候補として整理。人が根拠を確認し、承認したものだけを次の改善へ渡します。",
    detail: "REVIEW / NOTIFY / APPROVE",
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
            <a href="#pickup">更新ログ</a>
            <a href="#knowledge">設計知識</a>
            <a href="#workflow">制作工程</a>
            <a href="#workspace">使い方</a>
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
              <em>先行ベータ版</em>
            </div>
            <h1>
              映像づくりを、
              <span>組み上げる。</span>
            </h1>
            <p className="hero-lead">
              Codex／Claude Codeでつくる。Desktopで見て決める。
              <br />
              ハイブリッドに、依頼と確認を同じ制作フォルダでつなぎます。
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href={MAC_DOWNLOAD_URL} aria-label="Mac版をダウンロード。Apple silicon、DMG、先行ベータ版">
                <span>Mac版をダウンロード</span>
                <b aria-hidden="true">↓</b>
              </a>
              <a className="text-link" href={WINDOWS_DOWNLOAD_URL} aria-label="Windows版をダウンロード。x64、EXE、先行ベータ版">
                Windows版をダウンロード <span aria-hidden="true">↓</span>
              </a>
            </div>
            <p className="availability">
              <span aria-hidden="true" /> 先行ベータ版。macOS Apple silicon / Windows x64
            </p>
          </div>

          <div
            className="hero-motion"
            role="img"
            aria-label="構成を描き、素材を選び、映像を組み上げる。選ぶほど、自分好みの制作環境に育ってくる工程を表すアニメーション"
          >
            <div className="motion-stage" aria-hidden="true">
              <div className="motion-topline"><span>TSUGITE / ROUGH CUT TO CRAFT</span><i /><b>00:14</b></div>
              <div className="motion-film"><i /><i /><i /><i /></div>
              <div className="motion-build">
                <i className="motion-part motion-part-base" />
                <i className="motion-part motion-part-left" />
                <i className="motion-part motion-part-right" />
                <i className="motion-part motion-part-cap" />
                <i className="motion-lock" />
              </div>
              <p className="motion-copy motion-copy-compose"><small>01 / COMPOSE</small><strong>構成を、<em>描く。</em></strong></p>
              <p className="motion-copy motion-copy-select"><small>02 / SELECT</small><strong>素材を、<em>選ぶ。</em></strong></p>
              <p className="motion-copy motion-copy-assemble"><small>03 / ASSEMBLE</small><strong>映像を、<br /><em>組み上げる。</em></strong></p>
              <p className="motion-copy motion-copy-grow"><small>04 / GROW</small><strong>選ぶほど、<em>自分好みに<br />育ってくる。</em></strong></p>
              <div className="motion-footer"><span>INTENT</span><i /><span>JUDGMENT</span><i /><span>YOUR CRAFT</span></div>
            </div>
          </div>
        </div>

        <div className="hero-specs" aria-label="Tsugiteの特徴">
          <div><small>01 / OVERVIEW</small><strong>制作案件を一覧で確認</strong></div>
          <div><small>02 / TEMPLATE</small><strong>制作テンプレートを参照</strong></div>
          <div><small>03 / VIEWER</small><strong>3Dで工程を見渡す</strong></div>
        </div>
      </section>

      <section className="pickup-section" id="pickup" aria-labelledby="pickup-title">
        <div className="pickup-topline">
          <span>UPDATE LOG / TSUGITE RELEASES</span>
          <i />
          <time dateTime="2026-07-23">2026.07.23 UPDATE</time>
        </div>

        <article className="pickup-current">
          <div className="pickup-number" aria-hidden="true">
            <span>06</span>
            <small>LATEST TAG / v0.6.0</small>
          </div>
          <div className="pickup-copy">
            <p className="pickup-status"><span aria-hidden="true" /> v0.6.0 タグを公開しました</p>
            <h2 id="pickup-title">Tsugite<br />v0.6.0</h2>
            <p className="pickup-date">
              <time dateTime="2026-07-23">2026年7月23日 タグ作成</time>
              <span>LATEST TAG</span>
            </p>
            <p className="pickup-description">
              AI映像制作をより安全に進めやすくする更新を含む、現在のソースタグです。生成・確認・セットアップまわりを中心に更新しました。
            </p>
            <ul className="pickup-features">
              <li>PixVerse・Kling・TopViewの生成経路を追加</li>
              <li>CLIヘルプと初回セットアップの案内を改善</li>
              <li>Desktopの作業フォルダ復旧、Windows対応、安全性を強化</li>
            </ul>
            <aside className="pickup-beta-note">
              <strong>Desktopアプリ版について</strong>
              <p>アプリ版は現在も先行ベータで、不安定な挙動が残っています。安定運用にはまだ向かないため、新しい体験を試してみたい方だけお使いください。</p>
            </aside>
            <a className="pickup-link" href={LATEST_VERSION_URL} target="_blank" rel="noreferrer">
              GitHubで v0.6.0 タグを見る <span aria-hidden="true">↗</span>
            </a>
          </div>
        </article>

        <details className="pickup-history">
          <summary><span>前の更新を見る（3件）</span><i aria-hidden="true">＋</i></summary>
          <div className="pickup-history-list">
            <article>
              <span>03 / 2026.07.22</span>
              <h3>第3回目、全部で3回やります。</h3>
              <p>2026年8月11日（火）21:00。最終夜は、一本を完成させ、次の一本が作りやすい環境へ育てます。</p>
              <a href={SUMMER_CAMP_URL} target="_blank" rel="noreferrer">Brainで全3回の内容を見る <span aria-hidden="true">↗</span></a>
            </article>
            <article>
              <span>02 / PREVIOUS UPDATE</span>
              <h3>第2回｜2026年8月4日（火）21:00</h3>
              <p>キャラクターと生成素材を、一本の制作案件へつなぐ夜。Shitateからの取り込みと、AI動画・音楽・AI音声を編集工程へ渡す流れを扱います。</p>
            </article>
            <article>
              <span>01 / PREVIOUS UPDATE</span>
              <h3>第1回｜2026年7月28日（火）21:00</h3>
              <p>テンプレートから、最初の一本を自分のPCで動かす夜。キャラクター、台本、画像、音声を差し替え、無料プレビューまで進めます。</p>
            </article>
          </div>
        </details>
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

      <section className="knowledge-section" id="knowledge" aria-labelledby="knowledge-title">
        <header className="knowledge-heading">
          <div>
            <span className="kicker">CREATIVE KNOWLEDGE IN THE REPOSITORY</span>
            <h2 id="knowledge-title">思いつきだけで、<br />構成しない。</h2>
          </div>
          <div className="knowledge-intro">
            <p>
              リポジトリ側のTsugiteワークフローは、物語構成・映像文法・生成モデル別のプロンプト知識を、企画とGate 1前のレビューで参照します。
              型を自動で押しつけるのではなく、なぜその設計にするのかを比べて、人が選べるようにします。
            </p>
            <small>知識カタログは設計支援です。生成サービスの契約や実行可否とは分けて確認します。</small>
          </div>
        </header>
        <div className="knowledge-grid">
          {knowledgeFeatures.map((item, index) => (
            <article className="knowledge-card" key={item.label}>
              <div className="knowledge-card-top"><span>0{index + 1}</span><small>{item.label}</small></div>
              <h3>{item.title}</h3>
              <p>{item.copy}</p>
              <strong>{item.detail}</strong>
            </article>
          ))}
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
              <h3 id="beta-notice-title">ベータ版をご利用になる前に</h3>
              <p>現在は先行ベータ版です。初回起動時に、MacやWindowsの確認画面が表示される場合があります。画面の案内をご確認のうえお試しください。</p>
              <p>動画生成などを行う生成ランチャー／生成ノード機能は、今回のベータ版には含まれていません。後日あらためて実装・提供予定です。</p>
            </aside>
            <a className="button button-light" href={RELEASE_URL} target="_blank" rel="noreferrer">
              <span>リリース内容を見る</span><b aria-hidden="true">↗</b>
            </a>
            <small className="download-note">初回起動の手順は、下記の案内をご確認ください。</small>
          </div>

          <div className="platform-list">
            <a className="platform-card platform-download" href={MAC_DOWNLOAD_URL} aria-label="Mac版をダウンロード。Apple silicon arm64、DMG、先行ベータ版">
              <div><span className="platform-icon" aria-hidden="true">⌘</span><p><strong>macOS</strong><small>macOS 12+ · Apple silicon (arm64) · DMG</small></p></div>
              <span className="download-state"><small>EARLY BETA</small><b>ダウンロード ↓</b></span>
            </a>
            <a className="platform-card platform-download" href={WINDOWS_DOWNLOAD_URL} aria-label="Windows版をダウンロード。x64、EXE、先行ベータ版">
              <div><span className="platform-icon windows-icon" aria-hidden="true"><i /><i /><i /><i /></span><p><strong>Windows</strong><small>Windows 10+ · x64 · EXE</small></p></div>
              <span className="download-state"><small>EARLY BETA</small><b>ダウンロード ↓</b></span>
            </a>
            <a className="platform-card platform-github" href={REPOSITORY_URL} target="_blank" rel="noreferrer">
              <div><span className="platform-icon">⌁</span><p><strong>GitHub</strong><small>Source & release notes</small></p></div>
              <span className="platform-arrow" aria-hidden="true">↗</span>
            </a>
          </div>
        </div>

        <section className="workspace-guide" id="workspace" aria-labelledby="workspace-guide-title">
          <header className="workspace-guide-heading">
            <span>DESKTOP + CODEX / CLAUDE CODE</span>
            <h3 id="workspace-guide-title">アプリとエージェントで、<br />ひとつの制作環境。</h3>
            <p>
              Desktopは案件・工程・承認を確認する画面。企画や実際の生成・編集の依頼は、これまで通りTsugiteリポジトリを開いたCodex／Claude Codeから進めます。
            </p>
          </header>

          <div className="hybrid-roles" aria-label="Tsugiteのハイブリッドな役割分担">
            <article>
              <small>MAKE / CODEX・CLAUDE CODE</small>
              <h4>いつもの対話から、制作を頼む。</h4>
              <p>Tsugiteリポジトリを開き、「この動画を作りたい」と依頼。物語構成やモデル別のプロンプト知識を参照しながら、企画、検証、生成・編集の手順を進めます。</p>
            </article>
            <i aria-hidden="true">↔</i>
            <article>
              <small>REVIEW / TSUGITE DESKTOP</small>
              <h4>アプリで、見て決める。</h4>
              <p>同じ案件をDesktopで開き、制作案件、テンプレート、3D Viewer、好み・学びの候補を確認。現在のベータ版は、この確認体験を先行して提供します。</p>
            </article>
          </div>

          <ol className="start-steps" aria-label="Tsugiteを始める4ステップ">
            <li><span>01</span><p><strong>アプリをダウンロード</strong><small>上のMac版またはWindows版を選びます。</small></p></li>
            <li><span>02</span><p><strong>リポジトリを取得</strong><small>GitHubからTsugiteをcloneします。</small></p></li>
            <li><span>03</span><p><strong>同じrepo rootを開く</strong><small>Codex／Claude CodeとDesktopで同じフォルダを選びます。</small></p></li>
            <li><span>04</span><p><strong>対話から制作を依頼</strong><small>生成はエージェントへ依頼し、節目をDesktopで確認します。</small></p></li>
          </ol>

          <div className="learning-notice">
            <span>OPTIONAL AUTOMATION</span>
            <p>
              <strong>通知を入口に、学びを育てる。</strong>
              Codex Automation、Claude Desktop／CoworkのScheduled task、Claude Codeの反復実行を設定すると、繰り返された好みや学びの候補を自動で整理できます。
              対応する標準通知を有効にして結果を受け取り、Desktopで根拠を見て承認します。承認だけでルールが自動変更されることはありません。
            </p>
          </div>

          <div className="workspace-guide-actions">
            <a className="button button-dark" href={REPOSITORY_URL} target="_blank" rel="noreferrer">
              <span>2. GitHubリポジトリを取得</span><b aria-hidden="true">↗</b>
            </a>
            <p>アプリ単体でも確認画面は開けます。Codex／Claude Codeと制作する場合は、リポジトリを取得し、両方で同じrepo rootを選んでください。</p>
          </div>
        </section>

        <section className="security-guide" aria-labelledby="security-title">
          <header>
            <span>FIRST LAUNCH / SECURITY</span>
            <h3 id="security-title">初回起動の前に、必ずご確認ください。</h3>
            <p>初回起動時に、MacやWindowsの確認画面が表示される場合があります。画面の案内と下記の手順をご確認ください。</p>
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
                <li>ダウンロードしたインストーラーを起動します。</li>
                <li>確認画面が表示されたら、内容をご確認のうえ進めてください。</li>
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
