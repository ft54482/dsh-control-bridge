<img src="docs/assets/hero.jpg" alt="DSH Control Bridge — Codex / Grok Bot → DeepSeek Harness" width="100%">

# DSH Control Bridge

[<img src="docs/assets/languages/zh.png" alt="简体中文" height="26">](README.md) [<img src="docs/assets/languages/en.png" alt="English" height="26">](README.en.md) [<img src="docs/assets/languages/fr.png" alt="Français" height="26">](README.fr.md) [<img src="docs/assets/languages/ja.png" alt="日本語" height="26">](README.ja.md) [<img src="docs/assets/languages/ko.png" alt="한국어" height="26">](README.ko.md) [<img src="docs/assets/languages/de.png" alt="Deutsch" height="26">](README.de.md)

Codex、Grok Bot、独自の調整プログラムから、指定した DeepSeek Harness ワークスペースへタスクを渡し、実行結果を追跡できます。**同じパソコンで Codex と Harness Desktop を使っている場合は、Codex skill と Desktop Host から始めてください。** ローカル Host に接続し、設定後は Codex から自然言語で操作できます。

[Super Agent コックピット](plugins/dsh-superagent-cockpit/README.md) · [Codex skill v0.2.3](https://github.com/ft54482/dsh-control-bridge/releases/tag/skill-v0.2.3) · [Desktop Host v0.2.2](https://github.com/ft54482/dsh-control-bridge/releases/tag/v0.2.2) · [ドキュメント一覧](docs/README.md) · [ポート設定とトラブルシューティング](docs/ports.md) · [Windows 実機検証](docs/verified-scope.md)

詳細な運用ガイドは現在、主に中国語で提供しています。コマンド、設定キー、技術フィールド名は原文のまま記載しています。

## 利用方法を選ぶ

| 環境と目的 | インストール・起動するもの | 最初の確認 |
| --- | --- | --- |
| Codex デスクトップで既存の会話を続ける、または新しいタスク用の主制御会話を作る | Codex に **skill**、Harness の desktop profile に **Host プラグイン**をインストール | skill で `health` と `granted` を実行。[インストールとペアリング](docs/windows-delivery.md#codex-desktop-setup) |
| 独自の Bot やスクリプトで複数インスタンス、受信箱、タスク承認、監査を管理する | Python **調整ブリッジ**をインストールし、`dsh-bridge` CLI を使用。署名付き HTTP イベントを受信する場合に `serve` を起動 | fake で起草、送信、結果提出まで試す。[調整ブリッジガイド](docs/coordinator.md) |
| 既存のツールクライアントから MCP で受信箱を読む、タスクを起草する | クライアントから同じ Python 調整ブリッジの `mcp` サブコマンドを起動。v0.2.2 は `Content-Length` フレームを使うため、対応クライアントが必要 | 対応クライアントで `tools/list` を呼び出す。改行区切り JSON のみに対応するクライアントでは CLI を利用可能。[MCP 設定とツール](docs/coordinator.md) |
| 端末や CI で独立した Harness の通常会話を実行する | Python 調整ブリッジに `headless_cli` アダプターと独立した headless profile を設定 | 既定の `spawn = false` のまま設定を確認。[Headless CLI](docs/headless-cli.md) |
| Harness Desktop でタスク枠と各インスタンスのチケットを確認する | 任意の **Super Agent コックピット**をインストール。複数インスタンスでは同梱の集約サービスを起動 | 上部に主制御の登録情報に基づくタスク、その隣にアクティブ会話数、インスタンスカードにチケット実行者の使用状況を表示。[ダウンロードとインストール](plugins/dsh-superagent-cockpit/README.md) |
| 導入済み SuperAgent に Codex からタスクを送り、追跡する | skill 付属の `github_source.py` で対象インスタンス、GitHub リポジトリ、送信アカウントを確認 | `precheck` から開始。承認済み Issue やコメントの送信後、同じ計画で Ticket、Assignment、worker の結果を追跡。[操作ガイド](skills/deepseek-harness-bridge/references/superagent.md#github-source) |

ディレクトリと役割の対応は[コンポーネントと実行場所](docs/README.md#仓库里的几个名字)を参照してください。

## Codex デスクトップのクイックスタート

1. **skill をインストール。** 独立 skill ZIP を個人用の `~/.agents/skills/` に展開します。ペアリング済みなら既存の Host と権限を利用できます。初回は互換性のある v0.2.2 Host TGZ と、Windows インストールスクリプトを含むポータブルソース ZIP もダウンロードしてください。ソースをチェックアウト済みの場合はそれを使えます。[Skill ZIP](https://github.com/ft54482/dsh-control-bridge/releases/download/skill-v0.2.3/deepseek-harness-bridge-0.2.3-skill.zip) · [Host、ポータブル版、SHA-256](https://github.com/ft54482/dsh-control-bridge/releases/tag/v0.2.2)
2. **Host をインストールしてペアリング。** Python 3.11+ が必要です。Windows ガイドに従って実際に使用する desktop profile に Host をインストールし、対象ワークスペースの空いている会話を選び、長期認証情報ファイルのパスを skill に設定します。履歴の参照には `read`、タスクの送信には `write` を選びます。[インストールとペアリング](docs/windows-delivery.md#codex-desktop-setup)
3. **接続を確認。** Codex に「`$deepseek-harness-bridge` でローカル接続を確認し、許可済み会話を一覧表示して」と入力します。主制御会話を新規作成する場合は、同じ profile に `master-control` プリセットが入り、Host の会話作成が有効で、`health` が `preset_create_verified=true` を返すことを確認してください。独自のポートも Codex に伝えます。[既定以外のポートの例](docs/ports.md#desktop-host)
4. **タスクに合う会話を選ぶ。** 「前回のエクスポート修正の会話を探して、失敗ケースの対応を続けて」、または「同じワークスペースに新しい主制御会話を作り、この独立したタスクを処理して」と依頼できます。作成後、skill は実際の会話からプリセットを読み戻してタスクを送り、リクエスト ID で公式の終了状態を追跡します。[会話コマンドと検証フィールド](skills/deepseek-harness-bridge/references/desktop.md#new-work-in-master-control-mode)

## サンプルと異なるポートを使う

| 接続先サービス | 既定の接続 | 変更する設定 |
| --- | --- | --- |
| Harness Desktop Host | `127.0.0.1:8765` | Host プラグインの `port`、ペアリング時の `--url`、skill の各呼び出しの `--port` |
| Python 調整ブリッジの署名付きイベント受信口 | `127.0.0.1:8787` | `serve --port` で起動し、送信側の `/v1/events` URL を更新 |
| SuperAgent 管理サービス | helper の既定接続先は `127.0.0.1:3082` | 対象 profile の実際の待ち受けポートを調べ、`superagent.py --port PORT state` に渡す |
| 調整ブリッジ MCP | ローカル子プロセスの標準入力・標準出力 | 起動コマンド、設定ファイル、データディレクトリを指定。TCP ポートは不要 |

選んだ利用方法に必要なサービスを設定してください。fake サンプルの `:9` と `:10` はプレースホルダーです。詳細ガイドでは独自のポートでのペアリングと、接続先の誤り、認証情報の誤り、ワークスペースの権限不足の調べ方を説明しています。[ポート設定とトラブルシューティング](docs/ports.md)

## Python 調整ブリッジのクイックスタート

リポジトリのルートで Python 3.11+ を使って次を実行します。fake サンプルはローカルで一連の流れを模擬するため、Harness の認証情報やモデル利用枠は不要です。

```sh
python -m pip install -e .
python examples/e2e_fake.py
dsh-bridge --config examples/config.example.toml check
```

サンプルでは `local-desktop` と `lab-server` の両方に `broadcast-cs` ワークスペースを置いています。タスク送信先はインスタンスとワークスペースを組み合わせて指定します。タスク記録は通常会話 `ordinary_session` と長期タスク `superagent` を区別し、既定は `draft` です。送信には操作者が用意した `mandate` が必要です。fake が生成する ticket/run はデモ用です。実際の Assignment は対応する SuperAgent 管理サービスで追跡します。[調整ブリッジのコマンドと承認](docs/coordinator.md) · [アダプターの機能](docs/adapters.md)

[開発・貢献](CONTRIBUTING.md) · [セキュリティ](SECURITY.md) · [MIT ライセンス](LICENSE)
