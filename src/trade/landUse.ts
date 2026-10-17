import type { PortProfile } from './economy';

/**
 * A port's profile with each good's terrain feature area scaled by the world's land use for that good
 * (ormosLayout HarborPlan.landUse; a missing good keeps its scale of 1). Returns a copy; the input is not changed.
 */
export function landUseProfile(profile: PortProfile, landUse?: Partial<Record<string, number>>): PortProfile {
  const features = { ...profile.features };
  for (const id of Object.keys(features) as (keyof PortProfile['features'])[]) {
    features[id] = features[id] * (landUse?.[id] ?? 1);
  }
  return { ...profile, features };
}
