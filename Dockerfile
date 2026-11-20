# The hosted demo as one image:  docker build -t given .  &&  docker run -p 8080:8080 --env-file .env.deploy -v given-data:/data given
# What to set, and how to start, is in docs/DEPLOY.md.
FROM node:24-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# The built app talks to the executor and chain service on its own address, so it is built in "live" mode.
RUN VITE_API_MODE=live npm run build

FROM node:24-slim
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 GIVEN_DATA_ROOT=/data GIVEN_EDGE_TRUST_PROXY=1
WORKDIR /app
COPY executor/package.json executor/package-lock.json executor/
COPY chain/package.json chain/package-lock.json chain/
RUN npm --prefix executor ci --omit=dev && npm --prefix chain ci --omit=dev
# executor/test/serve-fake.ts (staging mode) imports the test exchange, so the executor tests' helper folder ships too.
COPY executor/src executor/src
COPY executor/test/fake.ts executor/test/serve-fake.ts executor/test/
COPY executor/tsconfig.json executor/
COPY chain/src chain/src
COPY chain/tsconfig.json chain/
COPY scripts/serve.mjs scripts/
COPY scripts/lib scripts/lib
COPY --from=web /app/web/dist web/dist
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "scripts/serve.mjs"]
