export * as schema from "./schema.js";
export { createDb, MissingDatabaseUrlError, type Database } from "./client.js";
export {
  encryptSecret,
  decryptSecret,
  LocalKeyInProductionError,
  KmsUnavailableError,
  setKmsClient,
  type KmsClientLike,
  MissingLocalKekError,
  CiphertextFormatError,
  type SecretContext,
} from "./crypto.js";
export { hashVirtualKey, issueVirtualKey, isVirtualKeyShape, type IssuedVirtualKey } from "./keys.js";
export { ensureUsagePartitions } from "./partitions.js";
export { CATALOG, type CatalogPrice } from "./catalog.js";

export { applyRetention, deleteUserData, exportUserData, UnknownUserError, AUDIT_MIN_RETENTION_DAYS, type RetentionReport } from "./privacy.js";
export { syncCatalog } from "./catalog-sync.js";
