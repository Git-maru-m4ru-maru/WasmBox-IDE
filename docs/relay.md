# リレー（WISP）の使い方と、自分のサーバーで動かす手順

WasmBox のゲスト（ブラウザの中の Linux）は、そのままでは外と通信できない。ブラウザは生の TCP を開けないので、
**ゲストの TCP を WebSocket で運び、本物の TCP に直す部品（リレー）**が要る。WasmBox は WISP というプロトコルのリレーを使う。

**方針（持ち主の決定、2026-10-20）: 公開リレーは運営しない。** 利用者が自分の手元（または自分のサーバー）でリレーを動かす。
この文書は、そのための手順と、守るべきことをまとめたもの。判断の材料は [ARCHITECTURE.md](../ARCHITECTURE.md) の 5.2。

確認の状況を、印で区別する（[AGENTS.md](../AGENTS.md) の方針）:
✅ = この環境か CI で実行して確認した / 🔬 = 実機で試していない（書いてあるとおりに動く保証はない。試して、直してから使うこと）。

| 項目 | 状況 |
|---|---|
| `npm run relay`（手元用）の接続先フィルタ・Origin・ポート・UDP の制限 | ✅ 実物の wisp-js 0.5.0 に対する結合テスト（`test/relay.integration.test.ts`）。実装を壊すと落ちることも確認した |
| `npm run relay:check`（フィルタの検査） | ✅ 同上。wisp-js の既定のままでは `::ffff:127.0.0.1` などで失敗し、`npm run relay` では成功することを確認した |
| ゲストの通信（DHCP・DNS・HTTPS・`apk`・`npm`）が `npm run relay` 越しで通る | ✅ CI の実ブラウザ（v86 + Alpine）で、全ステップ成功。[下の「確認の状況」](#確認の状況)を参照 |
| Docker（`tools/relay/Dockerfile`）のビルドと起動、起動したリレーへの `relay:check` | ✅ CI（`relay-docker` ジョブ）。[下の「確認の状況」](#確認の状況)を参照 |
| TLS のリバースプロキシ（`wisps://`）、出口のファイアウォール、systemd | 🔬 実機で試していない |

## 1. 手元で使う（いちばん簡単で、いちばん安全）

リレーもアプリも自分のマシンの中なので、TLS も、悪用への対策も、ほとんど要らない。

```sh
npm install                      # WasmBox の開発用パッケージ
npm install --no-save --package-lock=false @mercuryworkshop/wisp-js@0.5.0   # リレーの部品（package.json は変わらない）
npm run relay                    # wisp://127.0.0.1:5001/ で待ち受ける
```

別の端末で、アプリを開く（README の手順で `site/` を作ってある前提）:

```sh
npm run site:serve               # http://127.0.0.1:8080/
```

アプリの「ネットワーク」欄で「リレー経由」を選び、URL に `wisp://127.0.0.1:5001/` を入れて「適用して再読み込み」。
ゲストの中で `apk update`、`wget https://example.com/` などが使える。

`npm run relay` は、wisp-js をそのまま使うのではなく、次の方針を足して起動する（[tools/relay-policy.ts](../tools/relay-policy.ts)）:

| 守っていること | 理由 |
|---|---|
| 接続先は、**ドット区切りの IPv4 アドレスだけ**（名前・IPv6・`127.1` や 10 進などの別表記は断る） | wisp-js 0.5.0 の既定のフィルタは、IPv4 マッピングの IPv6 表記（`::ffff:127.0.0.1`）で迂回できた（ARCHITECTURE.md 5.2）。v86 は、名前をブラウザで解決して IPv4 アドレスで接続を頼むので、通常の使い方には影響しない |
| ループバック・プライベート・リンクローカル・CGNAT などへは届けない | あなたのマシンや、同じネットワークのサーバー・クラウドのメタデータをゲストから守る |
| ブラウザからの接続は、**許可した Origin だけ**（既定は `http://localhost:8080` と `http://127.0.0.1:8080`） | ブラウザは、どのサイトのページからでも `ws://127.0.0.1:5001` に接続できる。何もしないと、あなたが開いた他のサイトが、あなたのリレーを使える |
| ゲストが接続できるポートは、既定で **80 と 443** だけ | SSH・SMTP などの悪用を断つ。広げるには `--ports 80,443,22` か `--ports all` |
| UDP は既定で断る | 増幅攻撃などの悪用を断つ。必要なら `--allow-udp` |
| `/` で終わらないパス（wsproxy の形）は 404 | 使わない入口を閉じる |
| 1 つの接続で、同時に開けるストリームは 256 まで | 暴走したゲストが、無制限に接続を開かないように |
| `X-Forwarded-For` は信用しない | ログの IP が偽れないように |

オプションの一覧は `npm run relay -- --help`。

### フィルタの確認

```sh
npm run relay:check -- wisp://127.0.0.1:5001/
```

内部のアドレス（ループバック・プライベート・メタデータ・IPv4 マッピング・ULA など）への接続が、リレーに断られるかを調べる。
必須の項目が 1 つでも断られなければ、終了コード 1。**wisp-js の版を上げたとき、設定を変えたときは、必ず実行する。**
`relay:check` は、WISP のサーバーなら何に対しても使える（wisp-js 以外のリレーを試すときにも）。

⚠️ これは「**リレー自身のフィルタ**」の確認。出口をファイアウォールで塞いでいる場合、接続は時間切れになるだけなので、
フィルタが断っていなければ失敗と表示される（それでよい。フィルタとファイアウォールは、別々に効いているべき）。
ファイアウォールの確認は、5 章の手順で別に行う。

### 守れないこと

- **ゲストの通信は、あなたのマシンから出ていく。** 外のサーバーからは、あなたの IP からのアクセスに見える。ゲストで動かしたプログラム（`npm install` したパッケージなど）が悪いことをすれば、あなたの IP が使われる。
  信頼できないコードを動かすときは、ネットワークをオフにする。
- Origin の確認は、**ブラウザのページ**からの利用を断るだけ。あなたのマシンで動くプログラムは、Origin を偽って（付けずに）使える。手元用のリレーを、他のユーザーと共有するマシンで動かさない。
- `ws://`（暗号化なし）なので、同じマシンの中でしか、安全ではない。

## 2. https のページから使う（`wisps://`）🔬

https のページは、暗号化されない `ws://` / `wisp://` に接続できない。アプリを https で公開しているなら、リレーを TLS で包んで `wisps://` で使う。
リバースプロキシが TLS を終え、`127.0.0.1:5001` のリレーに WebSocket で渡す。**Origin の確認は、リレー自身（`--origin`）が行う**ので、プロキシでの設定は要らない。

```sh
# アプリが https://wasmbox.example.com にあるとき
npm run relay -- --origin https://wasmbox.example.com
```

Caddy の例 🔬（WebSocket は、自動で中継される）:

```
relay.example.com {
	reverse_proxy 127.0.0.1:5001
}
```

nginx の例 🔬:

```nginx
server {
	listen 443 ssl;
	server_name relay.example.com;
	# ssl_certificate … は省略

	# 1 つの IP から開ける接続数と、新しい接続の頻度を絞る（値は例。環境に合わせる）
	limit_conn_zone $binary_remote_addr zone=relay_conn:10m;
	limit_req_zone  $binary_remote_addr zone=relay_req:10m rate=5r/s;

	location / {
		limit_conn relay_conn 8;
		limit_req  zone=relay_req burst=10 nodelay;
		proxy_pass http://127.0.0.1:5001;
		proxy_http_version 1.1;
		proxy_set_header Upgrade $http_upgrade;
		proxy_set_header Connection "upgrade";
		proxy_read_timeout 3600s;
	}
}
```

アプリの設定欄には `wisps://relay.example.com/` を入れる。確認は、プロキシ越しにも行う:

```sh
npm run relay:check -- wisps://relay.example.com/
```

リレーのログには、プロキシの IP が出る（`X-Forwarded-For` は信用しない設定）。クライアントの IP は、プロキシのログで見る。

## 3. Docker で動かす

```sh
docker build -f tools/relay/Dockerfile -t wasmbox-relay .
# 手元だけに公開する（127.0.0.1 に限る。-p 5001:5001 だけだと、全アドレスに公開される）
docker run --rm --name wasmbox-relay -p 127.0.0.1:5001:5001 \
  --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 256m \
  wasmbox-relay --origin http://localhost:8080
```

- コンテナの中では `--host 0.0.0.0` で待ち受ける（Dockerfile の ENTRYPOINT）。外への公開は、`-p` で決める。
- wisp-js は、イメージを作るときに `npm install` する（0.5.0 に固定）。
- `--read-only` 以下は、権限を絞る例。✅ この指定のまま、CI（`relay-docker`）でイメージを作って起動し、`relay:check` が通った。

## 4. 自分のサーバーに置くときの、最低限の対策

**公開リレーは勧めない**（悪用の責任・苦情への対応・帯域の費用・24 時間の運用が要る。選択肢の整理は ARCHITECTURE.md 5.2）。
自分と身内だけが使う、というつもりでも、アドレスが分かれば誰でも使えるので、次を満たしてから置く:

1. **専用の VM かコンテナ**で動かす。同じマシンに、他のサービスや秘密を置かない。
2. **出口のファイアウォール**で、内部への出口を塞ぐ（5 章）。リレーのフィルタだけに頼らない。
3. **TLS のリバースプロキシ**（2 章）と、`--origin` での Origin の制限。プロキシで、IP ごとの接続数・頻度を絞る。
4. ポートは既定の 80 / 443 のまま。`--ports all` や `--allow-udp` は使わない。
5. **月間の転送量の上限**（VPS の側の設定）と、**止める手順**（6 章）を、先に決める。
6. ログの扱いを決める。`INFO` のログには、クライアントの IP（プロキシの内側では、プロキシの IP）と、接続先の IP が出る。IP は個人情報になりうる。残す期間を決めて、`--log WARN` にするなど、必要以上に残さない。
7. 事業者（VPS・クラウド）の規約を確かめる。オープンプロキシを禁じる事業者が多い（🔬 一般論で、個別には未確認）。
8. **公開の前と、wisp-js の版を上げるたびに、`npm run relay:check` を実行する。**

## 5. 出口のファイアウォール 🔬

リレーのフィルタ（IPv4 の正規形だけ + wisp-js の IPv4 の範囲の拒否）は、ひとつの層でしかない。
フィルタの実装のずれ（実際に、`::ffff:` の迂回があった）に備えて、**リレーのプロセスから内部へ出られない**ようにする。
塞ぐ先: ループバック（127.0.0.0/8）、プライベート（10/8、172.16/12、192.168/16）、リンクローカル（169.254/16。クラウドのメタデータもここ）、CGNAT（100.64/10）、マルチキャスト・予約（224/4、240/4、0/8）、IPv6 のすべて（リレーは IPv4 だけで足りる）。

以下は、どれも**例。環境に合わせて直し、必ず試してから使う**（🔬）。

### nftables（Docker を使わず、専用ユーザーで動かす場合）

```nft
table inet wasmbox_relay {
	chain out {
		type filter hook output priority 0; policy accept;
		# 既存の接続の応答（リバースプロキシへの返信）は通す
		meta skuid "wasmbox-relay" ct state established,related accept
		meta skuid "wasmbox-relay" meta nfproto ipv6 drop
		meta skuid "wasmbox-relay" ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4 } drop
	}
}
```

### Docker の場合

コンテナの出口は、ホストの `DOCKER-USER` チェーン（コンテナから外・他のコンテナへ）と、`INPUT` チェーン（コンテナからホスト自身へ）で塞ぐ。
専用のネットワークを作って、そこからの通信を絞る形が分かりやすい 🔬:

```sh
docker network create --subnet 172.30.0.0/24 wasmbox-relay-net
# コンテナ（172.30.0.0/24）から、内部へ新しく出る通信を落とす。DOCKER-USER は、Docker が転送するパケットに効く
for net in 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 ; do
  sudo iptables -I DOCKER-USER -s 172.30.0.0/24 -d $net -j DROP
done
# コンテナから、ホスト自身（docker のゲートウェイ 172.30.0.1 など）へ新しく出る通信を落とす
sudo iptables -I INPUT -s 172.30.0.0/24 -j DROP
# 外から来た接続の「返事」は通す（-I は先頭に入れるので、DROP のあとに入れる）。これがないと、公開したポートが応答できない
sudo iptables -I DOCKER-USER -s 172.30.0.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
sudo iptables -I INPUT       -s 172.30.0.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
```

⚠️ `DOCKER-USER` に、これより前の `ACCEPT` があると効かない。ルールの順番を `iptables -S DOCKER-USER` で確かめる。
IPv6 は、コンテナで IPv6 を有効にしていなければ、通信自体が出ない（🔬 未確認）。`ip6tables` でも同じ形で塞げる。

### 確かめ方

`relay:check` は、ファイアウォールを確かめられない。コンテナ（または専用ユーザー）の中から、内部への接続が**失敗する**ことを直接確かめる 🔬:

```sh
docker run --rm --network wasmbox-relay-net --entrypoint sh wasmbox-relay -c '
  for t in 169.254.169.254 192.168.0.1 10.0.0.1 172.30.0.1; do
    if wget -T 3 -q -O /dev/null "http://$t/" 2>/dev/null; then echo "$t 届いた（NG）"; else echo "$t 届かない"; fi
  done'
```

⚠️ 「届かない」は、相手がいなくても出る。ファイアウォールが効いている証拠には、ならない。
**本当に確かめるには**、自分のネットワークの内側（ホストのプライベート IP など）に、見張り役の TCP サーバー（`nc -l 9999` など）を立てて、コンテナからそこへ届かないことを見る。
クラウドのメタデータ（`169.254.169.254`）は、事業者によっては、メタデータそのものを無効にする設定がある（🔬 個別には未確認）。無効にできるなら、そうする。

## 6. 止める手順（kill switch）🔬

あらかじめ、1 分以内に止められるようにしておく。

- Docker: `docker stop wasmbox-relay`（`--rm` で作っていれば、消える）
- systemd: `sudo systemctl stop wasmbox-relay`（`disable` もする）
- すぐに遮断する: プロキシを止める、ファイアウォールで 443 を閉じる、DNS のレコードを消す
- 転送量が上限に近づいたら、自動で止める仕組み（VPS の転送量の上限、監視のアラート）🔬 事業者ごとに異なる

## 7. wisp-js の版とライセンス

- リレーは、**0.5.0 で確かめている**。版を上げたら、`relay:check` と `npm test`（結合テスト）で確かめる。`relay.mjs` は、別の版が入っていると、起動時に警告を出す。
- wisp-js 0.5.0 は **LGPL-3.0-or-later**。WasmBox の依存パッケージにはせず、使うときに `npm install --no-save` で入れる（`package.json` と `package-lock.json` には入れない）。
  🔬 wisp-js の最新の README は、ライセンスを AGPL-3.0 と読める記述があった。版を上げるときは、その版の `LICENSE` と `package.json` を確認する（[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)）。
- `relay.mjs` は wisp-js の内部の API（`server.routeRequest` と `server.options`）を使っている。版が変わると、動かなくなることがある。

## 確認の状況

- ✅ **フィルタ**（実物の wisp-js 0.5.0 を動かして確認。この環境（Node 22.22）と、CI の `relay` ジョブ（npm の正式なパッケージ）の両方）:
  `test/relay.integration.test.ts` と、`relay-policy`・`relay-check-lib` の単体テストで、合わせて 48 件（1 件は wisp-js が入っていないときだけ動く）。
  内部（ループバック・IPv4 マッピング・プライベート）に置いた見張り役のサーバーに、リレー越しで届かないこと、`--unsafe-allow-private` でも IPv4 マッピングは断ること、
  ポート・UDP・Origin・パスの制限、wisp-js の既定のままでは `::ffff:127.0.0.1` が断られないこと（対照）を確かめた。
  実装をわざと壊す確認（接続先の絞り込みを外す、ポートの制限を外す、UDP を許す、ループバックを許す、Origin の確認を外す、パスの確認を外す、IPv4 の正規形に先頭が 0 の数字を許す）の 7 通りで、
  それぞれテストが落ちることを、2026-10-21 に取り直して確認した。
  この環境で使った wisp-js は、GitHub の `v0.5.0` のソースと、依存の `ws` 8.21.3・`ipaddr.js` 2.4.0 のソースを、npm を使わずに置いたもの（この環境では npm のレジストリに届かないため）。CI では npm の正式なパッケージで、同じテストを行う。
- ✅ **ゲストの通信**（CI の `tools/net-smoke.mjs`、Chromium 156 + v86 0.5 + Alpine。2026-10-21）: `npm run relay`（`--unsafe-allow-private --ports all`。UDP は既定のまま断る）越しで、
  DHCP・DNS・runner への HTTP・8 MiB の転送・インターネットの HTTP / HTTPS・`apk update` / `apk add`・Python と Node.js の HTTPS・`npm view` / `npm install` が、ne2k と virtio の両方で成功した（警告・失敗は 0 件）。
  つまり、v86 は IPv4 アドレスで接続を頼み、通常の通信に UDP は要らない。runner 上の通信先（9090 番）へ届けるために `--ports all` を付けたので、**既定の 80 / 443 だけの制限は、ゲストの通信では試していない**
  （上の通信先はどれも 80 か 443）。
- ✅ **Docker**（CI の `relay-docker` ジョブ）: 3 章の権限を絞った指定のまま、イメージを作って起動し、ホストから `relay:check` を実行して、必須の 19 項目がすべて断られた。
  経緯: 1 回目の実行は失敗した（`relay:check` が終了コード 1。実行ログは取得できず、原因は直接は見ていない）。Docker は、公開したポートの接続を、コンテナの中のリレーが起動する前から受け付けるので、
  起動の途中で `relay:check` が始まって接続が切られた、という競合と推測した。注釈を足しただけの 2 回目は成功し、起動待ちを「リレーが HTTP に答えるまで」に直した 3 回目も成功した。
  競合が原因だったことは、確かめていない。
- 🔬 **未確認**: 上の表の 🔬 の項目（TLS のリバースプロキシ越し、出口のファイアウォール、systemd）。インターネット越しの遅延、複数のユーザーの同時利用、Firefox / Safari のページからの接続、IPv6 だけのネットワーク、
  DNS の再束縛（このリレーは名前を受け付けないので、起きにくいはずだが、試していない）、wisp-js の 0.5.0 以外の版。
