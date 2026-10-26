function cleanGameTitle(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export function createOutreachMessage(prospect) {
  const gameTitle = cleanGameTitle(prospect.gameTitle) || 'your browser game';
  return {
    subject: `Add ${gameTitle} to WebGameRank?`,
    body: `Hi,

I discovered ${gameTitle} through r/playmygame.

I’m building WebGameRank, a platform that helps players discover and rank browser games using 9 quality signals, including playtime, community votes, and repeat visits.

Games can add a lightweight integration snippet that measures real player engagement, so rankings reflect actual usage as well as community votes.

I’d like to invite you to add your game:
https://webgamerank.com/

This is a one-time message. If you’re not interested, no action is needed and I won’t contact you again.

Best,
Anthony Gosme
Creator of WebGameRank`,
  };
}
