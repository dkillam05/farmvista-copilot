# Dockerfile (FULL FILE)
FROM node:20-slim

# Create app directory
WORKDIR /app

# Install dependencies first (better caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy source
COPY . .

# Cloud Run listens on $PORT
ENV PORT=8080
EXPOSE 8080

# Start
CMD ["npm", "start"]
