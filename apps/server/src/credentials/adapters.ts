export type CredentialProvider = "openrouter" | "polza" | "replicate" | string;

export interface CredentialAdapter {
  getCredential(provider: CredentialProvider, ref?: string): Promise<string | null>;
  saveCredential(provider: CredentialProvider, ref: string, secret: string): Promise<void>;
  deleteCredential(provider: CredentialProvider, ref: string): Promise<void>;
  listCredentials(): Promise<Array<{ provider: string; ref: string; mode: "server-owned" | "user-session" | "local" }>>;
}

export class ServerOwnedCredentialAdapter implements CredentialAdapter {
  async getCredential(provider: CredentialProvider): Promise<string | null> {
    return serverOwnedCredential(provider);
  }

  async saveCredential(): Promise<void> {
    throw new Error("Server-owned credentials are configured through environment variables.");
  }

  async deleteCredential(): Promise<void> {
    throw new Error("Server-owned credentials are configured through environment variables.");
  }

  async listCredentials() {
    return ["openrouter", "polza", "replicate"]
      .filter((provider) => Boolean(serverOwnedCredential(provider)))
      .map((provider) => ({ provider, ref: "default", mode: "server-owned" as const }));
  }
}

export class UserSessionCredentialAdapter implements CredentialAdapter {
  private credentials = new Map<string, string>();

  constructor(initial?: Record<string, Record<string, string> | string>) {
    for (const [provider, value] of Object.entries(initial ?? {})) {
      if (typeof value === "string") this.credentials.set(key(provider, "default"), value);
      else for (const [ref, secret] of Object.entries(value)) this.credentials.set(key(provider, ref), secret);
    }
  }

  async getCredential(provider: CredentialProvider, ref = "default"): Promise<string | null> {
    return this.credentials.get(key(provider, ref)) ?? this.credentials.get(key(provider, "default")) ?? null;
  }

  async saveCredential(provider: CredentialProvider, ref: string, secret: string): Promise<void> {
    this.credentials.set(key(provider, ref), secret);
  }

  async deleteCredential(provider: CredentialProvider, ref: string): Promise<void> {
    this.credentials.delete(key(provider, ref));
  }

  async listCredentials() {
    return [...this.credentials.keys()].map((entry) => {
      const [provider, ref] = entry.split(":");
      return { provider, ref, mode: "user-session" as const };
    });
  }
}

export class NoopCredentialAdapter implements CredentialAdapter {
  async getCredential(): Promise<string | null> {
    return null;
  }

  async saveCredential(): Promise<void> {}

  async deleteCredential(): Promise<void> {}

  async listCredentials() {
    return [];
  }
}

export function envKeyForProvider(provider: string): string | null {
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  if (provider === "polza") return "POLZA_AI_API_KEY";
  if (provider === "replicate") return "REPLICATE_API_TOKEN";
  return null;
}

export function serverOwnedCredential(provider: string): string | null {
  if (provider === "openrouter") return process.env.OPENROUTER_API_KEY?.trim() || null;
  if (provider === "polza") return process.env.POLZA_API_KEY?.trim() || process.env.POLZA_AI_API_KEY?.trim() || null;
  if (provider === "replicate") return process.env.REPLICATE_API_KEY?.trim() || process.env.REPLICATE_API_TOKEN?.trim() || null;
  return null;
}

function key(provider: string, ref: string): string {
  return `${provider}:${ref || "default"}`;
}
