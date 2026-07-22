import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../storage/atomic-json.js";

export interface TokenState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  deviceId: string;
  userId: string;
}

export class TokenStore {
  private readonly path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, "token.json");
  }
  read(): Promise<TokenState | null> {
    return readJson<TokenState>(this.path);
  }
  write(state: TokenState): Promise<void> {
    return writeJsonAtomic(this.path, state, 0o600);
  }
}
