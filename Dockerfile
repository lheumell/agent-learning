# Image « cœur » : mode papier, tableau de bord, backtest, walk-forward, import de données.
# Elle n'installe PAS les paquets de l'agent (AgentKit, viem, SDK Anthropic) : pas de wallet,
# pas de clé, ~12 Mo de dépendances. Pour l'agent, utilisez le projet en local (npm install).
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

# Dossier de données, appartenant à l'utilisateur non privilégié « node » (uid 1000).
RUN mkdir -p /app/data && chown node:node /app/data
USER node

ENTRYPOINT ["node", "--import", "tsx", "src/index.ts"]
CMD ["--help"]
