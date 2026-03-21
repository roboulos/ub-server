FROM node:20-slim AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ ./src/
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/package.json ./
RUN npm install --production
COPY --from=builder /app/dist/ ./

# Routes directory for dynamic route loading
RUN mkdir -p /app/routes

EXPOSE 8080

CMD ["node", "server.js"]
