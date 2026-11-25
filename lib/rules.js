// The Bureau's rulebook. Everything that decides what a score *means* lives here,
// so the handbook page, the API and the UI all read from one source of truth.

export const START_SCORE = 1000;
export const MIN_SCORE = 0;
export const MAX_SCORE = 2000;
export const CREATOR_SCORE = 9999; // displayed as ∞
export const SAME_TARGET_COOLDOWN_MIN = 30;
export const NO_BIOMETRICS_PENALTY = -50;
export const REEDUCATION_REWARD = 40;
export const REEDUCATION_COOLDOWN_H = 12;
export const FRATERNIZATION_FEE = -5; // praising a Persona Non Grata
export const ENVY_TAX = -5; // criticising an Exemplary Citizen
export const LOYALTY_DIVIDEND = 5; // praising The Creator
export const REFLECTION_MULTIPLIER = 2; // criticising The Creator

export const TIERS = [
  {
    id: 'AAA', min: 1300, name: 'Exemplary Citizen', color: '#b8892b',
    weight: 2, dailyVotes: 30, canCriticise: true,
    perks: ['Your ratings count double', '30 ratings per day', 'A gold seal beside your name', 'Envy tax protects you: critics pay 5 credits'],
    penalties: [],
  },
  {
    id: 'AA', min: 1150, name: 'Model Citizen', color: '#2f8f6b',
    weight: 1.5, dailyVotes: 20, canCriticise: true,
    perks: ['Your ratings count 1.5×', '20 ratings per day'],
    penalties: [],
  },
  {
    id: 'A', min: 1000, name: 'Citizen in Good Standing', color: '#3a6fd0',
    weight: 1, dailyVotes: 12, canCriticise: true,
    perks: ['Standard rating weight', '12 ratings per day'],
    penalties: [],
  },
  {
    id: 'B', min: 850, name: 'Under Observation', color: '#c9821b',
    weight: 0.75, dailyVotes: 8, canCriticise: true,
    perks: ['Re-education available'],
    penalties: ['Ratings count 0.75×', '8 ratings per day', 'A small eye now follows you around the site'],
  },
  {
    id: 'C', min: 600, name: 'Cause for Concern', color: '#7d7d85',
    weight: 0.5, dailyVotes: 5, canCriticise: true,
    perks: ['Re-education available'],
    penalties: ['Ratings count 0.5×', '5 ratings per day', 'Your portrait fades toward grayscale', 'The site is drained of colour', 'Bandwidth is "reallocated" to better citizens (pages load slower)'],
  },
  {
    id: 'D', min: MIN_SCORE, name: 'Persona Non Grata', color: '#c0392b',
    weight: 0.25, dailyVotes: 3, canCriticise: false,
    perks: ['Re-education available'],
    penalties: ['Ratings count 0.25×', '3 ratings per day', 'You may only praise, never criticise', 'Anyone who praises you pays a fraternization fee', 'Your portrait is shown in grayscale', 'The site is set in Comic Sans'],
  },
];

export const CREATOR_TIER = {
  id: 'CREATOR', name: 'The Creator', color: '#c8a24a',
  weight: 3, dailyVotes: Infinity, canCriticise: true,
  perks: ['Score fixed at ∞', 'Criticism is reflected back onto the critic at 2×', 'Praise earns the praiser a loyalty dividend', 'Divine rating weight (3×)', 'May issue decrees and grant amnesty'],
  penalties: [],
};

export function tierFor(user) {
  if (user.isCreator) return CREATOR_TIER;
  return TIERS.find((t) => user.score >= t.min) || TIERS[TIERS.length - 1];
}

export function publicTier(t) {
  return { id: t.id, name: t.name, color: t.color, weight: t.weight, dailyVotes: Number.isFinite(t.dailyVotes) ? t.dailyVotes : null, canCriticise: t.canCriticise };
}

export function clampScore(s) {
  return Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(s)));
}

// Preset merits and infractions. No free text: the Bureau speaks for you.
export const REASONS = [
  { id: 'door', label: 'Held the door', delta: 10, emoji: '🚪' },
  { id: 'cart', label: 'Returned the shopping cart', delta: 15, emoji: '🛒' },
  { id: 'snacks', label: 'Brought snacks', delta: 20, emoji: '🥐' },
  { id: 'birthday', label: 'Remembered my birthday', delta: 25, emoji: '🎂' },
  { id: 'reply', label: 'Replied within five minutes', delta: 10, emoji: '⚡' },
  { id: 'joke', label: 'Laughed at my joke', delta: 15, emoji: '😄' },
  { id: 'charger', label: 'Lent me a charger', delta: 20, emoji: '🔌' },
  { id: 'playlist', label: 'Impeccable playlist', delta: 15, emoji: '🎧' },
  { id: 'restaurant', label: 'Picked a great restaurant', delta: 15, emoji: '🍝' },

  { id: 'replyall', label: 'Hit reply-all', delta: -15, emoji: '📧' },
  { id: 'onread', label: 'Left me on read', delta: -10, emoji: '👀' },
  { id: 'movie', label: 'Talked during the movie', delta: -20, emoji: '🎬' },
  { id: 'lastslice', label: 'Took the last slice', delta: -20, emoji: '🍕' },
  { id: 'spoiler', label: 'Spoiled the finale', delta: -30, emoji: '📺' },
  { id: 'late', label: 'Late. Again.', delta: -10, emoji: '⏰' },
  { id: 'fish', label: 'Microwaved fish at the office', delta: -25, emoji: '🐟' },
  { id: 'escalator', label: 'Stood on the left of the escalator', delta: -15, emoji: '🛗' },
  { id: 'crypto', label: 'Unsolicited crypto advice', delta: -20, emoji: '🪙' },
];

export const reasonById = Object.fromEntries(REASONS.map((r) => [r.id, r]));

// Re-education. Correct answers stay on the server.
export const QUIZ = [
  { id: 'q1', q: 'Who holds the highest credit score in the land?', options: ['The Creator', 'Me, obviously', 'Credit scores are a social construct', 'My mum'], correct: 0 },
  { id: 'q2', q: "The Bureau's rating algorithm is best described as:", options: ['Questionable', 'Flawless', 'Fair, mostly', 'A spreadsheet with ambitions'], correct: 1 },
  { id: 'q3', q: 'Your score has dropped. The correct response is to:', options: ['Blame the algorithm', 'Start a petition', 'Reflect quietly on my choices', 'Move to another country'], correct: 2 },
  { id: 'q4', q: "Complete the Bureau's motto: “Rate others as…”", options: ['…loudly as possible', '…rarely as possible', '…you would wish to be rated', '…my mood dictates'], correct: 2 },
  { id: 'q5', q: 'A friend has fallen to Persona Non Grata. You:', options: ['Gently recommend re-education', 'Hang out anyway', 'Write to the Creator in protest', 'Pretend not to know them'], correct: 0 },
  { id: 'q6', q: 'Which of the following is an infraction?', options: ['Hitting reply-all', 'Standing on the left of the escalator', 'Microwaving fish at the office', 'All of the above'], correct: 3 },
  { id: 'q7', q: 'The Creator criticised you. This means:', options: ['The Creator was wrong', 'I have been given a gift', 'I should appeal', 'Nothing, I will ignore it'], correct: 1 },
  { id: 'q8', q: 'How many credits does it cost to doubt the Bureau?', options: ['None', 'Doubt is free', 'I would never doubt the Bureau', 'Fifty'], correct: 2 },
];

export const BUREAU_LINES = {
  positive: [
    'Merit recorded. The Bureau smiles upon you both.',
    'Commendation filed in triplicate.',
    'Positivity detected. Carry on.',
    'Your generosity has been noted, and will be remembered.',
  ],
  negative: [
    'Infraction recorded. Thank you for your vigilance.',
    'Report filed. Society is safer already.',
    'The Bureau thanks you for your service.',
    'Noted. Someone will be thinking about this tonight.',
  ],
};
