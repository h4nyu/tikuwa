# tikuwa — 家庭用在庫管理PWA

スマホのカメラでバーコードをスキャンして、自宅の在庫を管理するアプリ。
Raspberry Pi上で常時起動し、同じLAN内のスマホからブラウザ(PWA)でアクセスする構成。

## 構成

npm workspacesならぬ pnpm workspaces によるモノレポ。ports & adapters的にパッケージを分割している。

```
packages/
  core/    ドメイン型・純粋ロジック(Product, StockTransaction, 在庫計算)。フレームワーク非依存。
  db/      ProductRepositoryのSQLite実装(node:sqlite)。
  server/  Hono合成ルート(env読み込み・DI・HTTPS/HTTPサーバー起動)。
  web/     スマホ向けPWAフロントエンド(Vite + TypeScript + html5-qrcode)。
```

- サーバー: [Hono](https://hono.dev/) + `@hono/node-server`
- DB: SQLite(Node組み込みの`node:sqlite`)、`data/tikuwa.db` に保存。
  ネイティブアドオンのビルドが不要なため、非力なRaspberry Piでもdocker buildが速い
  (以前`better-sqlite3`を使っていたときはPi 3でビルドに10分近くかかっていた)。
- フロント: Vite + TypeScript(バンドルなしの素のDOM操作、フレームワーク無し)
- 型チェック: `core`/`db`/`server` はルートの単一`tsconfig.json`で1プログラムとして検査(ビルドはせず`tsx`で直接実行)。`web`はDOM/ESM前提のため別`tsconfig.json`でVite側がビルドする。

## ローカル開発

```bash
pnpm install

# サーバー(API + 静的ファイル配信)を起動
pnpm run dev            # tsx watch で自動再起動

# フロントをHMR付きで開発する場合は別ターミナルで
pnpm --filter @tikuwa/web run dev   # http://localhost:5173 (APIは/apiをlocalhost:3000にプロキシ)
```

- `pnpm run typecheck` … core/db/server の型チェック
- `pnpm run typecheck:web` … web の型チェック
- `pnpm run build:web` … web をビルドして `packages/web/dist` に出力(本番のserverはここを配信する)

## HTTPS(カメラでバーコードを読むために必須)

スマホのブラウザで`getUserMedia`(カメラ)を使うにはHTTPS接続が必要。LAN内の自己署名証明書を生成する:

```bash
pnpm run gen-cert
```

`certs/key.pem` / `certs/cert.pem` が作られ、次回起動時から自動的にHTTPS(既定:3443番ポート)も立ち上がる。
スマホでの初回アクセス時は証明書の警告が出るので、「詳細設定」→「このサイトにアクセスする」等で進めば利用できる。

## Raspberry Piへのデプロイ(Docker Compose)

Piにデプロイキー(読み取り専用のSSH鍵)を登録し、`git pull`でコードを取得する運用にする(scpでの上書きはコミット履歴と実体がズレるため避ける)。

```bash
# Pi上で最初の1回
git clone git@github.com:h4nyu/tikuwa.git
cd tikuwa

# 証明書を生成(初回のみ)
docker compose run --rm app pnpm run gen-cert

# 本番起動(再起動しても自動復帰する)
docker compose up -d --build tikuwa
```

- `docker-compose.yml`は`network_mode: host`を使う(Linux専用。Raspberry Pi OSはLinuxなのでOK)。
  - ホストネットワークにすることで、証明書のSAN(接続先IP)にPi自身のLAN IPをそのまま含められ、
    ポートマッピングの設定も不要になる。
  - **Mac上のDocker Desktopではhost networkingが機能しないため、ローカル動作確認は`docker run -p ...`などポートマッピングで行うこと**(README内の開発コマンドはこの前提)。
- `app`サービスはソースをbind mountした使い捨て実行用(`docker compose run --rm app <command>`で型チェックやスクリプトを走らせる)。
- `tikuwa`サービスが本番の常駐プロセス。ソースはbind mountせず、**ビルド時にイメージへ焼き込んだコードだけ**が動く
  (稼働中にファイルを書き換えても反映されない)。コードを更新したら以下でデプロイし直す:

```bash
git pull
docker compose up -d --build tikuwa
```

- `data/`(SQLite DB)と`certs/`(証明書)はホスト側にvolumeとして永続化されるので、
  イメージの再ビルド・コンテナの再作成をしてもデータは消えない。

### 注意: 本番でwatchモードを使わない

`tikuwa`サービスは`pnpm run start`(`tsx`をwatchなしで1回起動するだけ)で動く。
`tsx watch`のような自動再起動をこのサービスに使うと、ファイル変更のたびにプロセスが再起動し、
SQLiteのコネクションやカメラ絡みの状態が不安定になる可能性があるため、意図的に避けている。
コードの反映は上記の`docker compose up -d --build`による明示的な再デプロイのみで行う。

## API概要

すべて `/api/products` 配下。

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/products?q=` | 一覧・検索 |
| GET | `/api/products/replenishment` | 目標在庫数に対して不足している商品一覧 |
| GET | `/api/products/barcode/:code` | バーコードで検索 |
| GET | `/api/products/:id` | 詳細 |
| POST | `/api/products` | 新規登録 |
| PUT | `/api/products/:id` | 編集 |
| DELETE | `/api/products/:id` | 削除 |
| GET | `/api/products/:id/transactions` | 入出庫履歴 |
| POST | `/api/products/:id/transactions` | 入出庫記録(`type: in\|out\|adjust`) |
| POST | `/api/products/:id/barcodes` | バーコードを追加(`quantity_per_scan`で箱・ケース等の数量を指定) |
| DELETE | `/api/products/:id/barcodes/:barcodeId` | バーコードを削除 |
| GET | `/api/deliveries` | 納品記録の一覧(新しい順) |
| POST | `/api/deliveries` | 納品記録を追加(`product_name`・`tracking_number`・`carrier`(任意)・`category`(任意)・`international_tracking_number`(任意)) |
| PUT | `/api/deliveries/:id` | 納品記録を編集(`product_name`・`tracking_number`・`carrier`・`category`・`international_tracking_number`) |
| PATCH | `/api/deliveries/:id/status` | 納品記録の状態を更新(`status`)。現在UIからは呼び出していない内部用API |
| DELETE | `/api/deliveries/:id` | 納品記録を削除 |

## 物流管理

下部ナビの「物流」タブ(物流管理)は、在庫一覧と同じ構成(検索欄・カテゴリチップ・一覧)で
発注した荷物を一覧表示する。右下の「+」から商品名(候補入力あり)・追跡番号・運送会社(任意)・
カテゴリ(任意)・総国際追跡番号(任意)を登録できる(商品登録と同じ「+」ボタンだが、物流タブ表示中は
こちらのフォームが開く)。カテゴリは「発注済み」「上海到着」「国際発送」「到着済み」の4択から選ぶ。
商品の在庫数とは連動しない、単純な記録用の一覧(新しい順)。画面最上部の検索欄で商品名・追跡番号・
運送会社・カテゴリ・総国際追跡番号の部分一致検索ができ、その下のカテゴリチップ(在庫一覧のカテゴリ
フィルタと同じ見た目)と組み合わせて絞り込める。各記録の「編集」リンクから同じフォームを開いて
商品名・追跡番号・運送会社・カテゴリ・総国際追跡番号を後から修正できる。カテゴリを設定すると記録
一覧にバッジとして表示され、総国際追跡番号を設定すると一覧の商品名の並びに「総:番号」の形式で表示される。

「CSVで書き出す(Excelで開けます)」ボタンでは、カテゴリが「上海到着」の記録のみを
(検索欄の絞り込みだけを反映して)「商品名」「追跡番号」「運送会社」「総国際追跡番号」「記録日時」の
5列のCSVファイルとしてダウンロードできる(総国際追跡番号の列は各記録に個別編集で設定済みの値を
そのまま書き出すだけで、書き出し時に入力を求めることはない)。書き出した記録は国内転送が済んだと
みなし、カテゴリが自動的に「国際発送」に更新される(次回の書き出しで同じ記録が重複しないようにするため)。
Excelでの文字化けを防ぐためUTF-8 BOM付きで出力している。

## 複数バーコード(箱・ケース対応)

1商品に複数のバーコードを登録でき、それぞれに「1回のスキャンで増減する数量」(`quantityPerScan`)を持たせられる。
例: 刺繍糸1本のバーコードは`quantityPerScan=1`、12本入り箱のバーコードは`quantityPerScan=12`で登録すると、
箱をスキャンした際に自動で+12が提案される。

スキャンに成功すると、登録済みの商品なら詳細画面へ、未登録のバーコードなら商品名などを入力する
新規登録フォームへ自動的に遷移する(中間の確認パネルは無し)。新規登録フォームの上部に
「登録済みの商品に、このバーコードを追加する場合はこちら」というリンクがあり、そこから検索して
既存商品にバーコードを紐付ける(既存商品への追加)フローに切り替えられる。詳細画面・登録フォームを
閉じると自動でスキャンが再開する。

スキャンタブが使いにくい場合(カメラ不調・破損したバーコード等)は、スキャン画面の
「⌨️ バーコードを手動入力」から番号を直接入力できる。また、商品詳細・登録フォームの
バーコード入力欄の横にある📷ボタンからも、その場でカメラを起動してコードを読み取り、
入力欄に自動入力できる。

## カテゴリフィルタ・CSV書き出し

在庫一覧・補充リストにはカテゴリのチップが表示され、タップでそのカテゴリの商品だけに絞り込める
(一覧と補充リストで選択状態は独立)。補充リストの「CSVで書き出す」ボタンでは、現在表示中(カテゴリ絞り込み後)の
補充対象を「商品名」「補充必要箱数」の2列だけのCSVファイルとしてダウンロードできる
(発注用のシンプルなリストを想定しており、本数などの詳細は含めない)。商品名は自然順(1,2,3...)に
並べ、「商品名/箱数」の組を4列に均等分割して横に並べる(仕入れ先の棚卸し表と同じレイアウト)。
表の右上には合計箱数(例: 「合計27箱」)を表示する。
Excelでの文字化けを防ぐためUTF-8 BOM付きで出力している。
