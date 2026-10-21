# WasmBox 用の WISP リレー（tools/relay.mjs）を、コンテナで動かす。
# ビルド（リポジトリのルートで）:  docker build -f tools/relay/Dockerfile -t wasmbox-relay .
# 実行（手元だけに公開する例）:    docker run --rm -p 127.0.0.1:5001:5001 wasmbox-relay --origin http://localhost:8080
# 公開するときの注意（出口のファイアウォール、TLS のリバースプロキシ）は docs/relay.md。
#
# node:22 は、TypeScript をそのまま実行できる版（22.18 以上）であること。
FROM node:22-alpine

WORKDIR /app
COPY tools/relay.mjs tools/relay-policy.ts ./tools/

# wisp-js は WasmBox の依存パッケージではない。この版（0.5.0）で確かめている。LGPL-3.0-or-later（THIRD_PARTY_NOTICES.md）
RUN npm install --no-save --package-lock=false --omit=dev --no-audit --no-fund @mercuryworkshop/wisp-js@0.5.0 \
 && node --version

# 非 root で動かす（node イメージの node ユーザー）
USER node
EXPOSE 5001

# コンテナの中では、全アドレスで待ち受ける。外への公開は、docker run の -p（127.0.0.1:5001:5001 のように、公開するアドレスを限る）で決める
ENTRYPOINT ["node", "tools/relay.mjs", "--host", "0.0.0.0"]
