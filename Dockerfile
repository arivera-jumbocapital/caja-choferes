# Caja de Choferes · Tasty Choice — imagen para Railway.
# Con Dockerfile, Railway no pasa las variables del servicio al build (solo al arrancar),
# así una variable vacía o mal escrita no puede romper la construcción.
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
