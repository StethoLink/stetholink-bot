import type { ProviderDescriptor } from "@/shared/contracts";
import type { ProviderRegistry } from "./ports";

/** A directory filtered by the tenant's allowlist. Unlisted or inactive providers do not exist for the tenant. */
export function createProviderRegistry(directory: readonly ProviderDescriptor[], allowedIds: ReadonlySet<string>): ProviderRegistry {
  return {
    async list() {
      return directory.filter((provider) => provider.active && allowedIds.has(provider.id)).map((provider) => ({ ...provider, specialties: [...provider.specialties] }));
    },
  };
}

const normalize = (value: string) => value.trim().toLowerCase();

/** Eligible means allowed for the tenant, active and offering the requested specialty. */
export function eligibleProviders(providers: readonly ProviderDescriptor[], specialty: string | null | undefined) {
  if (!specialty?.trim()) return [];
  return providers.filter((provider) => provider.active && provider.specialties.some((offered) => normalize(offered) === normalize(specialty)));
}
