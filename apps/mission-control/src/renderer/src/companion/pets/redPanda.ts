import type { PetSprite } from './types.js';

/**
 * Red panda palette. Every char used in `grid` (except '.' transparent and 'C'
 * the mood-recolored collar) must appear here.
 *   r = rust coat (auburn)           R = deep rust (stripes, tail bands, shadow)
 *   l = cream (muzzle, ear fringe, tail bands, eyebrows)
 *   e = dark outline + belly + legs  k = nose / eye (near-black)
 *   i = inner ear (warm pink)        w = eye highlight (white)
 */
const palette = {
  r: '#d0662f',
  R: '#9c4318',
  l: '#f7e3c6',
  e: '#2a1a12',
  k: '#1a1008',
  i: '#c9836a',
  w: '#ffffff',
} satisfies Record<string, string>;

/** Authored sitting red-panda art on a 2px grid (58 wide x 64 tall). */
// biome-ignore format: pixel-art grid must stay row-aligned for readability.
const grid: readonly string[] = [
  '..........................................................',
  '......ee..........................ee......................',
  '.....elle........................elle.....................',
  '....elllle......................elllle....................',
  '....eliiile....................eliiile....................',
  '...eliiiiile..................eliiiiile...................',
  '...eliiiiile..................eliiiiile...................',
  '...elriiirle..................elriiirle...................',
  '...eelriirlee................eelriirlee...................',
  '....eelrrleeeeeeeeeeeeeeeeeeeeeelrrleee...................',
  '.....eelrreeRRRRRRRRRRRRRRRReerrleee......................',
  '......eerreRRRrrrrrrrrrrrrRRReRree........................',
  '.......eeRRrrrrrrrrrrrrrrrrrRRRee.........................',
  '......eeRrrrrrrrrrrrrrrrrrrrrrrRRee.......................',
  '.....eeRrrrrrRRRRrrrrrrRRRRrrrrrrRee......................',
  '....eeRrrrrrRRllRRrrrrRRllRRrrrrrrRee.....................',
  '....eRrrrrrRRllllRRrrRRllllRRrrrrrrRe.....................',
  '...eeRrrrrrRRllwlRRrrRRlwllRRrrrrrrrRee...................',
  '...eRrrrrrrrRRllRRrrrrRRllRRrrrrrrrrrRe...................',
  '...eRrrrrrrrrRRRRrrrrrrRRRRrrrrrrrrrrRe...................',
  '...eRrrrrrrrrrrrrrkkkkrrrrrrrrrrrrrrrRe...................',
  '...eRrrrrrrrrrrrrkkkkkkrrrrrrrrrrrrrrRe...................',
  '...eeRrrrrrrrrrrrrkkkkrrrrrrrrrrrrrrrRe...................',
  '....eRrrrrrrrrrrrrrllrrrrrrrrrrrrrrrRee...................',
  '....eeRrrrrrrrrrrrllllrrrrrrrrrrrrrRe.....................',
  '.....eeRrrrrrrrrllllllllrrrrrrrrrReee.....................',
  '......eeRRrrrrrllllllllllrrrrrrRReee......................',
  '........eeeRRRRrrrrrrrrrrRRRReeeee........................',
  '..........CCCCCCCCCCCCCCCCCCCC..................eeee......',
  '.........CCCCCCCCCCCCCCCCCCCCCC................eRRRRe.....',
  '........eeeRrrrrllllllllrrrrReee..............eRRRRRRe....',
  '.......eeRrrrrrrlllllllllrrrrrRee............eRRRRRRRe....',
  '......eeRrrrrrrrllllllllllrrrrrrRee..........errrrrrrre...',
  '.....eeRrrrrrrrrllllllllllrrrrrrrRee........ellllllllle...',
  '.....eRrrrrrrrrrllllllllllrrrrrrrrRe........errrrrrrrre...',
  '....eeRrrrrrrrrrllllllllllrrrrrrrrrRee......eRRRRRRRRRe...',
  '....eRrrrrrrrrrrlllllllllllrrrrrrrrrRe.....eRRRRRRRRRRe...',
  '....eRrrrrrrrrrrlllllllllllrrrrrrrrrRe.....errrrrrrrrre...',
  '....eRrrrrrrrrrllllllllllllrrrrrrrrrRe.....elllllllllle...',
  '....eRrrrrrrrrrllllllllllllrrrrrrrrrRe.....errrrrrrrrre...',
  '....eRrrrrrrrrllllllllllllllrrrrrrrrRrrrrrrrRRRRRRRRRe....',
  '...eeRrrrrrrrrllllllllllllllrrrrrrrrrRrrrrrrRRRRRRRRRe....',
  '...eRrrrrrrrrrllllllllllllllrrrrrrrrrrRrrrrrrrrrrrrrre....',
  '...eRrrrrrrrrlllllllllllllllrrrrrrrrrrRrrrrllllllllle.....',
  '...eRrrrrrrrrllllllllllllllllrrrrrrrrRrrrrrrrrrrrrrre.....',
  '...eRrrrrrrrllllllllllllllllllrrrrrrrRrrrrrRRRRRRRRe......',
  '...eRrrrrrrellllllllllllllllleerrrrrrRrrrrrrRRRRRRe.......',
  '...eRrrrrreelllllllllllllllleerrrrrrrRe.....errrrre.......',
  '...eRrrrrellllllllllllllllllllerrrrrrRe.....elllle........',
  '...eeRrreelllllllllllllllllllleerrrrRee......errre........',
  '....eRrreelllllllllllllllllllleerrrrRe.......eRRe.........',
  '....eRreeelllllllllllllllllllleeeerrRe.......eRRe.........',
  '....eReeeeelllllllllllllllllleeeeeeeRe........ere.........',
  '....eeeeeeeellllllllllllllllleeeeeeee.........ele.........',
  '...eeeeeeeeeellllllllllllllleeeeeeeeee.........ere........',
  '...eeeeeeeeeeeeelllllllllllleeeeeeeeeee.........e.........',
  '...eeeeeeeeeeeeeeeelllllllleeeeeeeeeeeee..................',
  '...eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee..................',
  '...eeeeee..eeeeeeeeeeeeeeeeeeeee..eeeeee..................',
  '...eeeee....eeeeeee....eeeeeee....eeeee...................',
  '....eee......eeee......eeeee......eee.....................',
  '.............eee.......eeee...............................',
  '..........................................................',
  '..........................................................',
];

export const redPanda: PetSprite = {
  kind: 'red-panda',
  name: 'Red panda',
  palette,
  grid,
  moods: {
    idle: { collar: '#9aa0a6', cells: {} },
    working: {
      collar: '#3da5d9',
      cells: {
        // left eye (open round pupil with glint)
        '13,16': 'k',
        '14,16': 'k',
        '13,17': 'w',
        '14,17': 'k',
        // right eye (open round pupil with glint)
        '23,16': 'k',
        '24,16': 'k',
        '23,17': 'w',
        '24,17': 'k',
      },
      pulse: true,
    },
    needs: {
      collar: '#f5c518',
      cells: {
        // left eye (wide attentive)
        '13,15': 'k',
        '14,15': 'k',
        '13,16': 'k',
        '14,16': 'w',
        '13,17': 'k',
        '14,17': 'k',
        // right eye (wide attentive)
        '23,15': 'k',
        '24,15': 'k',
        '23,16': 'w',
        '24,16': 'k',
        '23,17': 'k',
        '24,17': 'k',
      },
    },
    done: {
      collar: '#34c759',
      cells: {
        // left eye (happy upward squint)
        '12,17': 'k',
        '13,16': 'k',
        '14,16': 'k',
        '15,17': 'k',
        // right eye (happy upward squint)
        '22,17': 'k',
        '23,16': 'k',
        '24,16': 'k',
        '25,17': 'k',
      },
    },
    error: {
      collar: '#f87171',
      cells: {
        // left eye (wide startled pupil ringed in white)
        '13,15': 'w',
        '14,15': 'w',
        '13,16': 'k',
        '14,16': 'k',
        '13,17': 'w',
        '14,17': 'w',
        // right eye (wide startled pupil ringed in white)
        '23,15': 'w',
        '24,15': 'w',
        '23,16': 'k',
        '24,16': 'k',
        '23,17': 'w',
        '24,17': 'w',
      },
    },
  },
};
