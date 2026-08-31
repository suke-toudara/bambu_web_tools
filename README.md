# Bambu Web Tools

STEP モデルの表示・スライス・Bambu Lab プリンターへの印刷までをブラウザだけで行う Next.js 製ツールです。
[bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp) と
[mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server) の実装を参考に、
Bambu Lab の LAN モード通信プロトコル(MQTT + FTPS)を直接実装しています。

## 機能

- **表示**: STEP (.step / .stp) ファイルをブラウザ上で読み込み、[occt-import-js](https://github.com/kovacsv/occt-import-js)(OpenCascade の WASM ビルド)でメッシュに変換して three.js で 3D 表示します。
- **スライス**: サーバー側で独自実装した簡易スライサーが、平面交差によるレイヤー輪郭抽出 → 壁(パーティメーター)オフセット → ジグザグインフィル → 上下ソリッド層 という手順で G コードを生成します。レイヤーごとのプレビュー(輪郭線)、推定印刷時間・フィラメント使用量も表示します。
- **印刷**: Bambu Lab プリンター(LAN モード)へ
  - 生成した G コードをそのまま送信する「簡易印刷」(単色・AMS 不使用、`gcode_file` コマンド)
  - Bambu Studio / OrcaSlicer で書き出した `*.gcode.3mf` を送信する「本印刷」(`project_file` コマンド、AMS マッピング対応)
  の両方に対応。印刷状態の取得(温度・進捗)、一時停止/再開/停止も可能です。

## 技術的な制約(重要)

Bambu Lab のスライサー(BambuStudio/OrcaSlicer)は、ノズル/ベッド専用の校正マクロや開始 G コード、AMS
フィラメントデータベースなどプロプライエタリな要素に強く依存しており、これをブラウザ上で完全に再現することは
現実的ではありません([bambu-printer-mcp のスライスに関するドキュメント](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SLICING.md)
参照)。そのため本ツールでは:

- 内蔵スライサーは **単色・AMS 非対応の簡易実装**(壁+ジグザグインフィルのみ、専用開始 G コードなし)です。
  P1 / A1 / X1 系プリンターの `gcode_file` コマンドで送信できる、簡単な単色プリント向けです。
- **フル機能(AMS、フロー校正、機種別開始 G コード)が必要な場合**は、Bambu Studio / OrcaSlicer で
  スライスして「Export → Export plate sliced file」で書き出した `*.gcode.3mf` を、本ツールの
  「事前スライス済みファイルを印刷」機能から送信してください。こちらはベンダースライサーの出力をそのまま
  使うため、AMS マッピングや校正を含むフル機能の印刷が可能です。
- **H2 シリーズ(H2S/H2D/H2C)は非対応**です。2025年以降のファームウェアは Bambu 発行のクライアント証明書による
  mTLS が必須であり、本ツールは実装していません。P1/A1/X1 系の LAN モードを前提としています。

## セットアップ

```bash
npm install
npm run dev
```

`http://localhost:3000` を開いてください。

### プリンター接続情報の確認方法

Bambu Lab プリンターの `設定 > WLAN` (または LAN 設定画面)から以下を確認してください。

- **IP アドレス**: プリンター本体のネットワーク設定画面に表示
- **シリアル番号**: 本体設定 or 底面ラベル
- **アクセスコード**: LAN モードのアクセスコード(本体設定画面に表示)

いずれもブラウザの `localStorage` にのみ保存され、外部には送信されません(印刷 API を呼び出す際にサーバーへ
渡り、そのままプリンターへの MQTT/FTPS 接続に使われます)。

## ディレクトリ構成

```
src/
  app/
    page.tsx              # メイン UI (アップロード → ビュー → スライス → 印刷)
    api/slice/             # スライス API (STL → Gコード)
    api/printer/           # Bambu プリンター制御 API (status/print-gcode/print-project/control)
  components/
    ModelViewer.tsx        # three.js ベースの 3D ビューア
    LayerPreview.tsx       # レイヤー輪郭プレビュー (canvas)
  lib/
    occt/                  # occt-import-js (STEP パース) ラッパー
    stl/                   # STL の読み書き
    slicer/                # 独自スライスエンジン (平面交差・オフセット・インフィル・Gコード生成)
    printer/bambu/         # Bambu LAN プロトコル (MQTT ステータス/制御, FTPS アップロード, 印刷開始)
public/wasm/                # occt-import-js の WASM 本体 (クライアントから直接 fetch)
```

## 既知の制限

- スライサーはポリゴンオフセットを簡易的な miter 法で行っているため、非常に鋭い凹角形状では壁がわずかに乱れる
  ことがあります。
- サポート材、ブリム/ラフト、可変レイヤー高さ、複数パーツの自動配置には対応していません。
- 三角形数が非常に多い(40万を超える)メッシュはスライス API 側で拒否されます。事前に簡略化してください。
