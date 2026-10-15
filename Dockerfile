# Includes the hidden browser the connector uses to draw each book.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server.js"]
