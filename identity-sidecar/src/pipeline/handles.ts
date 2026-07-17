const ADJECTIVES = [
  'Purple', 'Amber', 'Crimson', 'Teal', 'Golden', 'Silver', 'Jade', 'Coral',
  'Indigo', 'Scarlet', 'Olive', 'Cobalt', 'Maroon', 'Ivory', 'Bronze', 'Violet',
];
const ANIMALS = [
  'Otter', 'Falcon', 'Badger', 'Heron', 'Lynx', 'Marten', 'Osprey', 'Wombat',
  'Ferret', 'Puffin', 'Stoat', 'Gecko', 'Raven', 'Tapir', 'Ibex', 'Civet',
];

/**
 * Deterministic friendly handle for a session-local speaker index.
 * Same index -> same handle across calls and restarts (no randomness).
 */
export function handleForIndex(i: number): string {
  const adj = ADJECTIVES[i % ADJECTIVES.length];
  const animal = ANIMALS[Math.floor(i / ADJECTIVES.length) % ANIMALS.length];
  return `${adj} ${animal}`;
}
