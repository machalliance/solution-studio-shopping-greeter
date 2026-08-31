FROM node:22-slim

# Bump npm's own bundled CLI before installing anything — the base image ships whatever npm
# version it was built with, which drags along its own vendored deps (tar, pacote, sigstore,
# etc.) that show up as CVEs in image scans despite never being part of this app's dependency
# tree. Doing this first, not last, keeps the fix isolated from app-level dependency changes.
RUN npm install -g npm@latest && npm cache clean --force

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .
RUN npm run build

ENV PORT=3003
EXPOSE 3003

CMD ["npm", "start"]
