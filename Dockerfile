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

# ---- Copy ONLY what v2 needs ----
COPY src ./src
COPY context ./context

ENV PORT=8080
EXPOSE 8080

# Must point to src/server.js via package.json "start"
CMD ["npm", "start"]
