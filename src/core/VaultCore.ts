export interface VaultEntry {
  iv: string;
  data: string;
  label?: string;
}

export interface VaultSchema {
  version: "2.1";
  salt: string;
  iterations: number;
  password_wrapped: string;
  verification_iv: string;
  verification_data: string;
  secrets: Record<string, VaultEntry>;
}

export class VaultCore {
  private runtimeKey: Uint8Array | null = null;
  private schema: VaultSchema | null = null;
  private vaultPath: string;
  private ALGO = "AES-GCM";

  constructor(private app: any) {
    this.vaultPath = `${this.app.vault.configDir}/plugins/markdown-password/vault.json`;
  }

  // --- Crypto Logic ---

  async deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const keyMaterial = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]
    );
    return await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
      keyMaterial, { name: this.ALGO, length: 256 }, true, ["encrypt", "decrypt"]
    );
  }

  async encrypt(text: string, key: Uint8Array): Promise<{iv: string, data: string}> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await crypto.subtle.importKey("raw", key, this.ALGO, false, ["encrypt"]);
    const encrypted = await crypto.subtle.encrypt({ name: this.ALGO, iv }, cryptoKey, new TextEncoder().encode(text));
    return {
      iv: btoa(String.fromCharCode(...iv)),
      data: btoa(String.fromCharCode(...new Uint8Array(encrypted)))
    };
  }

  async decrypt(ivStr: string, dataStr: string, key: Uint8Array): Promise<string> {
    const iv = new Uint8Array(atob(ivStr).split("").map(c => c.charCodeAt(0)));
    const data = new Uint8Array(atob(dataStr).split("").map(c => c.charCodeAt(0)));
    const cryptoKey = await crypto.subtle.importKey("raw", key, this.ALGO, false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt({ name: this.ALGO, iv }, cryptoKey, data);
    return new TextDecoder().decode(decrypted);
  }

  // --- Vault Operations ---

  async unlock(password: string): Promise<boolean> {
    try {
      if (!(await this.app.vault.adapter.exists(this.vaultPath))) {
        await this.createVault(password);
        return true;
      }

      const content = await this.app.vault.adapter.read(this.vaultPath);
      this.schema = JSON.parse(content);
      if (!this.schema) return false;

      const salt = new Uint8Array(atob(this.schema.salt).split("").map(c => c.charCodeAt(0)));
      const pKey = await this.deriveKey(password, salt);
      const pKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pKey));

      const wrapped = new Uint8Array(atob(this.schema.password_wrapped).split("").map(c => c.charCodeAt(0)));
      const vaultKey = await this.decrypt(
        btoa(String.fromCharCode(...wrapped.slice(0, 12))),
        btoa(String.fromCharCode(...wrapped.slice(12))),
        pKeyBytes
      );

      this.runtimeKey = new Uint8Array(vaultKey.split("").map(c => c.charCodeAt(0)));
      
      // Verify
      const check = await this.decrypt(this.schema.verification_iv, this.schema.verification_data, this.runtimeKey);
      if (check === "VERIFIED") return true;
    } catch (e) {
      console.error("Unlock failed", e);
    }
    this.lock();
    return false;
  }

  private async createVault(password: string) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const vaultKey = crypto.getRandomValues(new Uint8Array(32));
    const pKey = await this.deriveKey(password, salt);
    const pKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pKey));

    const wrapped = await this.encrypt(String.fromCharCode(...vaultKey), pKeyBytes);
    const verify = await this.encrypt("VERIFIED", vaultKey);

    this.schema = {
      version: "2.1",
      salt: btoa(String.fromCharCode(...salt)),
      iterations: 100000,
      password_wrapped: wrapped.iv + wrapped.data, // Simplified wrapping
      verification_iv: verify.iv,
      verification_data: verify.data,
      secrets: {}
    };

    this.runtimeKey = vaultKey;
    await this.save();
  }

  async save() {
    if (!this.schema) return;
    const dir = this.vaultPath.substring(0, this.vaultPath.lastIndexOf("/"));
    if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
    await this.app.vault.adapter.write(this.vaultPath, JSON.stringify(this.schema, null, 2));
  }

  lock() {
    this.runtimeKey = null;
    this.schema = null;
  }

  isUnlocked() { return !!this.runtimeKey; }
  async exists() { return await this.app.vault.adapter.exists(this.vaultPath); }

  async addSecret(text: string): Promise<string> {
    if (!this.runtimeKey || !this.schema) throw new Error("Locked");
    const id = "v_" + Math.random().toString(36).substring(2, 9);
    const encrypted = await this.encrypt(text, this.runtimeKey);
    this.schema.secrets[id] = { iv: encrypted.iv, data: encrypted.data };
    await this.save();
    return id;
  }

  async getSecret(id: string): Promise<string> {
    if (!this.runtimeKey || !this.schema) throw new Error("Locked");
    const entry = this.schema.secrets[id];
    if (!entry) throw new Error("Not found");
    return await this.decrypt(entry.iv, entry.data, this.runtimeKey);
  }

  async reset() {
    this.lock();
    if (await this.exists()) await this.app.vault.adapter.remove(this.vaultPath);
  }
}
