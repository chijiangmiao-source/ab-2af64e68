FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY test ./test
COPY scripts ./scripts

EXPOSE 8080
CMD ["node", "src/server.js"]
