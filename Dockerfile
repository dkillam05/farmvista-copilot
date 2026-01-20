FROM node:20-slim

# ---- System deps for native modules (better-sqlite3) ----
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    sqlite3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- Install deps first (better caching) ----
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# ---- Copy only what v2 needs (no legacy fallbacks) ----
COPY src ./src
COPY context ./context

ENV PORT=8080
EXPOSE 8080

# Uses package.json "start" which MUST point to src/server.js
CMD ["npm", "start"]
