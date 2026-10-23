/** Poseidon-inspired trident crown and broad leaf shoulders, normalized to full blade width/length. */
export const ROYAL_OAR_PROFILE = [
  [-.08,-.5],[.08,-.5],[.36,-.30],[.5,.16],[.46,.46],[.27,.24],[.15,.20],
  [0,.5],[-.15,.20],[-.27,.24],[-.46,.46],[-.5,.16],[-.36,-.30],
] as const;
export const ROYAL_OAR_AREA = Math.abs(ROYAL_OAR_PROFILE.reduce((sum,p,i) => {
  const next=ROYAL_OAR_PROFILE[(i+1)%ROYAL_OAR_PROFILE.length];return sum+p[0]*next[1]-next[0]*p[1];
},0))/2;
