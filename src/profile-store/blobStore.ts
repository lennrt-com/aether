export interface BlobStore {
  put(data: Buffer): Promise<{ ref: string }>;
  getUrl(ref: string): Promise<string>;
  del(ref: string): Promise<void>;
}
