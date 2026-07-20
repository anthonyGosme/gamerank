// Une seule catégorie par jeu (décision produit). La liste est volontairement
// courte : des pages de catégorie fournies valent mieux que 40 pages vides.
export const CATEGORIES = [
  'action',
  'puzzle',
  'arcade',
  'strategy',
  'sports',
  'racing',
  'rpg',
  'idle-clicker',
  'card-board',
  'shooter',
  'platformer',
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

export function categoryLabel(category: string): string {
  return category
    .split('-')
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' & ');
}
