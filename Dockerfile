# Image de l'API WebGameRank (homol/prod).
#
# On PRÉSERVE la structure monorepo dans l'image : le serveur sert /sdk.js via
# un chemin relatif `../../packages/sdk/dist` et migrate lit `../migrations`,
# donc l'app doit tourner en WORKDIR /app/apps/api avec packages/ à côté.
#
# Les devDeps (tsx, esbuild, typescript) sont conservées : elles servent au
# build ET au seed (scripts/seed-demo.ts, lancé via tsx dans le conteneur).

FROM node:22-alpine
WORKDIR /app

# 1) Manifests d'abord → cache la couche des dépendances tant qu'ils ne changent pas
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/demo-game/package.json apps/demo-game/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN npm ci

# 2) Sources + build (SDK esbuild + API tsc)
COPY . .
RUN npm run build:sdk && npm run build -w apps/api

ENV NODE_ENV=production
WORKDIR /app/apps/api
EXPOSE 3000

# migrations et seed sont pilotés par run.sh (docker compose run/exec) ;
# le conteneur, lui, se contente de servir l'API.
CMD ["node", "dist/server.js"]
