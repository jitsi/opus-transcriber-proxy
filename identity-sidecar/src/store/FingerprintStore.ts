export interface Fingerprint {
  identity: string;
  vector: Float32Array;
  name?: string;
}

export interface FingerprintStore {
  upsert(tenant: string, identity: string, vector: Float32Array, name?: string): Promise<void>;
  query(tenant: string): Promise<Fingerprint[]>;
  delete(identity: string): Promise<void>;
}
