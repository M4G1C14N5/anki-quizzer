FROM node:20-alpine

WORKDIR /app

# Install prod deps first for better layer caching
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source
COPY server.js ./
COPY public ./public

ENV PORT=4318 \
    ANKI_URL=http://anki-desktop:8765 \
    DATA_DIR=/data

EXPOSE 4318

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://localhost:4318/api/health || exit 1

CMD ["node", "server.js"]