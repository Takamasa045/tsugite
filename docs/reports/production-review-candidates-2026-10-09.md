# Historical production observations awaiting promotion review

Source: [PR #183](https://github.com/Takamasa045/tsugite/pull/183), commit `0dd99949be2dc4941c58a66c662cbb0e3400be3d`. These five statements are preserved verbatim from the production draft; their `qa済` labels describe that historical report, not validation performed during this cleanup. They are **not shared production rules** and have not been appended to LESSONS.md.

Audio offsets, color conversion, browser cache layout and attachment limits depend on the runtime, input and delivery channel. Reproduce against a contained fixture and review applicability before promoting any rule. In particular, never blindly shift audio or override human Gate approval from this document. The complete original branch history is also retained; closing the draft does not erase it.

> 2026-10-09 / 告知アニメのpipeline renderがRemotionのChrome取得(remotion.media)の403で失敗した / サンドボックスの許可リストに取得先が無く、remotion backendはbrowserExecutableを受け取らず既定の取得経路しか持たない / ネットワーク制限下ではrender前に取得先を許可するか、事前導入のヘッドレスシェルをnode_modules/.remotion/chrome-headless-shell/(VERSIONとlinux64/chrome-headless-shell-linux64/chrome-headless-shell)へ置いてから実行し、リポジトリのコードは変えない / qa済

> 2026-10-09 / pipeline renderの最終mp4だけ音が制作マスターより42.67ms(2048サンプル)遅れた / Remotion経由の音声が先頭2048サンプルを無音で残し、出力のaudio edit list(media_time=0)で相殺されない / 完成済みマスターをpassthroughする案件はGate 3前に最終mp4の音声をスコアとの相互相関で測り、許容外なら入力マスターの音声を遅延分だけ先行させて承認をやり直すか、遅延を明示して承認を得る / qa済

> 2026-10-09 / ループ前提の告知動画で最終フレームにエンドカードの文字が14%残り先頭フレームにつながらなかった / フェードアウトの終了を動画末尾に合わせ、最後のフレームまで内容が残った / ループ動画は最後の0.2秒を先頭フレームと同じ絵だけにし、先頭・末尾フレームの低周波差を計測して確認する / qa済

> 2026-10-09 / Remotion出力のmp4がyuvj420p・色空間タグなしで、再生環境により色相が僅かにずれ得た / ChromeのJPEGスクリーンショット(フルレンジBT.601)をそのままエンコードし、色空間を明示していなかった / 配布用の最終エンコードはscale=in_color_matrix=bt601:in_range=pc:out_color_matrix=bt709:out_range=tvでBT.709リミテッドへ変換して色タグを付け、ffprobeでpix_fmtとcolor_rangeを確認する / qa済

> 2026-10-09 / 99MBと72MBのmp4がチャット添付の上限(30MiB)で届けられなかった / 納品形式を決める時点で添付上限を確認せず、共有用コピーを最初から作らなかった / 動画を渡す案件は納品形式を決める時点で上限を確認し、上限の9割以内の2パス共有用コピー(音声はコピー)を同時に作る / qa済
