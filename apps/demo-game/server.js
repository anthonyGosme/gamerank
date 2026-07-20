// Mini serveur du jeu de démo — sert uniquement à recetter le SDK en local.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.PORT || 4600);
// Le snippet est injecté tel qu'un vrai site l'aurait collé : la clé est un
// attribut data-key de la balise script, jamais un paramètre d'URL.
const key = process.env.GAMERANK_KEY || 'gr_-ThU6SnMPDksAWIyc8psiM6V';
const api = process.env.GAMERANK_API || 'http://localhost:3000';
const gameId = process.env.GAMERANK_GAME_ID || '425fb507-3594-41de-bb30-3fdcc14988e1';
const snippet = `<script src="${api}/sdk.js" data-key="${key}" async></script>
<div style="position:relative;display:inline-block;width:180px;height:40px">
  <script src="${api}/widget.js" data-key="${key}" async></script>
  <a href="${api}/g/${gameId}"><img src="${api}/games/${gameId}/badge.svg" width="180" height="40" alt="catch the sqaure V2 on GameRank"></a>
</div>`;

http
  .createServer((req, res) => {
    const html = fs
      .readFileSync(path.join(__dirname, 'index.html'), 'utf8')
      .replace('<!--GAMERANK_SNIPPET-->', snippet);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  })
  .listen(port, () => console.log(`demo game on http://localhost:${port} (key: ${key})`));
