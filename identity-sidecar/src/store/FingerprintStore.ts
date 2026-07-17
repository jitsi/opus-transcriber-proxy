export interface FingerprintStore {
  upsert(tenant: string, identity: string, vector: Float32Array): Promise<void>;
  query(tenant: string): Promise<{ identity: string; vector: Float32Array }[]>;
  delete(identity: string): Promise<void>;
}
