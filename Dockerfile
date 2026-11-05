# Image « cœur » : mode papier, tableau de bord, backtest, walk-forward, import de données.
# Elle n'installe PAS les paquets de l'agent (AgentKit, viem, SDK Anthropic) : pas de wallet,
# pas de clé, quelques Mo de dépendances. Pour l'agent, utilisez le projet en local.
#
# Les dépendances viennent de docker/package.json + docker/package-lock.json (tsx et dotenv),
# PAS du package-lock.json principal : un « npm install » local avec un autre npm réécrit ce dernier
# d'une façon que le npm de l'image refuse. Le verrou de l'image, lui, n'est jamais régénéré par accident.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY docker/package.json docker/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

# Dossier de données, appartenant à l'utilisateur non privilégié « node » (uid 1000).
RUN mkdir -p /app/data && chown node:node /app/data
USER node

ENTRYPOINT ["node", "--import", "tsx", "src/index.ts"]
CMD ["--help"]
