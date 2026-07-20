// Mini serveur du jeu de démo — sert uniquement à recetter le SDK en local.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.PORT || 4321);
// Le snippet est injecté tel qu'un vrai site l'aurait collé : la clé est un
// attribut data-key de la balise script, jamais un paramètre d'URL.
const key = process.env.GAMERANK_KEY || 'gr_demo_catchsquare01';
const api = process.env.GAMERANK_API || 'http://localhost:3000';
const snippet = `<script src="${api}/sdk.js" data-key="${key}" async></script>`;

http
  .createServer((req, res) => {
    const html = fs
      .readFileSync(path.join(__dirname, 'index.html'), 'utf8')
      .replace('<!--GAMERANK_SNIPPET-->', snippet);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  })
  .listen(port, () => console.log(`demo game on http://localhost:${port} (key: ${key})`));
