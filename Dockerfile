# saw vault: policy, keys and ledger live on a persistent volume at /data (SAW_HOME).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY ui ./ui
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production SAW_HOME=/data PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/ui ./ui
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/saw.js", "vault", "serve", "--port", "3000"]
