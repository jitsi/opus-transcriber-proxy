export interface Fingerprint {
  identity: string;
  vector: Float32Array;
  name?: string;
}

export interface FingerprintStore {
  upsert(tenant: string, identity: string, vector: Float32Array, name?: string): Promise<void>;
  /** Candidate fingerprints for matching. `probe` lets an ANN-backed store (Vectorize) return the
   *  nearest; stores that hold everything in memory ignore it and return all for the tenant. */
  query(tenant: string, probe?: Float32Array): Promise<Fingerprint[]>;
  delete(identity: string): Promise<void>;
}
