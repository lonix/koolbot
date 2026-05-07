/**
 * Reply pools for the `/amikool` slash command.
 * One is picked at random depending on whether the caller has the
 * configured "kool" role.
 */

export const koolResponses = [
  "Yes, you are kool! 😎",
  "Absolutely kool! 🌟",
  "You're the koolest! 🎸",
  "Kool status: Confirmed! ✅",
  "100% kool certified! 🏆",
  "Kool as ice! ❄️",
  "Much kool, Such wow! 👑",
  "Kool vibes detected! 🎵",
  "Maximum koolness achieved! 🚀",
  "Kool level: Legendary! 🏅",
] as const;

export const notKoolResponses = [
  "No, you are not kool... yet! 😢",
  "Kool status: Pending... ⏳",
  "Not quite kool enough... 🥺",
  "Koolness level: Needs improvement 📈",
  "Almost kool, but not quite! 🎯",
  "Kool potential detected! 💫",
  "Koolness in progress... 🔄",
  "Future kool kid! 🌱",
  "Kool training required! 🎓",
  "Koolness upgrade available! 💎",
] as const;
