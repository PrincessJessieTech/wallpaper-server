FROM node:20-alpine

# Install git and openssh-client for git push over SSH
RUN apk add --no-cache git openssh-client

WORKDIR /app

# Install dependencies (no lockfile required)
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/

CMD ["node", "src/index.js"]
