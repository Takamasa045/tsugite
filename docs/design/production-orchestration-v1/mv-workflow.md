# MV Workflow

## 1. 位置付け

MVをtemplateの一種ではなく、Music / Lyrics / Visual / Identity / Generation / Editが交差する第一級Production typeとして扱う。

IdentityはMVのrootではない。

| MV種別 | Music | Lyrics | Identity |
| --- | --- | --- | --- |
| 抽象・コンセプトMV | 必須 | 任意 | 通常不要 |
| 歌詞MV | 必須 | 必須 | 通常不要 |
| キャラクターMV | 必須 | 任意 | 必須 |
| パフォーマンスMV | 必須 | 任意 | 出演者を生成する場合は必須 |
| 既存素材編集MV | 必須 | 任意 | 生成で人物を追加しなければ不要 |

## 2. 利用者から受け取るもの

最低限:

- 正本となる楽曲、または楽曲を別Productionで作るという選択
- 目標尺・画角・用途
- MVの方向性、または方向性の提案許可

必要時:

- 正本歌詞
- キャラクター／出演者の参照素材
- ロゴ、タイトル、credit
- 使用できる既存映像・画像
- 権利・外部送信の制約

不足情報をAIが事実として補完しない。音源制作そのものが必要なら、MV Mission内で暗黙生成せず、独立Production / Gate /費用承認に分け、MVはpin済み音源digestを参照する。

## 3. Master Timeline と Generation Timeline

長尺楽曲全体の時刻と、4–15秒程度の生成clip内時刻を混ぜない。

```text
Master timeline: 00:48.000–00:58.000  (Chorus内の絶対時刻)
Generation unit: 00:00.000–00:10.000 (H3 clip内の相対時刻)
```

各GenerationUnitは[contracts.md](./contracts.md)のstrictな`GenerationUnitContractV1`である。MVでは必須で、単なる補足metadataにしない。

```yaml
id: chorus-01-clip-02
program_start_ms: 48000
program_end_ms: 58000
clip_duration_ms: 10000
section_id: chorus-01
beat_anchor_ids: [beat-097, beat-101]
lyric_cue_ids: [lyric-016, lyric-017]
route_digest: ...
unit_digest: ...
```

compilerは`0 <= start < end <= master duration`、`program_end_ms - program_start_ms == clip_duration_ms == target.duration_ms`、section / beat / cueの所属revisionをhard validationする。GenerationUnitはVideoPromptIrを逆参照せず、VideoPromptIr側がunit digestをbindするため循環digestは生じない。H3 promptへはclip-local timestampだけを出し、master timestamp、unit digest、ordinalをlineage / Gate bundle / edit planへ保持する。

## 4. Audio Policy

MVで最も危険なのは、完成済みmaster音源とvideo modelのnative audioを曖昧に混ぜることである。GenerationUnitごとに次のいずれかを必須指定する。

### `reuse-master`

完成済み楽曲MVの既定。

- final audioはMusicStructureContractのmaster音源を1:1で使用する。
- 生成clipのnative audioは最終editに採用しない。
- 歌詞cueは映像モチーフと編集cueに使えるが、H3へ歌唱内容として自動投入しない。
- `non_diegetic_music`は、選択routeが無音生成を表現できる場合は`N/A`。できない場合はgenerated audioを破棄するedit contractを明示する。

### `reference-only`

- 音源のリズム、音色、声をgeneration referenceとして使う。
- source signalをfinalへコピーするかどうかは別に宣言する。
- master全体を暗黙送信せず、GenerationUnitの区間から作ったsource digest付きderived audio assetをpinする。
- providerへ音声assetを送るため、AssetContractのexternal-sendとGate 1確認が必要。

### `native-generated`

- video modelが生成する音声・歌唱を採用する。
- 歌詞、speaker/singer、language、continuityをVideo Prompt IRへ明示する。
- master音源との同時採用は禁止。必要なら別trackとして明示mixする。
- lyricsの外部送信、費用、model capabilityをGate 1で確認する。

### `silent`

- 完全無音clipを要求し、後工程でもmaster音源を使わない特殊用途。

## 5. Lyrics Policy

同じ歌詞を三つの用途に分ける。

1. `caption-overlay`: Remotion / edit層で表示する正確な字幕。
2. `story-cue`: 意味や区切りを映像モチーフへ反映する。
3. `generated-singing`: H3等に歌唱させるexact text。

`caption-overlay`だけのcueを、H3のon-screen textやgenerated singingへ自動転用しない。video model内の文字描画を字幕正本にしない。

歌詞はcanonical sourceのUTF-8 byte span、occurrence id、text digestで固定する。timed cueだけがstart/endを持ち、unaligned cueへ架空時刻を入れない。同じ一行が繰り返されても別occurrenceとして扱う。歌詞時刻が未確認なら、字幕焼き込みとlip-sync判定を`awaiting_human`または`blocked`にする。

## 6. Task Tree Template

```text
MV Production
├── Definition
│   ├── Asset provenance / pin
│   ├── Music analysis
│   ├── Lyrics alignment                 [必要時]
│   └── Identity definition              [必要時]
├── Creative
│   ├── story-guides selection
│   ├── treatment candidates
│   ├── visual system
│   └── section plan
├── Gate 1 review
├── Execution
│   ├── Intro branch
│   │   ├── shot plans
│   │   ├── generation units
│   │   └── branch critique
│   ├── Verse branch
│   ├── Chorus branch
│   └── Outro branch
├── Edit
│   ├── master-audio placement
│   ├── clip assembly
│   ├── caption overlay
│   └── title / credits
├── Gate 2
├── explicit render
├── Gate 3 QA
└── closeout / learning
```

Music / Lyrics / Identity taskは必要条件を満たしたときだけ作る。section名は楽曲に存在するものを使い、必ずIntro / Verse / Chorusへ当てはめない。

## 7. 自然言語での実際の流れ

1. 利用者が「この曲で、夜の街を舞台にした歌詞MVを作って」と依頼する。
2. Tsugiteは音源をpinし、尺と技術情報を確認する。歌詞があれば正本を確認する。
3. Music roleがBPM、beat、section候補を証拠付きで提案する。解析不能な箇所はunknownのままにする。
4. Story roleがMV向けstory guideを比較し、treatmentを2–3案提案する。
5. 人物が継続登場する案だけ、IdentityDefinitionContractの声・外見・仕草・場所を人間確認する。
6. Visual roleがsectionごとの役割とshot案を作る。
7. reviewでmaster音源、歌詞、Identity、生成clip、model、connection、費用、限定再生成範囲をまとめ、Gate 1を一度確認する。
8. Intro / Verse / Chorusなどの枝を実行する。pure planningは並行可能だが、外部submitはCoordinatorが直列管理する。
9. Criticは各clipを「映像」「Identity」「master timelineへの編集適合性」に分けて検査し、IdentityVerificationReportを人間判断へ渡す。
10. Chorusの1clipだけ失敗した場合、その枝だけをstale化する。事前承認範囲内なら1block変更の再生成を行い、範囲外なら人間へ戻す。
11. Editorがmaster音源へclipと字幕を配置する。
12. Gate 2、明示render、Gate 3で最終確認する。

## 8. H3への分割

H3は一つの長尺MV全体を生成するtruthではない。各GenerationUnitをH3の許可尺・modeへcompileする。

- MusicStructureContract: 曲全体の時刻
- LyricsContract: 曲全体の歌詞cue
- VisualPlan: section / shotの意味
- VideoPromptIrV2: 一つの生成clip
- H3 grammar: そのclipをMiniMax H3向けにserialize
- CompositionPlan: 生成clipをmaster timelineへ配置

beat marker全件や歌詞全文を各promptへ詰め込まない。GenerationUnitが参照するcue idだけを解決し、必要なsemantic cueへ変換する。

## 9. Edit Contract

Gate 1前の配置意図と、生成後にartifactを解決したplanを分ける。

```ts
type MvCompositionIntentV1 = {
  master_audio_digest: Sha256;
  duration_ms: number;
  placements: Array<{
    generation_unit_digest: Sha256;
    track_id: string;
    layer: number;
    timeline_start_ms: number;
    timeline_end_ms: number;
    planned_time_transform:
      | { kind: "none" }
      | {
          kind: "speed";
          source_duration_ms: number;
          timeline_duration_ms: number;
          reason: string;
          decision: HumanDecisionRef;
        };
    blend_policy: "replace" | "overlay" | "crossfade";
  }>;
  required_visual_coverage_intervals: Array<{
    track_id: string;
    start_ms: number;
    end_ms: number;
  }>;
  caption_cue_refs: ContractFragmentRefV1[];
  digest: Sha256;
};

type MvCompositionPlanV1 = {
  composition_intent_digest: Sha256;
  master_audio_asset_id: string;
  master_audio_digest: Sha256;
  duration_ms: number;
  clips: Array<{
    artifact_id: string;
    artifact_digest: Sha256;
    generation_unit_digest: Sha256;
    track_id: string;
    layer: number;
    source_in_ms: number;
    source_out_ms: number;
    timeline_start_ms: number;
    timeline_end_ms: number;
    time_transform:
      | { kind: "none" }
      | {
          kind: "speed";
          source_duration_ms: number;
          timeline_duration_ms: number;
          reason: string;
          decision: HumanDecisionRef;
        };
    blend_policy: "replace" | "overlay" | "crossfade";
    audio_policy: "discard" | "mix" | "replace-master";
  }>;
  captions: Array<{
    lyric_cue_id: string;
    timeline_start_ms: number;
    timeline_end_ms: number;
    style_ref: string;
  }>;
  chapters: Array<{ id: string; start_ms: number; end_ms: number }>;
  digest: Sha256;
};
```

`time_transform=none`では`source_out - source_in == timeline_end - timeline_start`を必須とする。差がある場合は明示speed transformと人間decisionを必要とする。

speedの規約:

```text
source_duration_ms   = source_out_ms - source_in_ms
timeline_duration_ms = timeline_end_ms - timeline_start_ms
playback_rate        = source_duration_ms / timeline_duration_ms
```

- durationは正のsafe integerとし、`NaN`、無限、0、負数を拒否する。
- Intentの`source_duration_ms`はbound GenerationUnitの`clip_duration_ms`、`timeline_duration_ms`は配置区間長と一致させる。
- resolved Planはsource / timeline実区間と各durationが一致し、transform kind、二つのduration、decision subjectがIntentと一致しなければならない。
- selected artifactがこの関係を満たさない場合、ratioを暗黙補正せず、新CompositionIntentとGate 1再承認へ戻す。
- contract比較の許容誤差は0 ms。render後のframe量子化だけは`ceil(1000 / output_fps)` ms以下をQC許容値としてrender reportへ明記し、Plan自体を変更しない。

gap / overlapはtrack単位で検証し、overlapはlayerとblend policyが明示された場合だけ許す。

`reuse-master`では全clipのaudio policyを`discard`にする。master音源の開始・終了を暗黙trimしない。MV GateBundleはCompositionIntent digestとordered GenerationUnit bindingsを固定し、Gate 2はresolved CompositionPlan digestを固定する。

## 10. QA

### Gate 1前

- master音源digest / duration
- Lyrics text / timing digest
- section / beat evidence
- Identity適用判定
- story guideの第一・補助・不採用理由
- generation unitの尺 / mode / connection / model /費用
- caption / audio policy
- recovery grant

### Branch Critic

- clip durationとgeneration unit一致
- shotのgap / overlap / final end
- visual意図と1clip1主動作
- Identity / scene lock
- edit handleの有無
- beat / lyric cueとの意味的対応
- visible textをvideo modelへ誤送信していないか

### Gate 2

- manifest素材の存在とdigest
- newly generated asset / credit
- clipの技術QC
- Identity QAが有効なら人間decision binding
- IdentityVerificationReportのdefinition / selected output digest一致
- master audio / captionsのtimeline整合

### Gate 3

- final映像とmaster音源の尺差
- 音ずれ、clip境界、無音、二重音声
- 歌詞文字・改行・時刻・画面外切れ
- title / credit / fade
- Identityとscene continuity
- canonical final artifact digest

## 11. MV固有の評価指標

- lyric timing coverage
- lyric human correction count
- beat-anchor coverage
- section-to-shot coverage
- A/V duration delta
- duplicate/missing caption cue count
- branch reuse rate
- accepted clipあたりcredit
- first-pass Gate 2 / Gate 3率
- unit binding violation count
- clip timeline gap / overlap count（track別）
- source / timeline duration delta

品質指標は自動Gate承認に使わず、比較と改善の証拠に使う。

## 12. Acceptance Fixtures

最低限、以下をfixture-onlyで持つ。

1. 72秒、master音源再利用、24歌詞cue、4sectionの歌詞MV。
2. キャラクター付きMVでIdentityDefinitionContractとpost-generation verification必須。
3. 抽象MVでIdentity定義なし。
4. 同一歌詞が3回現れるcue。
5. tempo changeを持つ曲。
6. unknown BPMだがmanual sectionだけで編集する曲。
7. Chorus 1枝だけを差し替え、他branch digestが不変なcase。
8. master音源変更で全timeline / edit / QAがstaleになるcase。
9. caption-only lyricsがH3 singing / visible textへ入らないcase。
10. regeneration grant超過で追加submitせず`awaiting_human`になるcase。
11. GenerationUnit欠落、誤順序、区間外cueをそれぞれ拒否するcase。
12. untimed lyricsをexact-sync unitに使わず停止するcase。
13. track overlapの未宣言拒否と、承認済みcrossfadeの許可case。
14. source / timeline尺差を暗黙retimeせず停止するcase。
15. reference audioをunit-local derived assetとしてpinするcase。
