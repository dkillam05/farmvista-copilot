# Use a slim Node.js runtime
FROM node:22-slim

# Cloud Run expects your app to listen on $PORT (defaults to 8080)
ENV NODE_ENV=production

# Create and use a working directory inside the container
WORKDIR /app

# Copy only package files first (better build caching)
COPY package*.json ./

# Install prod dependencies
RUN npm install --omit=dev

# Copy the rest of your source code
COPY . .

# Optional (recommended): run as non-root user for security
USER node

# Expose the port (informational; Cloud Run uses $PORT)
EXPOSE 8080

# Start the server
CMD ["node", "index.js"]