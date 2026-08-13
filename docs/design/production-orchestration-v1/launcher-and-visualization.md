# Launcher and Workflow Visualization

## 1. 目的

現行Launcherの中央3Dが無表示になる退行を、次期Mission Tree実装の前提として修復する。3Dを必須truthにせず、同じ公開workflow projectionを3Dと2D fallbackの双方で安全に操作できるようにする。

## 2. 2026-08-11の観測

対象画面では次が同時に成立している。

- 右の制作記録と下のタイムラインは8工程を表示する。
- 中央にはCSS背景と現在地cardが見えるが、3D node、edge、床、照明は見えない。
- accessibility treeには「ノードは8件」と出る。
- 配信中HTMLのworkflow payloadにも8 nodeが存在する。

したがって、workflow dataや全React appの欠落ではなく、中央のscene描画だけが成立していない。

## 3. 現行構造で空白になる理由

確認済みの構造:

- `apps/workflow-viewer/src/app/App.tsx`は中央`WorkflowScene`、右`SidePanel`、下`TimelinePanel`を別々に描画する。
- `WorkflowScene.tsx`の外側`div`は常に`role="img"`とnode件数を持つため、Canvasが描けなくてもaccessibility treeは正常に見える。
- 3Dの実体は`@react-three/fiber`の`Canvas`だけに依存する。
- sceneには背景、床、照明が常設されるため、正常描画ならnodeがcamera外でも全面がCSS背景だけにはならない。
- `Suspense` fallbackはload待ちだけを扱い、WebGL context作成失敗、scene内例外、`webglcontextlost`を可視化しない。
- `apps/workflow-viewer/src/app/App.test.tsx`は`WorkflowScene`を丸ごとmockしており、実Canvasの失敗を検出しない。

最有力classはWebGL context作成失敗、GPU / driver差、scene内runtime exception、context lossである。ただしconsole / GPU evidenceを取得できていないため、現時点で一つへ断定しない。通常CLIのViewer bundleは生成時に再buildされるのでsource staleの可能性は低いが、packaged Desktopの`resources/runtime/viewer/`は別途version照合が必要である。

## 4. Scene State Contract

```ts
type ScenePresentationStateV1 =
  | { status: "initializing" }
  | {
      status: "ready";
      renderer: "webgl";
      first_frame_at: string;
    }
  | {
      status: "degraded";
      renderer: "dom-tree";
      reason_code:
        | "viewer.scene.webgl_unavailable"
        | "viewer.scene.initialization_failed"
        | "viewer.scene.context_lost"
        | "viewer.scene.first_frame_timeout"
        | "viewer.scene.runtime_error";
      retryable: boolean;
    };
```

これはUI-local stateであり、Production / Task / Gate stateを変更しない。raw exception、absolute path、GPU fingerprintをpublic DTOや画面へ出さない。

## 5. 実装方針

### 5.1 可視な失敗境界

- `WorkflowScene`をscene専用Error Boundaryで囲む。
- WebGL capabilityをCanvas作成前に確認する。
- `onCreated`後、scene内`useFrame`から最初の描画完了signalを親へ返す。
- `webglcontextlost`を監視し、default復旧に任せて空白を維持せず`degraded`へ遷移する。
- 初期化が終わらない場合はbounded watchdogで`first_frame_timeout`にする。background tab中はtimerを進めない。

### 5.2 2D fallback

失敗時に単なるerror文だけを置かず、同じ`nodesAtTime`、layout、selection callbackを使うDOM / SVG treeを表示する。

- node名、status、進捗、edge関係を表示する。
- keyboardでnodeを選べる。
- SidePanel / TimelinePanelとのselectionを共有する。
- 「3D表示を再試行」を明示buttonにする。
- 現行の「表示をリセット」はcamera / selection resetのままとし、暗黙にcontextを再作成しない。
- `prefers-reduced-motion`でも情報を失わず、animationだけを止める。

### 5.3 一つのprojection

3D、fallback、SidePanel、TimelinePanelは同じstrictly parsed public workflow DTOから描画する。rendererごとに独自status推測をしない。

- legacy project: 現行の固定8工程projectionを維持する。
- active project: Mission / Task Tree projectionを表示する。
- renderer failure: 表示方式だけを変え、工程数、selected node、current time、Gate表示を変えない。

## 6. 診断と配布物整合

画面内に安全なreason codeと再試行操作を出す。local debug buildだけ、developer consoleへsanitized cause chainを出してよい。

Viewer artifactには次を追加する。

- viewer source version
- viewer bundle digest
- workflow DTO schema version
- rendering capability mode

CLI生成物はrepository-owned bundleを毎回buildする既存挙動を維持する。packaged Desktopは`resources/runtime/viewer/`のbundle digestとpackage versionの対応をpackage testで固定し、旧bundleを新runtimeのように表示しない。

外部telemetryは追加しない。診断eventはbrowser session内またはproject-local sanitised reportに限定し、明示操作なしに送信しない。

## 7. Tests

### component / integration

- `getContext()`が`null`なら`viewer.scene.webgl_unavailable`とDOM treeを表示する。
- Canvas初期化throwをError Boundaryが捕捉し、他panelを維持する。
- `webglcontextlost`でdegradedへ移り、同じselected nodeを維持する。
- first-frame signalが無い場合だけbounded timeoutになる。
- retry成功時にreadyへ戻り、fallbackとの二重表示をしない。
- fallbackをkeyboard操作でき、SidePanel / TimelinePanelとselectionが同期する。
- reason code以外のraw error、path、prompt、secretをDOMへ出さない。

### browser / visual

- `WorkflowScene`をmockしないPlaywright testをsoftware WebGL環境で実行する。
- 8 node fixtureでCanvasのfirst-frame marker、描画surface、node hit targetを確認する。
- context unavailable / lostを注入し、中央が空白ではなくfallbackになることをscreenshotとDOMの両方で確認する。
- Chrome通常runtimeとpackaged Desktop fixtureでbundle version / digestを照合する。
- responsive、zoom、devicePixelRatio、reduced motionを検証する。

pixel差分だけを成功条件にしない。scene state、first-frame signal、操作可能node、visual snapshotを組み合わせる。

## 8. Acceptance Criteria

- 現在の8工程fixtureで3D node、edge、環境の実描画が確認できる。
- WebGLを利用できない環境でも中央が空白にならず、全工程を選択できる。
- 3D failureがSidePanel / TimelinePanel / Production truthを壊さない。
- legacy fixed workflowとactive Mission Treeの両方が同じfallback contractを通る。
- viewer bundleのsource / packaged runtime差を機械的に識別できる。
- current screenshot相当の「accessibility treeは8件、中央は空白」を回帰testが失敗として検出する。

## 9. 実装境界

最小の現行修復は次を対象とする。

```text
apps/workflow-viewer/src/components/scene/WorkflowScene.tsx
apps/workflow-viewer/src/components/scene/SceneErrorBoundary.tsx
apps/workflow-viewer/src/components/scene/WorkflowFallback.tsx
apps/workflow-viewer/src/app/App.tsx
apps/workflow-viewer/src/app/App.test.tsx
apps/workflow-viewer/e2e/*
src/viewer/artifact.ts
apps/desktop/*                     # packaged bundle整合testだけ
```

3D修復とMission Tree UIは同じ巨大変更にしない。まず現行8工程でPO-0Aを通し、その後PO-7でactive treeを追加する。
