FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --omit=optional
COPY src ./src
COPY migrations ./migrations
COPY web ./web

CMD ["npm", "run", "dev:api"]
