import { GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config.js';

export type BucketName = 'avatars' | 'imports' | 'exports';
export const PRESIGN_TTL_SECONDS = 15 * 60;

export interface Storage {
  /** The content type is signed: the upload must send exactly this Content-Type. */
  presignPut(bucket: BucketName, key: string, contentType: string): Promise<string>;
  presignGet(bucket: BucketName, key: string, downloadName?: string): Promise<string>;
  ping(): Promise<void>;
}

type StorageConfig = Pick<
  Config,
  'S3_ENDPOINT' | 'S3_PUBLIC_ENDPOINT' | 'S3_REGION' | 'S3_ACCESS_KEY' | 'S3_SECRET_KEY' | 'S3_BUCKET_AVATARS' | 'S3_BUCKET_IMPORTS' | 'S3_BUCKET_EXPORTS'
>;

/**
 * S3-compatible storage (MinIO locally, GCS via its S3 interoperability API later).
 * Two clients: `internal` talks to the storage over the private network,
 * `publicClient` only SIGNS URLs that the browser will use via the gateway.
 */
export class S3Storage implements Storage {
  private readonly internal: S3Client;
  private readonly publicClient: S3Client;
  private readonly buckets: Record<BucketName, string>;

  constructor(config: StorageConfig) {
    const common = {
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
      // Newer SDKs add CRC32 checksums to presigned PUTs by default; browsers cannot satisfy them.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.internal = new S3Client({ ...common, endpoint: config.S3_ENDPOINT });
    this.publicClient = new S3Client({ ...common, endpoint: config.S3_PUBLIC_ENDPOINT });
    this.buckets = { avatars: config.S3_BUCKET_AVATARS, imports: config.S3_BUCKET_IMPORTS, exports: config.S3_BUCKET_EXPORTS };
  }

  presignPut(bucket: BucketName, key: string, contentType: string): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new PutObjectCommand({ Bucket: this.buckets[bucket], Key: key, ContentType: contentType }),
      // Keep content-type as a signed header (not a query param) so storage enforces it.
      { expiresIn: PRESIGN_TTL_SECONDS, signableHeaders: new Set(['content-type']) },
    );
  }

  presignGet(bucket: BucketName, key: string, downloadName?: string): Promise<string> {
    const disposition = downloadName ? `attachment; filename="${downloadName.replace(/"/g, '')}"` : undefined;
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({ Bucket: this.buckets[bucket], Key: key, ResponseContentDisposition: disposition }),
      { expiresIn: PRESIGN_TTL_SECONDS },
    );
  }

  async ping(): Promise<void> {
    await this.internal.send(new HeadBucketCommand({ Bucket: this.buckets.avatars }));
  }
}
