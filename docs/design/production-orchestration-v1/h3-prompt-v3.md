# H3 Prompt Architecture v3

## 1. 目的

H3 / MiniMax H3のprompt品質を改善しながら、provider固有grammarをcoreへ広げず、legacy projectを壊さない。

次期版では次を採用する。

```text
brief / Production contracts
        ↓
VideoPromptIrV2 (provider-neutral semantic truth)
        ↓
semantic validation
        ↓
EffectiveGenerationContract
        ↓
semantic prompt blocks
        ↓
model grammar renderer (H3 grammar v3)
        ↓
adapter dialect / asset binding
        ↓
budget + route + exact-text validation
        ↓
atomic compilation artifact + approval binding
```

`request.h3`はlegacy authoring surface、`request.video_prompt`を次期canonical authoring surfaceとする。両方を別compilerで維持しない。

## 2. 公式仕様とTsugite契約の境界

2026-08-11時点で照合する一次資料:

- [MiniMax H3 repository / pinned commit](https://github.com/MiniMax-AI/MiniMax-H3/tree/8d8824efaf94586c0cc9ac7ad8d0723d4d6420ea)
- [H3 prompt-writing skill](https://github.com/MiniMax-AI/MiniMax-H3/blob/8d8824efaf94586c0cc9ac7ad8d0723d4d6420ea/skills/h3-prompt-writing/SKILL.md)
- [Video Generation V2 API](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)
- [MiniMax official CLI](https://github.com/MiniMax-AI/cli)

公式sourceから採用する構造的事実:

- T2VA / I2VA / FL2VA / L2VA / Ref2VAのmode区別
- base modeの3sectionとreference modeの6section
- first / last frame alignment
- image-to-videoとreference-to-videoの排他
- reference image / video / audio role
- shot timestamp、stable speaker ID、dialogue / lyrics / visible textの原文保持
- audio/videoを含むmultimodal reference

Tsugite独自のもの:

- VideoPromptIr、compiler、validation code、Gate artifact、lineage
- IdentityDefinitionContractV1、MusicStructureContractV1、LyricsContractV1
- model / connection / adapter routeの交差契約
- human Gate、費用承認、recovery grant

MiniMax公式のhosted `H3-Context-IR` とTsugiteのCreative IRは別物である。名前、artifact、品質保証を混同しない。

## 3. 現行v0.9.xの問題

### 3.1 二重compiler

現行には次の二経路がある。

- `request.h3` → H3 compiler → route binding
- `request.video_prompt` → model profile / connection / adapter readiness → renderer

schemaの大部分は共有しているが、knowledge freshness、model profile、connection readiness、lineage、受理条件が一致しない可能性がある。

### 3.2 timeline不足

shotは`start_ms / end_ms`を持つが、gap、overlap、final end、master MV timelineとの対応が第一級契約ではない。

### 3.3 lyricsの意味不足

現行`lyrics?: string`は原文保持されるが、次が無い。

- cue id
- singer / language
- start / end
- cutを跨ぐ継続
- cutoff
- master audio / LyricsContractとのdigest binding
- caption、story cue、generated singingの用途区別

### 3.4 canonical / adapter promptが同一

fieldは分かれているが、現行は同じ文字列である。H3 canonical labelとadapterが要求するlabel / media fieldを別stageで検証できない。

### 3.5 prompt budgetが未結合

local knowledgeには`prompt_max_characters: 7000`があるが、現在の公式V2 API pageはこの値をhard limitとして明記していない。したがって次期版では、catalog値をそのままhard execution limitに昇格しない。

hard / soft limitには、出典、計測単位、connection / route、確認日を必要とする。limitがunknownならunknownとしてreviewへ出す。

### 3.6 H3 reference semanticsが粗い

現行default summary / retentionは簡略で、assetごとのfully-preserved / partial / reference / copy、audio reuse、shot mappingがIR上の明示契約になっていない。

### 3.7 artifactと費用承認の結合不足

IR / prompt / guide hashは存在するが、generation job schemaでcompilation digest、route digest、connection digestを必須bindしていない。

## 4. 単一Authoring Surface

### 4.1 canonical

```yaml
generation:
  requests:
    - id: chorus-shot-01
      video_prompt:
        version: 2
        target: ...
        program_binding: ...
        subjects: ...
        scenes: ...
        assets: ...
        shots: ...
        audio: ...
```

### 4.2 legacy

`request.h3` v1は受理を継続する。ただしpureな`upgradeH3V1ToVideoPromptV2()`でmemory上のV2へ変換し、同じcompilerへ流す。

- source fileを自動書換えしない。
- legacy fieldの意味を推測拡張しない。
- legacy `lyrics: string`はclip-local `legacy-unaligned` vocal/text eventとして保持する。
- exact MV syncが必要ならLyricsContract binding不足として停止する。
- legacy compileのbyte-identical goldenをcompatibility modeで維持する。

`request.h3`と`request.video_prompt`の同時指定は引き続きerror。

## 5. VideoPromptIrV2

概念schema。MVと単体clipをdiscriminated unionにし、MVで`program_binding`を省略できないようにする。

```ts
type VideoPromptIrBaseV2 = {
  version: 2;
  target: {
    model_profile_id: string;
    mode: "text-to-video" | "first-frame" | "first-last" | "last-frame" | "reference";
    duration_ms: number;
    quality: string;
    aspect: string;
  };
  creative: {
    intent?: string;
    must_include: string[];
    prohibited: string[];
  };
  subjects: SubjectV2[];
  scenes: SceneV2[];
  assets: PromptAssetV2[];
  shots: ShotV2[];
  audio: AudioPlanV2;
};

type VideoPromptIrV2 = VideoPromptIrBaseV2 & (
  | {
      program_kind: "standalone";
      program_binding?: never;
    }
  | {
      program_kind: "mv";
      program_binding: {
        generation_unit_digest: Sha256;
        production_id: string;
        music_contract_digest: Sha256;
        lyrics_contract_digest?: Sha256;
        program_start_ms: number;
        program_end_ms: number;
        section_id?: string;
        beat_anchor_ids: string[];
        lyric_cue_ids: string[];
      };
    }
);
```

MV branchはGenerationUnitContractV1とfield-by-fieldで一致しなければcompileしない。`program_end_ms - program_start_ms`、unit clip duration、`target.duration_ms`の三値を一致させる。

### 5.1 ShotV2

```ts
type ShotV2 = {
  id: string;
  start_ms: number;
  end_ms: number;
  scene_id?: string;
  cast: Array<{ subject_id: string; variant_id?: string }>;
  composition: string;
  action_beats: Array<{
    at_ms?: number;
    description: string;
  }>;
  camera?: {
    type: string;
    amplitude?: string;
    speed?: string;
    direction?: string;
    optics?: { fov_degrees?: number; lens_mm?: number };
  };
  vocal_events: VocalEventV2[];
  visible_text_events: VisibleTextEventV2[];
  constraints: {
    positive: string[];
    exact_text_refs: string[];
  };
};
```

`visual`自由文だけでなく、composition / action / camera / vocal / visible textを分ける。locked textは参照し、shotごとに言い換えない。

### 5.2 VocalEventV2

```ts
type VocalEventV2 = {
  id: string;
  kind: "dialogue" | "singing" | "voiceover";
  speaker_ids: string[];
  language_id: string;
  content:
    | {
        source: "lyrics-cue";
        lyrics_contract_digest: Sha256;
        cue_id: string;
        occurrence_id: string;
        text_digest: Sha256;
      }
    | {
        source: "inline-exact";
        exact_text: string;
        text_digest: Sha256;
      };
  start_ms?: number;
  end_ms?: number;
  continuity: "contained" | "continues-in" | "continues-out" | "cutoff";
};
```

- 複数歌唱者を`speaker_ids`で表す。
- lyricsはcue refからcanonical source spanを解決し、本文を別fieldへ複製しない。
- `language_id`はgrammar profileが持つ安全なallowlist IDに限定し、任意文字列をsection labelへ入れない。
- exact textを`<d>[Language]...</d>`へserializeする前に、UTF-8 byte spanとdigestを再検証する。
- official grammarにlossless escapeが定義されていないreserved token（`</d>`、section header、`<scenetrans>`、`<cutoff>`等）が本文に含まれる場合、本文を変更せずfail closedにする。
- cutを跨ぐ場合、H3 grammarが`<scenetrans>`とcontinuity proseを決定的に出す。
- clip終端で途切れる場合だけ`<cutoff>`を出す。
- voiceoverはon-screen subjectのlips closed ruleを維持する。

### 5.3 VisibleTextEventV2

```ts
type VisibleTextEventV2 = {
  id: string;
  text: string;
  text_digest: Sha256;
  purpose: "generated-scene-text" | "caption-overlay" | "title-overlay";
  render_target: "model" | "editor";
};
```

`render_target=editor`はH3 promptへ入れない。caption / titleの正本はedit層で保持する。

### 5.4 AudioPlanV2

```ts
type AudioPlanV2 = {
  policy: "reuse-master" | "reference-only" | "native-generated" | "silent";
  soundscape?: string;
  non_diegetic_music?: string;
  reference_asset_ids: string[];
  final_mix: "discard-generated" | "use-generated" | "mix-explicitly";
};
```

policyとfinal_mixの矛盾をerrorにする。

## 6. Scene / Identity拡張

SceneV2はlocation / paletteだけでなく、必要時に次を固定する。

- wardrobe
- props
- time of day
- weather
- screen direction
- active subjects
- spatial anchors

すべてoptionalだが、同じscene内で定義済みfieldをshotが上書きしない。prompt compilationはpre-GateのIdentityDefinitionContract digestをbindする。生成後のIdentityVerificationReportはOutput QAとGate 2 / 3が別にbindし、`locked:true` boolean単独を信頼しない。

## 7. Semantic Prompt Blocks

compilerは最初から英文promptを組み立てず、model-neutral block ASTを作る。

```text
MODE_ALIGNMENT
SCENE_CONTEXT
ACTIVE_REFERENCES
LOCATION_MAP
FIRST_FRAME_BLOCKING
OPTICS
CAMERA
ACTION_TIMING
PHYSICS
LIGHTING
AUDIO_EVENTS
CHARACTER_ACTING
VISIBLE_TEXT
STYLE
QUALITY
POSITIVE_CONSTRAINTS
```

各blockはsource IR pathとdigestを持つ。Critic / lineageはblock単位でdiffできる。model grammar rendererがblockの採用・順序・serialize方法を宣言する。

H3のofficial section順は維持するが、その内部のshot proseをsemantic blockから作る。

## 8. H3 Grammar v3

### Base modes

top-level sectionは常に次の3個。

1. `integrated_multimodal_description`
2. `overall_soundscape`
3. `non_diegetic_music`

I2VA / FL2VA / L2VAのmode alignmentは`integrated_multimodal_description`の先頭内容であり、第4sectionや独立headerにしない。

### Reference mode

1. `subject_definitions`
2. `summary`
3. `retention_analysis`
4. `detailed_description`
5. `overall_soundscape`
6. `non_diegetic_music`

```ts
type H3GrammarProfileV3 = {
  profile_id: string;
  source_commit: string;
  source_digest: Sha256;
  section_order: string[];
  features: {
    scenetrans: boolean;
    cutoff: boolean;
    group_speaker: boolean;
    exact_dialogue: boolean;
  };
  serialization_rules_digest: Sha256;
  digest: Sha256;
};
```

`<scenetrans>`、`<cutoff>`、group speaker表現は、選択grammar profileがsource pinとserialization rule付きで対応する場合だけ出す。未対応なら意味を変えずにunit分割するかfail closedにし、別profileへ暗黙fallbackしない。

### 改善点

- subject / asset relationshipをIRで明示し、summaryを推測作文しない。
- retentionは対象、shot、関係markerを型から生成する。
- audio referenceとaudio reuseを区別する。
- first / last frame alignmentのshot idとdurationをIRから決定する。
- lyrics / dialogue / visible textのtext digestと出現回数を検証する。
- shot gap / overlap / final endを検証する。
- FL2VAは原則single shotをadvisory warningとし、複数shotは明示意図が必要。
- `must_include`を対応semantic blockへbindし、未反映をerrorにする。
- `prohibited`はplanning / validation constraint。model profileがnegative fieldを正式対応しない限り、長いnegative listへ変換しない。

## 9. EffectiveGenerationContract

次の四層を照合し、hard claimだけから実行可能集合を作る。

1. official/advisory knowledge
2. model prompt profile
3. connection capability
4. adapter execution route

```ts
type CapabilityClaim<T> = {
  value: T;
  authority: "hard" | "advisory";
  source: string;
  source_digest: Sha256;
  verified_at: string;
  review_after?: string;
};

type EffectiveGenerationContractV1 = {
  route: RouteIdentityV1;
  mode: string;
  effective: {
    durations_ms: number[] | Range | "unknown";
    aspects: string[] | "unknown";
    resolutions: string[] | "unknown";
    reference_caps: ReferenceCaps | "unknown";
    prompt_budget: PromptBudget | "unknown";
  };
  advisory_warnings: Array<{
    claim_ref: TypedDigestRef;
    message: string;
  }>;
  digests: {
    knowledge?: Sha256;
    model_profile: Sha256;
    connection_profile: Sha256;
    adapter_route: Sha256;
  };
  freshness: {
    status: "fresh" | "stale" | "unknown";
    review_after?: string;
  };
  overrides: ReviewedOverride[];
  digest: Sha256;
};
```

duration / aspect / resolution / reference / prompt budgetの各claimにauthority、source、freshnessを持たせる。execution集合は`authority="hard"`だけを交差する。advisory catalogはwarningとplanning guidanceに限定し、hard capabilityを狭めたり広げたりしない。hard交差が空またはunknownで要求を証明できなければfail closed。transport差を「公式modelの能力」として上書きしない。overrideには根拠、scope、expiry、人間reviewを必要とする。

## 10. Canonical Prompt と Adapter Dialect

### Canonical

- H3 grammarの`<Picture N>` / `<Video N>` / `<Audio N>` / `<Subject N>`
- model semanticsを表す
- adapter CLI syntaxを含めない

### Adapter

- 選択routeが必要とするlabel / media fieldsへ変換
- 例: `@imageN`等
- canonical labelとのbijectionをartifactに保存
- raw authoring IR / prompt guideをadapter payloadへ渡さない

canonicalとadapterが同じrouteでも別digestを保持する。adapter変換後に未解決label、重複label、asset binding mismatchを再検証する。

## 11. Prompt Budget

```ts
type PromptBudget = {
  hard_limit?: number;
  soft_limit?: number;
  unit: "unicode-code-points" | "utf8-bytes" | "tokens";
  source: "official-api" | "adapter" | "advisory-catalog";
  verified_at: string;
};
```

規則:

- locked / exact textを切り詰めない。
- hard limit超過はerror。
- soft limit接近はblock別内訳付きwarning。
- limit不明を無制限と表示しない。
- compilerはsilently truncate / summarizeしない。
- 簡略化は別RevisionIntentとし、一度に1 mutable blockだけ変更する。

local catalogの7000文字は出典がhard API limitとして確認できるまでadvisory扱いとする。

## 12. Validation Codes

次をstable codeとして追加する。

| code | 意味 |
| --- | --- |
| `VPD-T001` | shot gap / overlap |
| `VPD-T002` | first startが0でない |
| `VPD-T003` | final endがunit durationと一致しない |
| `VPD-T004` | vocal / lyric cueの不正なcut横断 |
| `VPD-T005` | beat anchorがMusic contractに存在しない |
| `VPD-L001` | exact lyrics/dialogueのbyteまたはmultiplicity不一致 |
| `VPD-L002` | cue / singer / language binding不足 |
| `VPD-L003` | untimed cueをtiming必須unitで使用 |
| `VPD-X001` | exact textにlossless escape不能なreserved token |
| `VPD-B001` | hard prompt budget超過 |
| `VPD-B002` | soft prompt budget接近 |
| `VPD-K001` | knowledge / profile freshness期限切れ |
| `VPD-K002` | effective contract交差が空、または未承認override |
| `VPD-C001` | must_include / positive constraint未反映 |
| `VPD-I001` | Identity definition binding不足、またはlocked text digest不一致 |
| `VPD-A001` | audio policy / final mix矛盾 |
| `VPD-U001` | GenerationUnit / program binding / clip duration不一致 |
| `VPD-U002` | cue / beat / sectionがunit区間またはbound revisionに属さない |
| `VPD-R001` | batch内RouteIdentity混在またはroute digest不一致 |
| `VPD-J001` | generation job approvalとcompilation digest不一致 |

既存H3-E / H3-C / PV-E codeはlegacy surfaceで維持し、新codeとのmappingをartifactへ含める。

生成結果のIdentity evidence不足はpost-generation QAの`IDV-E001`として扱い、H3 compileを結果verificationと混同しない。

## 13. Compilation Artifact v3

```text
dist/<run-id>/video-prompt/<request-id>/
├── ir.normalized.json
├── effective-contract.json
├── semantic-blocks.json
├── prompt.canonical.txt
├── prompt.<adapter>.txt
├── labels.json
├── validation.json
├── lineage.json
└── compilation-manifest.json
```

temp sibling directoryへ全fileを書き、再読・digest確認後、directoryをatomic renameする。`compilation-manifest.json`がcommit marker。部分write directoryは採用しない。

lineage必須field:

- authoring schema / upgrader version
- normalized IR hash
- contract bindings
- semantic block digests
- canonical / adapter prompt hash
- exact text digests
- Identity / Music / Lyrics digests
- GenerationUnit digestとmaster program範囲
- knowledge / model / connection / route digests
- grammar profile source commit / digest / feature flags
- label map digest
- validation digest
- compilation digest

generation job approvalは`compilation_digest`を必須bindする。

## 14. Migration

1. 現行H3 v1 fixture / goldenをfreezeする。
2. `upgradeH3V1ToVideoPromptV2()`をpure functionで追加する。
3. single compilerをshadow modeで実行し、legacy outputとのbyte diffを記録する。
4. compatibility modeは既存goldenをbyte-identicalに保つ。
5. new featureを使用するprojectだけworkflow v3 artifactを生成する。
6. workflow v2 artifactはlegacy readerで読み、in-place rewriteしない。
7. `src/h3/*`はpublic compatibility exportとして残し、実装truthを`videoPromptDirector`へ集約する。

activation matrix:

| mode | compile | execute |
| --- | --- | --- |
| `disabled` | legacyのみ | legacy |
| `shadow` | legacy + V2比較 | legacyだけ |
| `active` | 全入力をV2 single compilerへ正規化 | V2 artifactだけ |

active pathから旧compilerを直接呼べる入口は0にする。legacy `request.h3`もpure upgrader経由でsingle compilerへ入り、source fileは書き換えない。

## 15. Golden / Adversarial Tests

既存first-frame / first-last / last-frame / reference / T2V / voiceover goldenを維持し、次を追加する。

- 1曲を複数H3 unitへ分割するMV
- caption-only lyricsがpromptへ入らない
- singing lyricsのUnicode、空白、改行、反復回数
- untimed / partial lyrics cueと架空timestamp拒否
- reserved `</d>` / section header / `<scenetrans>` / `<cutoff>`衝突
- `<scenetrans>` / `<cutoff>`
- group singer IDs
- top-level base headerが常に3個でalignmentがdescription内にあること
- grammar feature未対応時の分割またはfail-closed
- shot gap / overlap / final end
- beat / lyric cueの不存在
- prompt soft / hard / unknown budgetと各unitのlimit-1 / limit / limit+1
- knowledge / profile / routeの矛盾とstale
- advisory claimがhard execution集合を変更しないこと
- canonical / adapter label差
- all reference mode排他違反
- MV GenerationUnitの欠落、誤順序、誤区間、誤cue
- mixed RouteIdentity batch拒否
- compilation digest変更後のapproval拒否
- active pathの旧compiler invocation 0
- job revision増加中もimmutable approval identity維持
- partial artifact write
- pin後asset改変
- `mmx` / `minimax-http` / PixVerse間のfallback禁止
- `submission_unknown` no-resubmit
