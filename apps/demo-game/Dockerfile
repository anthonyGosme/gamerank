# Serveur demo-game : mock local de « sites externes » embarquant le SDK.
# Sert les pages jouables http://localhost:4600/<slug> des jeux de démo.
# Pur Node (aucune dépendance) → image minimale.
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=4600
EXPOSE 4600
CMD ["node", "server.js"]
