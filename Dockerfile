# Cloud Run / any container host. Node >= 23.6 runs .ts directly (type stripping), no build step.
FROM node:26-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV HOST=0.0.0.0 PORT=8080 TZ=Asia/Ho_Chi_Minh
# Required at runtime: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, MCP_AUTH_TOKEN
CMD ["node", "src/server.ts", "--http"]
